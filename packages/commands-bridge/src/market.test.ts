import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AuctionsDTO,
  BazaarQuoteDTO,
  DataEnvelope,
  HypixelResult,
  LowestBinDTO,
  MarketHistoryDTO,
  MarketPointDTO,
  MarketRange,
} from "@sbr/shared-types";
import {
  itemName,
  marketComponents,
  marketText,
  parseRange,
  prettifyItemId,
  readMarket,
  renderListingsEmbed,
  renderMarketEmbed,
  trendAgainst,
  type MarketSnapshot,
} from "./market.js";

const NOW = "2026-08-20T12:00:00.000Z";

function live<T>(data: T): HypixelResult<T> {
  const value: DataEnvelope<T> = { data, freshness: "LIVE", fetchedAt: NOW, source: "LIVE" };
  return { ok: true, value };
}

function failed<T>(): HypixelResult<T> {
  return { ok: false, error: { state: "MISSING_PROFILE" } };
}

const BAZAAR: BazaarQuoteDTO = {
  itemId: "ENCHANTED_DIAMOND",
  displayName: "Enchanted Diamond",
  instantBuy: 200,
  instantSell: 180,
  buyVolume: 4_000,
  sellVolume: 6_000,
  spread: 20,
};

const BIN: LowestBinDTO = {
  itemId: "HYPERION",
  displayName: "Hyperion",
  price: 1_000_000_000,
  listings: 12,
};

function history(avgs: readonly (number | null)[], range: MarketRange = "WEEK"): MarketHistoryDTO {
  const points: MarketPointDTO[] = avgs.map((avg, i) => ({
    at: new Date(Date.UTC(2026, 7, 20, i)).toISOString(),
    min: avg,
    max: avg,
    avg,
    volume: avg === null ? null : 10,
  }));
  return { itemId: "HYPERION", range, points };
}

function snapshot(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    itemId: "HYPERION",
    bazaar: failed<BazaarQuoteDTO>(),
    bin: live(BIN),
    history: null,
    range: "WEEK",
    ...over,
  };
}

test("a bazaar item leads with instant buy, and says which book that is", () => {
  const embed = renderMarketEmbed(snapshot({ itemId: "ENCHANTED_DIAMOND", bazaar: live(BAZAAR), bin: failed() }));
  assert.match(embed.description ?? "", /^\*\*200\*\* — instant buy/);
});

test("an auction-only item leads with the lowest BIN", () => {
  const embed = renderMarketEmbed(snapshot());
  assert.match(embed.description ?? "", /^\*\*1\.00b\*\* — lowest BIN/);
});

test("one book missing is not a failure — most items trade on exactly one", () => {
  // `/bazaar` used to report an outage for an auction-only item. The card knows
  // the difference between "no answer" and "not sold there".
  const embed = renderMarketEmbed(snapshot());
  assert.equal(embed.fields?.some((f) => f.name === "Right now"), true);
});

test("both books failing is the only failure", () => {
  const embed = renderMarketEmbed(snapshot({ bin: failed() }));
  assert.equal(embed.fields?.length ?? 0, 0);
  assert.ok((embed.description ?? "").length > 0);
});

test("no price is stated as no price, never as zero", () => {
  const embed = renderMarketEmbed(snapshot({ bin: live({ ...BIN, price: null, listings: 0 }) }));
  assert.doesNotMatch(embed.description ?? "", /0/);
});

test("the listing count rides with the BIN, because one listing is a rumour", () => {
  const embed = renderMarketEmbed(snapshot({ bin: live({ ...BIN, listings: 1 }) }));
  const now = embed.fields?.find((f) => f.name === "Right now");
  assert.match(now?.value ?? "", /\*\*Listings\*\* 1/);
});

test("the trend compares today with the window it is drawn over", () => {
  // 1.00b against an average of 800m is 25% up. The number is the whole reason
  // the chart is worth drawing: a price is only high relative to something.
  assert.equal(trendAgainst(1_000_000_000, history([700_000_000, 900_000_000])), "25% above the 7-day average");
  assert.equal(trendAgainst(700_000_000, history([900_000_000, 900_000_000])), "22% below the 7-day average");
});

test("anything inside a percent is flat rather than dressed up as movement", () => {
  assert.equal(trendAgainst(1_000_000_000, history([1_000_000_000])), "in line with the 7-day average");
});

test("no history means no trend, not a trend of zero", () => {
  assert.equal(trendAgainst(1_000_000_000, null), null);
  assert.equal(trendAgainst(1_000_000_000, history([null, null])), null);
  assert.equal(trendAgainst(null, history([100])), null);
});

