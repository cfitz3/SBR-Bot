import assert from "node:assert/strict";
import { test } from "node:test";
import { blendEstimate, ingestEndedAuctions, median, refreshBazaar, refreshResources, sweepAuctions, type AuctionLike, type BinWrite, type CachedPriceWrite, type SaleStats } from "./market.js";

test("the estimate is the cheaper of the two ways to buy", () => {
  assert.equal(blendEstimate(1_500, 1_400), 1_400);
  assert.equal(blendEstimate(1_300, 1_400), 1_300);
});

test("a one-sided market still yields the side we know", () => {
  assert.equal(blendEstimate(null, 1_400), 1_400);
  assert.equal(blendEstimate(1_300, null), 1_300);
});

test("an item nobody prices stays unknown rather than becoming free", () => {
  assert.equal(blendEstimate(null, null), null);
});

test("bazaar refresh writes one price per product, folding in known BIN data", async () => {
  const written = new Map<string, CachedPriceWrite>();
  const count = await refreshBazaar({
    async fetchBazaar() {
      return {
        ENCHANTED_DIAMOND: { instantBuy: 1_500, instantSell: 1_200 },
        HYPERION: { instantBuy: null, instantSell: null },
      };
    },
    async knownLowestBin(itemId) {
      return itemId === "HYPERION" ? 900_000_000 : null;
    },
    async writePrice(itemId, price) {
      written.set(itemId, price);
    },
    now: () => 1_000,
  });

  assert.equal(count, 2);
  assert.equal(written.get("ENCHANTED_DIAMOND")?.estimatedValue, 1_500);
  // Nothing on the bazaar, but the AH knows a price — the estimate uses it.
  assert.equal(written.get("HYPERION")?.estimatedValue, 900_000_000);
  assert.equal(written.get("HYPERION")?.bazaarInstantBuy, null);
  assert.equal(written.get("HYPERION")?.fetchedAt, 1_000);
});

test("an unreadable bazaar writes nothing rather than blanking the cache", async () => {
  let writes = 0;
  const count = await refreshBazaar({
    async fetchBazaar() { return null; },
    async knownLowestBin() { return null; },
    async writePrice() { writes += 1; },
  });
  assert.equal(count, 0);
  assert.equal(writes, 0);
});

function listing(over: Partial<AuctionLike> & { auctionId: string }): AuctionLike {
  return { itemName: "Hyperion", price: 1_000, bin: true, endsAt: null, ...over };
}

test("the sweep indexes the cheapest BIN per item across pages", async () => {
  const written = new Map<string, BinWrite>();
  const count = await sweepAuctions({
    async fetchPage(page) {
      if (page === 0) {
        return {
          page: 0,
          totalPages: 2,
          auctions: [listing({ auctionId: "a1", price: 950 }), listing({ auctionId: "a2", price: 1_200 })],
        };
      }
      return {
        page: 1,
        totalPages: 2,
        auctions: [listing({ auctionId: "a3", price: 800 }), listing({ auctionId: "a4", itemName: "Terminator", price: 500 })],
      };
    },
    async writeBin(itemId, entry) { written.set(itemId, entry); },
  });

  assert.equal(count, 2);
  assert.equal(written.get("HYPERION")?.price, 800);
  assert.equal(written.get("HYPERION")?.listings, 3);
  assert.deepEqual(written.get("HYPERION")?.cheapest.map((l) => l.auctionId), ["a3", "a1", "a2"]);
  assert.equal(written.get("TERMINATOR")?.price, 500);
});

test("bid-only auctions are excluded — a bid is not a price anyone can pay", async () => {
  const written = new Map<string, BinWrite>();
  await sweepAuctions({
    async fetchPage() {
      return {
        page: 0,
        totalPages: 1,
        auctions: [listing({ auctionId: "a1", price: 100, bin: false }), listing({ auctionId: "a2", price: 900 })],
      };
    },
    async writeBin(itemId, entry) { written.set(itemId, entry); },
  });
  assert.equal(written.get("HYPERION")?.price, 900);
  assert.equal(written.get("HYPERION")?.listings, 1);
});

