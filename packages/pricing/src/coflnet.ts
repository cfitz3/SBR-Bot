/**
 * Coflnet SkyApi — the price-history adapter.
 *
 * One endpoint family does the whole job: `/api/item/price/{tag}/history/{day,
 * week,month}` returns `{min,max,avg,volume,time}` buckets for auction items and
 * bazaar items alike, unauthenticated. The bazaar-specific routes exist and
 * carry both sides of the book, but a card that shows one series does not need
 * two shapes to parse and two failure modes to reason about, so the uniform
 * route wins.
 *
 * Two decisions worth stating, because both are about not lying:
 *
 * **A missing item is not an outage.** Coflnet answers 400 `item_not_found` for
 * a tag it has never seen — a real answer about a real question, and the item
 * genuinely has no history with them. That returns an empty series. If it
 * counted as a failure instead, three people looking up three obscure items in
 * a row would open the breaker for everybody.
 *
 * **The timestamps have no zone.** `time` comes back as `2026-08-21T03:00:00`,
 * and `new Date()` reads a bare local-looking string as *local* time — so on any
 * host not running UTC the entire series silently shifts by the offset, which is
 * invisible on a chart and wrong on the axis. It is UTC upstream, so it is
 * parsed as UTC here.
 */
import type { Logger } from "@sbr/observability";
import type { MarketRange } from "@sbr/shared-types";
import type { HistoryHttp, HistoryPoint, PriceHistoryProvider } from "./ports.js";

export const COFLNET_BASE_URL = "https://sky.coflnet.com";

/** Our range names to theirs. */
const PATH: Readonly<Record<MarketRange, string>> = { DAY: "day", WEEK: "week", MONTH: "month" };

export interface CoflnetHistoryDeps {
  readonly fetch: HistoryHttp;
  readonly logger: Logger;
  readonly baseUrl?: string;
}

/** `2026-08-21T03:00:00` (no zone, UTC upstream) → epoch millis, or null. */
export function parseCoflnetTime(raw: unknown): number | null {
  if (typeof raw !== "string" || raw === "") return null;
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}Z`;
  const ms = Date.parse(zoned);
  return Number.isNaN(ms) ? null : ms;
}

/** A number, or null. Anything non-finite is missing data wearing a number's clothes. */
function num(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

export class CoflnetHistory implements PriceHistoryProvider {
  private readonly http: HistoryHttp;
  private readonly log: Logger;
  private readonly baseUrl: string;

  constructor(deps: CoflnetHistoryDeps) {
    this.http = deps.fetch;
    this.log = deps.logger.child({ service: "coflnet" });
    this.baseUrl = (deps.baseUrl ?? COFLNET_BASE_URL).replace(/\/+$/, "");
  }

  async history(itemId: string, range: MarketRange): Promise<readonly HistoryPoint[] | null> {
    const tag = encodeURIComponent(itemId.toUpperCase());
    const url = `${this.baseUrl}/api/item/price/${tag}/history/${PATH[range]}`;

    const res = await this.http.get(url).catch((error: unknown) => {
      this.log.debug("history request failed", { itemId, error: String(error) });
      return null;
    });
    if (res === null) return null;

    if (res.status === 400 && isItemNotFound(res.json)) return [];
    if (res.status !== 200) {
      this.log.debug("history rejected", { itemId, range, status: res.status });
      return null;
    }
    if (!Array.isArray(res.json)) {
      // A 200 that is not the documented array is a contract change, not a
      // quiet empty answer — an empty series here would report "no history"
      // for every item on the server.
      this.log.warn("history response was not a series", { itemId, range });
      return null;
    }

    // Buckets with no readable timestamp are dropped rather than dated to now:
    // a point on a chart at the wrong x is worse than a point that is not there.
    return res.json.flatMap((raw): HistoryPoint[] => {
      const row = raw as Record<string, unknown>;
      const at = parseCoflnetTime(row["time"] ?? row["timestamp"]);
      if (at === null) return [];
      return [{ at, min: num(row["min"]), max: num(row["max"]), avg: num(row["avg"]), volume: num(row["volume"]) }];
    });
  }
}

function isItemNotFound(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { slug?: unknown }).slug === "item_not_found";
}
