/**
 * `/price` — one card for an item's market, and the drill-down behind it.
 *
 * There were four commands here. `/price` gave a blended valuation, `/bazaar`
 * gave the order book, `/lowestbin` gave one number, and `/auctions item:` gave
 * the cheapest listings — four cards, four titles, four cooldowns, all about the
 * same item, and no way to get from one to the next except by typing the next
 * one out. A member who wanted to know whether 480m was a good price for a
 * Hyperion had to run three of them and hold the answers in their head.
 *
 * They are one card now, because they were one question. What is it worth right
 * now, on whichever book it trades on; how much of it is moving; and what has it
 * been doing lately. The last of those is the part the platform could never
 * answer: nobody kept the past. Coflnet did, so the chart is theirs — layered on
 * top of our own prices rather than replacing them, per DP-2 of the overhaul
 * plan. Live prices stay on the Hypixel-backed path that networth valuation also
 * depends on, and a Coflnet outage costs the card a chart, not a price.
 *
 * The window buttons and the listings button are stateless like every other
 * persistent control here: the id carries the item and the range, the reply is a
 * fresh read, and a card scrolled back to next week still opens on today's
 * numbers rather than on a snapshot baked in at post time.
 */
import { copy } from "@sbr/brand";
import { card, facts, field, sparkline, type Fact } from "@sbr/embed-kit";
import type {
  ActionRowView,
  AuctionsDTO,
  BazaarQuoteDTO,
  EmbedView,
  HypixelResult,
  LowestBinDTO,
  MarketHistoryDTO,
  MarketRange,
} from "@sbr/shared-types";
import { staleness } from "@sbr/shared-types";
import { formatCoins, formatNumber, renderFailure } from "./render.js";
import type { CommandReply, HandlerDeps } from "./types.js";

const C = copy.embed.card;
const F = copy.embed.field;

/** The router namespace the window buttons and the listings button dispatch on. */
export const MARKET_NAMESPACE = "mk";

/** Rows in the listings drill-down. A field caps at 1024 characters; ten fits. */
const MAX_LISTINGS = 10;

/** Every range, in the order the buttons appear. */
export const MARKET_RANGES: readonly MarketRange[] = ["DAY", "WEEK", "MONTH"];

/** The default window. A week is long enough to have a shape and short enough to be current. */
export const DEFAULT_RANGE: MarketRange = "WEEK";

/** Button labels and the words that go inside a sentence — the same window, said two ways. */
const RANGE_LABEL: Readonly<Record<MarketRange, string>> = { DAY: "24h", WEEK: "7d", MONTH: "30d" };
const RANGE_WORDS: Readonly<Record<MarketRange, string>> = {
  DAY: "24 hours",
  WEEK: "7 days",
  MONTH: "30 days",
};

/** The same windows used as adjectives — "the 7-day average", not "the 7 days average". */
const RANGE_ADJ: Readonly<Record<MarketRange, string>> = {
  DAY: "24-hour",
  WEEK: "7-day",
  MONTH: "30-day",
};

/** A range name off the wire, or the default. Ids outlive the code that wrote them. */
export function parseRange(raw: string | undefined): MarketRange {
  return MARKET_RANGES.find((r) => r === raw) ?? DEFAULT_RANGE;
}

/**
 * Everything the card draws, gathered by the handler.
 *
 * Both market reads are `HypixelResult` because either can fail on its own, and
 * the card is expected to render with one of them missing — an auction-only item
 * has no bazaar quote and never will. History is nullable for a different
 * reason: it is a third party's, and its absence is a note rather than a fault.
 */
export interface MarketSnapshot {
  readonly itemId: string;
  readonly bazaar: HypixelResult<BazaarQuoteDTO>;
  readonly bin: HypixelResult<LowestBinDTO>;
  readonly history: MarketHistoryDTO | null;
  readonly range: MarketRange;
}

/** Coins, or the unknown mark. An unpriced item must never render as `0`. */
function coins(n: number | null | undefined): string | null {
  return typeof n === "number" ? formatCoins(n) : null;
}

