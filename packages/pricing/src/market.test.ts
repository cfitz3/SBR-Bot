import assert from "node:assert/strict";
import { test } from "node:test";
import { hypixelFailure, ok, type DataEnvelope } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { ItemCatalog } from "./catalog.js";
import { MarketServiceImpl } from "./market.js";
import type { BazaarProvider, BinEntry, BinSource, ItemResourceProvider, PlayerAuctionProvider } from "./ports.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

function live<T>(data: T): DataEnvelope<T> {
  return { data, freshness: "LIVE", source: "LIVE", fetchedAt: "2026-01-01T00:00:00.000Z" };
}

const resources: ItemResourceProvider = {
  async getResources() {
    return ok(
      live({
        data: {
          items: [
            { id: "HYPERION", name: "Hyperion" },
            { id: "HYPER_CATALYST_UPGRADE", name: "Hyper Catalyst Upgrade" },
            { id: "ENCHANTED_DIAMOND", name: "Enchanted Diamond" },
          ],
        } as Record<string, unknown>,
      }),
    );
  },
};

const bazaar: BazaarProvider = {
  async getBazaar() {
    return ok(
      live({
        lastUpdated: 1,
        products: {
          ENCHANTED_DIAMOND: {
            productId: "ENCHANTED_DIAMOND",
            instantBuy: 1_500,
            instantSell: 1_200,
            buyVolume: 400,
            sellVolume: 380,
          },
          ONE_SIDED: {
            productId: "ONE_SIDED",
            instantBuy: 900,
            instantSell: null,
            buyVolume: 10,
            sellVolume: 0,
          },
        },
      }),
    );
  },
};

function bins(entry: BinEntry | null): BinSource {
  return { async get() { return entry; } };
}

const noAuctions: PlayerAuctionProvider = { async getPlayerAuctions() { return ok(live([])); } };

function make(over: { bins?: BinSource; auctions?: PlayerAuctionProvider; now?: () => number } = {}) {
  return new MarketServiceImpl({
    bazaar,
    bins: over.bins ?? bins(null),
    auctions: over.auctions ?? noAuctions,
    catalog: new ItemCatalog({ resources }),
    logger: silent,
    ...(over.now ? { now: over.now } : {}),
  });
}

test("a bazaar quote carries both sides and the spread between them", async () => {
  const r = await make().getBazaarQuote("ENCHANTED_DIAMOND");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.data.instantBuy, 1_500);
  assert.equal(r.value.data.spread, 300);
  assert.equal(r.value.data.displayName, "Enchanted Diamond");
});

test("a one-sided book has no spread rather than a misleading one", async () => {
  const r = await make().getBazaarQuote("ONE_SIDED");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.data.spread, null);
});

test("an item that isn't traded on the bazaar is a missing record, not an outage", async () => {
  const r = await make().getBazaarQuote("HYPERION");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.state, "MISSING_PROFILE");
});

test("a cold sweep cache yields an unknown price, never zero", async () => {
  const r = await make().getLowestBin("HYPERION");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.data.price, null);
  assert.equal(r.value.data.listings, 0);
  // Marked stale so the command can say the data is missing rather than current.
  assert.equal(r.value.freshness, "STALE");
});

test("a recent sweep reading is served as live", async () => {
  const entry: BinEntry = { price: 900, listings: 3, cheapest: [], fetchedAt: 1_000 };
  const r = await make({ bins: bins(entry), now: () => 2_000 }).getLowestBin("HYPERION");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.data.price, 900);
  assert.equal(r.value.freshness, "LIVE");
});

test("an old sweep reading is still served, but flagged stale", async () => {
  const entry: BinEntry = { price: 900, listings: 3, cheapest: [], fetchedAt: 0 };
  const r = await make({ bins: bins(entry), now: () => 60 * 60_000 }).getLowestBin("HYPERION");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.data.price, 900);
  assert.equal(r.value.freshness, "STALE");
});

test("player auctions are ordered soonest-ending first", async () => {
  const auctions: PlayerAuctionProvider = {
    async getPlayerAuctions() {
      return ok(
        live([
          { auctionId: "later", itemName: "A", price: 1, bin: true, endsAt: 5_000 },
          { auctionId: "never", itemName: "B", price: 1, bin: true, endsAt: null },
          { auctionId: "soon", itemName: "C", price: 1, bin: true, endsAt: 1_000 },
        ]),
      );
    },
  };
  const r = await make({ auctions }).getPlayerAuctions("uuid");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value.data.listings.map((l) => l.auctionId), ["soon", "later", "never"]);
  assert.equal(r.value.data.listings[0]?.endsAt, new Date(1_000).toISOString());
});

test("an upstream failure propagates rather than reporting no auctions", async () => {
  const auctions: PlayerAuctionProvider = {
    async getPlayerAuctions() { return hypixelFailure("RATE_LIMITED"); },
  };
  const r = await make({ auctions }).getPlayerAuctions("uuid");
  assert.equal(r.ok, false);
});

test("item auctions come only from the sweep cache", async () => {
  const entry: BinEntry = {
    price: 900,
    listings: 2,
    cheapest: [{ auctionId: "a1", itemName: "Hyperion", price: 900, bin: true, endsAt: null }],
    fetchedAt: 1_000,
  };
  const r = await make({ bins: bins(entry), now: () => 1_500 }).getItemAuctions("HYPERION");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.data.listings.length, 1);
  assert.equal(r.value.source, "CACHE");
});

test("autocomplete ranks prefix matches above substring matches", async () => {
  const matches = await make().searchItems("hyper");
  assert.deepEqual(matches.map((m) => m.itemId), ["HYPER_CATALYST_UPGRADE", "HYPERION"]);
});

test("a typed name resolves to the canonical id", async () => {
  const svc = make();
  assert.equal(await svc.resolveItemId("Hyperion"), "HYPERION");
  assert.equal(await svc.resolveItemId("enchanted diamond"), "ENCHANTED_DIAMOND");
  assert.equal(await svc.resolveItemId("HYPERION"), "HYPERION");
});

test("an unknown name resolves to nothing rather than a wrong guess", async () => {
  assert.equal(await make().resolveItemId("not a real item"), null);
});