test("a history outage costs the card its chart and nothing else", () => {
  // The whole point of DP-2: Coflnet is layered on top, so its uptime cannot
  // reach the numbers somebody is about to trade on.
  const embed = renderMarketEmbed(snapshot({ history: null }));
  assert.match(embed.description ?? "", /1\.00b/);
  assert.match(embed.fields?.find((f) => f.name === "History")?.value ?? "", /unavailable/i);
});

test("an item with no recorded past says so, which is not the same message", () => {
  const embed = renderMarketEmbed(snapshot({ history: history([]) }));
  assert.match(embed.fields?.find((f) => f.name === "History")?.value ?? "", /no price history/i);
});

test("the window is in the value, because a field name is a stable heading", () => {
  const embed = renderMarketEmbed(snapshot({ history: history([100, 120]) }));
  const field = embed.fields?.find((f) => f.name === "History");
  assert.match(field?.value ?? "", /\*\*Window\*\* 7 days/);
});

test("the pressed window is disabled rather than removed", () => {
  // A row that changes width between presses is the same card in two shapes.
  const [row] = marketComponents("HYPERION", "WEEK", false);
  assert.deepEqual(
    row?.buttons.map((b) => [b.label, b.disabled === true]),
    [["24h", false], ["7d", true], ["30d", false]],
  );
});

test("the listings button is offered only when there is something behind it", () => {
  const without = marketComponents("HYPERION", "DAY", false)[0]?.buttons ?? [];
  const withIt = marketComponents("HYPERION", "DAY", true)[0]?.buttons ?? [];
  assert.equal(without.length, 3);
  assert.equal(withIt.length, 4);
  assert.equal(withIt[3]?.customId, "mk:l::HYPERION");
});

test("a window button carries the item, so a card still works after a restart", () => {
  const [row] = marketComponents("NECRON_HANDLE", "WEEK", false);
  assert.equal(row?.buttons[2]?.customId, "mk:r:MONTH:NECRON_HANDLE");
});

test("an unreadable range falls back rather than throwing", () => {
  // Ids outlive the code that wrote them.
  assert.equal(parseRange("WEEK"), "WEEK");
  assert.equal(parseRange("YEAR"), "WEEK");
  assert.equal(parseRange(undefined), "WEEK");
});

test("a raw item id is never shown as one", () => {
  assert.equal(prettifyItemId("PARTY_HAT_CRAB"), "Party Hat Crab");
  assert.equal(itemName(snapshot({ bin: live({ ...BIN, displayName: null }) })), "Hyperion");
});

test("all three reads go out together, and history is allowed to be absent", async () => {
  const asked: string[] = [];
  const snap = await readMarket("HYPERION", "DAY", {
    market: {
      async getBazaarQuote() {
        asked.push("bazaar");
        return failed<BazaarQuoteDTO>();
      },
      async getLowestBin() {
        asked.push("bin");
        return live(BIN);
      },
    } as never,
  });

  assert.deepEqual(asked.sort(), ["bazaar", "bin"]);
  assert.equal(snap.history, null, "an unwired history port is a missing chart, not an error");
  assert.equal(snap.range, "DAY");
});

test("a history port that throws is a missing chart, not a failed command", async () => {
  const snap = await readMarket("HYPERION", "WEEK", {
    market: {
      async getBazaarQuote() {
        return failed<BazaarQuoteDTO>();
      },
      async getLowestBin() {
        return live(BIN);
      },
    } as never,
    history: {
      async history() {
        throw new Error("coflnet down");
      },
    },
  });
  assert.equal(snap.history, null);
});

test("guild chat gets the price, since chat has no embeds to carry the rest", () => {
  assert.equal(
    marketText(snapshot({ history: history([800_000_000]) })),
    "Hyperion: 1.00b (lowest BIN) · 25% above the 7-day average",
  );
});

const LISTINGS: AuctionsDTO = {
  listings: [
    { auctionId: "a", itemName: "Necron's Handle", price: 470_000_000, bin: true, endsAt: null, highestBid: null, claimed: false },
    { auctionId: "b", itemName: "Necron's Handle", price: 480_000_000, bin: false, endsAt: null, highestBid: 12, claimed: false },
  ],
  active: [],
  unclaimed: [],
  expired: [],
  claimValue: null,
};

test("the listings drill-down numbers the rows and marks the ones that are not BINs", () => {
  const embed = renderListingsEmbed("NECRON_HANDLE", "Necron's Handle", live(LISTINGS));
  const value = embed.fields?.[0]?.value ?? "";
  assert.match(value, /\*\*1\.\*\* 470\.00m\n\*\*2\.\*\* 480\.00m \(auction\)/);
});

test("nothing listed is said plainly rather than shown as an empty field", () => {
  const embed = renderListingsEmbed("NECRON_HANDLE", "Necron's Handle", live({ ...LISTINGS, listings: [] }));
  assert.match(embed.description ?? "", /No buy-it-now listings/);
  assert.equal(embed.fields?.length ?? 0, 0);
});