/**
 * The catalog's pretty name, or a readable version of the id.
 *
 * The fallback exists because `displayName` is nullable and a card titled
 * `PARTY_HAT_CRAB` is the platform showing its own database schema to somebody
 * who asked what a hat costs. Title-casing the tag is a guess, but it is a guess
 * in the same words the game uses, and it never wins over a real name.
 */
export function itemName(snapshot: MarketSnapshot): string {
  const fromBazaar = snapshot.bazaar.ok ? snapshot.bazaar.value.data.displayName : null;
  const fromBin = snapshot.bin.ok ? snapshot.bin.value.data.displayName : null;
  return fromBazaar ?? fromBin ?? prettifyItemId(snapshot.itemId);
}

/** `PARTY_HAT_CRAB` → `Party Hat Crab`. */
export function prettifyItemId(itemId: string): string {
  return itemId
    .toLowerCase()
    .split(/[_s]+/)
    .filter((w) => w !== "")
    .map((w) => `${w.slice(0, 1).toUpperCase()}${w.slice(1)}`)
    .join(" ");
}

/**
 * The one number at the top.
 *
 * Bazaar instant-buy when the item trades there, lowest BIN otherwise — in both
 * cases what it costs to *have one now*, which is the question `/price` is
 * nearly always being asked. Which book it came from is said out loud, because
 * "480m" means different things on the two of them.
 */
function headlinePrice(snapshot: MarketSnapshot): { readonly value: number; readonly from: string } | null {
  if (snapshot.bazaar.ok && snapshot.bazaar.value.data.instantBuy !== null) {
    return { value: snapshot.bazaar.value.data.instantBuy, from: "instant buy" };
  }
  if (snapshot.bin.ok && snapshot.bin.value.data.price !== null) {
    return { value: snapshot.bin.value.data.price, from: "lowest BIN" };
  }
  return null;
}

/** Buckets with a readable average, oldest first. The series the chart is of. */
function averages(history: MarketHistoryDTO): readonly (number | null)[] {
  return history.points.map((p) => p.avg);
}

/**
 * Where the current price sits against the window's average.
 *
 * The single piece of judgement on the card, and the reason the chart is worth
 * drawing at all: a price is only high or low relative to something. Rounded to
 * whole percent, and anything inside a percent is called flat rather than
 * dressed up as movement.
 */
export function trendAgainst(
  price: number | null,
  history: MarketHistoryDTO | null,
): string | null {
  if (price === null || history === null) return null;
  const known = averages(history).filter((v): v is number => v !== null);
  if (known.length === 0) return null;

  const mean = known.reduce((a, b) => a + b, 0) / known.length;
  if (mean <= 0) return null;

  const change = Math.round(((price - mean) / mean) * 100);
  const range = RANGE_ADJ[history.range];
  if (change === 0) return C.marketFlat.replace("{range}", range);
  const key = change > 0 ? C.marketUp : C.marketDown;
  return key.replace("{n}", String(Math.abs(change))).replace("{range}", range);
}

/** The chart, its extremes and what moved through it, as one field value. */
function historyLines(history: MarketHistoryDTO): string {
  const points = averages(history);
  const known = points.filter((v): v is number => v !== null);
  if (known.length === 0) return C.marketNoHistory;

  const volume = history.points.reduce<number | null>(
    (sum, p) => (p.volume === null ? sum : (sum ?? 0) + p.volume),
    null,
  );
  const entries: Fact[] = [
    // The window is stated here rather than in the field name: a field name is a
    // stable heading, and this one changes every time somebody presses a button.
    { label: "Window", value: RANGE_WORDS[history.range] },
    { label: "Low", value: coins(Math.min(...known)) },
    { label: "Average", value: coins(known.reduce((a, b) => a + b, 0) / known.length) },
    { label: "High", value: coins(Math.max(...known)) },
    { label: "Traded", value: volume === null ? null : formatNumber(Math.round(volume)) },
  ];
  return `${sparkline(points)}\n${facts(entries)}`;
}

/**
 * The market card.
 *
 * Three fields at most, and often two. That is under the four-to-six budget and
 * warns as such: this card is a small number of consolidated facts plus a chart,
 * and splitting "Right now" back into five inline fields to satisfy a rule about
 * consolidating small facts would be the rule eating its own purpose.
 */