test("one failed page degrades coverage instead of losing the sweep", async () => {
  const written = new Map<string, BinWrite>();
  const count = await sweepAuctions({
    async fetchPage(page) {
      if (page === 1) return null;
      return { page, totalPages: 3, auctions: [listing({ auctionId: `a${page}`, price: 1_000 - page })] };
    },
    async writeBin(itemId, entry) { written.set(itemId, entry); },
  });
  assert.equal(count, 1);
  assert.equal(written.get("HYPERION")?.listings, 2);
});

test("a bogus totalPages cannot run the worker past its ceiling", async () => {
  let fetched = 0;
  await sweepAuctions({
    async fetchPage(page) {
      fetched += 1;
      return { page, totalPages: 1_000_000, auctions: [] };
    },
    async writeBin() {},
    maxPages: 5,
  });
  assert.equal(fetched, 5);
});

test("an unreadable first page ends the sweep without writing", async () => {
  let writes = 0;
  const count = await sweepAuctions({
    async fetchPage() { return null; },
    async writeBin() { writes += 1; },
  });
  assert.equal(count, 0);
  assert.equal(writes, 0);
});

// ────────────────────── ended auctions & resources ──────────────────────

test("the median ignores an outlier that would wreck a mean", () => {
  // One misclick listed 1000x over: the mean says ~100M, the median says 1M.
  assert.equal(median([1_000_000, 1_000_000, 1_100_000, 900_000, 1_000_000_000]), 1_000_000);
});

test("an even-count median averages the two middle sales", () => {
  assert.equal(median([100, 200, 300, 400]), 250);
});

test("an empty sample has no median rather than a zero one", () => {
  assert.equal(median([]), null);
});

test("ended sales are grouped per item with low, high and count", async () => {
  const written = new Map<string, SaleStats>();
  const count = await ingestEndedAuctions({
    async fetchEnded() {
      return [
        { auctionId: "1", itemId: null, itemName: "Hyperion", price: 900, bin: true },
        { auctionId: "2", itemId: null, itemName: "hyperion", price: 1_100, bin: true },
        { auctionId: "3", itemId: "TERMINATOR", itemName: "Terminator", price: 500, bin: false },
      ];
    },
    async writeSales(stats) { written.set(stats.itemId, stats); },
    now: () => 1_700_000_000_000,
  });

  assert.equal(count, 2);
  const hyperion = written.get("HYPERION");
  assert.equal(hyperion?.sales, 2, "case differences are the same item");
  assert.equal(hyperion?.low, 900);
  assert.equal(hyperion?.high, 1_100);
  assert.equal(hyperion?.median, 1_000);
  assert.equal(written.get("TERMINATOR")?.sales, 1, "non-BIN sales are real sales too");
});

test("unpriced or unnamed sales are dropped rather than recorded as free", async () => {
  const written: string[] = [];
  const count = await ingestEndedAuctions({
    async fetchEnded() {
      return [
        { auctionId: "1", itemId: null, itemName: null, price: 900, bin: true },
        { auctionId: "2", itemId: "X", itemName: "X", price: null, bin: true },
        { auctionId: "3", itemId: "Y", itemName: "Y", price: 0, bin: true },
      ];
    },
    async writeSales(stats) { written.push(stats.itemId); },
  });
  assert.equal(count, 0);
  assert.deepEqual(written, []);
});

test("an unreadable ended-auctions endpoint writes nothing", async () => {
  const count = await ingestEndedAuctions({
    async fetchEnded() { return null; },
    async writeSales() { assert.fail("nothing to write"); },
  });
  assert.equal(count, 0);
});

test("one failing resource endpoint leaves the others refreshed", async () => {
  const written: string[] = [];
  const count = await refreshResources({
    resources: {
      skills: async () => ({ ok: true }),
      collections: async () => { throw new Error("502"); },
      election: async () => null,
      items: async () => ({ ok: true }),
    },
    async writeResource(name) { written.push(name); },
  });

  assert.equal(count, 2);
  assert.deepEqual(written, ["skills", "items"]);
});