export function renderMarketEmbed(snapshot: MarketSnapshot): EmbedView {
  // Only a total failure is a failure. One book not carrying an item is normal —
  // most items trade on exactly one of them — so a card is refused only when
  // neither read came back at all.
  if (!snapshot.bazaar.ok && !snapshot.bin.ok) {
    return card({
      title: C.market.replace("{item}", snapshot.itemId),
      headline: renderFailure(snapshot.bin.error.state),
      tone: snapshot.bin.error.state === "RATE_LIMITED" ? "WARNING" : "NEUTRAL",
    });
  }

  // The envelope of whichever read actually answered. A bazaar item's freshness is
  // the bazaar's; an auction item's is the sweep's, which is the one a reader
  // most needs, because a sweep can be an hour behind.
  const freshness = snapshot.bazaar.ok
    ? { freshness: staleness(snapshot.bazaar.value) }
    : snapshot.bin.ok
      ? { freshness: staleness(snapshot.bin.value) }
      : {};

  const top = headlinePrice(snapshot);
  const trend = trendAgainst(top?.value ?? null, snapshot.history);
  const now: Fact[] = [];

  if (snapshot.bazaar.ok) {
    const q = snapshot.bazaar.value.data;
    now.push(
      { label: "Instant buy", value: coins(q.instantBuy) },
      { label: "Instant sell", value: coins(q.instantSell) },
      { label: "Spread", value: coins(q.spread) },
    );
  }
  if (snapshot.bin.ok && snapshot.bin.value.data.price !== null) {
    now.push(
      { label: "Lowest BIN", value: coins(snapshot.bin.value.data.price) },
      // The count is what tells a reader whether the number above it is a market
      // or one optimist: a lowest BIN backed by a single listing is a rumour.
      { label: "Listings", value: formatNumber(snapshot.bin.value.data.listings) },
    );
  }

  const volume =
    snapshot.bazaar.ok && snapshot.bazaar.value.data.buyVolume !== null
      ? facts([
          { label: "Buy orders", value: formatNumber(snapshot.bazaar.value.data.buyVolume) },
          {
            label: "Sell orders",
            value:
              snapshot.bazaar.value.data.sellVolume === null
                ? null
                : formatNumber(snapshot.bazaar.value.data.sellVolume),
          },
        ])
      : "";

  return card({
    title: C.market.replace("{item}", itemName(snapshot)),
    headline:
      top === null
        ? C.marketNoPrice
        : `**${formatCoins(top.value)}** — ${top.from}${trend === null ? "" : ` · ${trend}`}`,
    fields: [
      field(F.priceNow, now.length === 0 ? "" : facts(now), true),
      field(F.priceVolume, volume, true),
      field(
        F.priceHistory,
        snapshot.history === null ? C.marketHistoryDown : historyLines(snapshot.history),
      ),
    ],
    ...freshness,
    tone: top === null ? "NEUTRAL" : "SUCCESS",
  });
}

/**
 * The controls under the card: one window button per range, and the listings.
 *
 * The current window is disabled rather than hidden — a control that disappears
 * when you press it leaves the reader unsure whether it worked, and a row that
 * changes width between presses is the same card twice in two shapes.
 */
export function marketComponents(
  itemId: string,
  range: MarketRange,
  hasListings: boolean,
): readonly ActionRowView[] {
  const buttons = MARKET_RANGES.map((r) => ({
    label: RANGE_LABEL[r],
    style: "SECONDARY" as const,
    customId: [MARKET_NAMESPACE, "r", r, itemId].join(":"),
    disabled: r === range,
  }));

  // Offered only when the sweep has something behind it, for the reason every
  // other control here is: a button that opens onto "nothing found" teaches
  // people not to press buttons.
  if (hasListings) {
    buttons.push({
      label: C.marketListings,
      style: "SECONDARY" as const,
      customId: [MARKET_NAMESPACE, "l", "", itemId].join(":"),
      disabled: false,
    });
  }

  return [{ buttons }];
}

/**
 * The cheapest listings for an item — what `/auctions item:` used to be.
 *
 * Ephemeral behind a button rather than a command of its own: it is a list of
 * rows nobody reads twice, and it belongs under the price it is a list of.
 */
export function renderListingsEmbed(
  itemId: string,
  displayName: string,
  result: HypixelResult<AuctionsDTO>,
): EmbedView {
  if (!result.ok) {
    return card({
      title: C.market.replace("{item}", displayName),
      headline: renderFailure(result.error.state),
      tone: result.error.state === "RATE_LIMITED" ? "WARNING" : "NEUTRAL",
    });
  }

  const listings = result.value.data.listings.slice(0, MAX_LISTINGS);
  return card({
    title: C.market.replace("{item}", displayName),
    ...(listings.length === 0 ? { headline: C.marketNoListings.replace("{item}", displayName) } : {}),
    fields: [
      field(
        F.cheapestListings,
        listings
          .map((l, i) => `**${String(i + 1)}.** ${coins(l.price) ?? "—"}${l.bin ? "" : " (auction)"}`)
          .join("\n"),
      ),
    ],
    freshness: staleness(result.value),
    tone: listings.length === 0 ? "NEUTRAL" : "INFO",
  });
}

/** The guild-chat line: no embeds there, and the price is the part chat can carry. */
export function marketText(snapshot: MarketSnapshot): string {
  if (!snapshot.bazaar.ok && !snapshot.bin.ok) return renderFailure(snapshot.bin.error.state);

  const top = headlinePrice(snapshot);
  if (top === null) return `${itemName(snapshot)}: ${C.marketNoPrice}`;

  const trend = trendAgainst(top.value, snapshot.history);
  return `${itemName(snapshot)}: ${formatCoins(top.value)} (${top.from})${trend === null ? "" : ` · ${trend}`}`;
}

/**
 * Read the market for one item, at one window.
 *
 * All three reads go out together because they are independent and the slowest
 * of them sets the reply time. History is `undefined`-tolerant twice over: the
 * port is optional (a deployment can run without a history source at all) and it
 * is allowed to answer null (the source is down, or has never heard of the item).
 * Neither costs the card its prices.
 */
export async function readMarket(
  itemId: string,
  range: MarketRange,
  deps: Pick<HandlerDeps, "market" | "history">,
): Promise<MarketSnapshot> {
  const [bazaar, bin, history] = await Promise.all([
    deps.market.getBazaarQuote(itemId),
    deps.market.getLowestBin(itemId),
    deps.history?.history(itemId, range).catch(() => null) ?? Promise.resolve(null),
  ]);
  return { itemId, bazaar, bin, history, range };
}

/** The market card as a reply: embed, chat line, and the controls under it. */
export async function marketReply(
  itemId: string,
  range: MarketRange,
  deps: Pick<HandlerDeps, "market" | "history">,
): Promise<CommandReply> {
  const snapshot = await readMarket(itemId, range, deps);
  // The listings button is offered on the strength of the BIN count rather than
  // by making a second call to find out: the sweep already told us whether there
  // is anything behind it, and a button is not worth an extra request.
  const hasListings = snapshot.bin.ok && snapshot.bin.value.data.listings > 0;
  return {
    ephemeral: false,
    text: marketText(snapshot),
    embed: renderMarketEmbed(snapshot),
    components: marketComponents(itemId, range, hasListings),
  };
}

/**
 * What the buttons under the card do.
 *
 * Both re-read rather than replaying a snapshot: a card scrolled back to next
 * week must open on today's numbers, and a price cached in a customId is the
 * kind of stale that looks live.
 */
export const marketButtonReplies = {
  /** `mk:r:<range>:<itemId>` — redraw the card over a different window. */
  async range(itemId: string, rawRange: string, deps: HandlerDeps): Promise<CommandReply> {
    return marketReply(itemId, parseRange(rawRange), deps);
  },

  /** `mk:l::<itemId>` — the cheapest listings, ephemeral under the card. */
  async listings(itemId: string, deps: HandlerDeps): Promise<CommandReply> {
    const result = await deps.market.getItemAuctions(itemId);
    const displayName = result.ok
      ? (result.value.data.listings[0]?.itemName ?? itemId)
      : itemId;
    const embed = renderListingsEmbed(itemId, displayName, result);
    return { ephemeral: true, text: embed.description ?? displayName, embed };
  },
};
