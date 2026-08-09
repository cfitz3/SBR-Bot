/**
 * SkyKings API client.
 *
 * Scope: the read endpoints the platform has a use for — the scammer list, the
 * Discord↔Minecraft link, and SkyKings' own tracked player/guild snapshots.
 * `POST /networth` is deliberately not wired: it wants the caller to upload a
 * full `/v2/skyblock/profiles` payload, and `@sbr/progression` already values a
 * profile from data we have in hand. See EXTERNAL_APIS.md.
 *
 * Two rules run through the whole file:
 *
 * 1. **An outage is never an all-clear.** Every failure path produces UNKNOWN
 *    with a cause, never a clear/absent verdict, so a policy can decide what an
 *    unscreened stranger is worth rather than being lied to.
 * 2. **Cache successes, not failures.** A cached "clear" that outlives an
 *    upstream listing is the expensive mistake, so TTLs are short and a flagged
 *    answer is cached for less time than a clear one is.
 */
import type { Logger } from "@sbr/observability";
import type { HttpFetcher, SkykingsCache } from "./ports.js";
import { InMemorySkykingsCache } from "./ports.js";
import type {
  ScammerCheck,
  SkykingsGuildDTO,
  SkykingsLinkDTO,
  SkykingsPlayerDTO,
  SkykingsProfileDTO,
  SkykingsResult,
  SkykingsUnknownCause,
} from "./types.js";

export const SKYKINGS_BASE_URL = "https://api.skykings.net";

/**
 * How long a verdict may be reused.
 *
 * A clear answer is cached long enough to keep a burst of join requests from
 * one raid off the API; a flagged one expires sooner because the interesting
 * change to a flagged record is its *removal* — an appeal that succeeded — and
 * holding a stale accusation is worse than one extra request.
 */
export const CLEAR_TTL_MS = 30 * 60_000;
export const FLAGGED_TTL_MS = 5 * 60_000;

/** Tracked-player snapshots move slowly; SkyKings refreshes them on its own clock. */
export const PLAYER_TTL_MS = 15 * 60_000;

export interface SkykingsClientOptions {
  /** Absent or blank disables the client: every call answers NOT_CONFIGURED. */
  readonly apiKey: string | undefined;
  readonly fetch: HttpFetcher;
  readonly logger: Logger;
  readonly baseUrl?: string;
  readonly cache?: SkykingsCache;
}

/** Dashes are optional upstream; the cache key and the query must agree on one form. */
export function normalizeUuid(uuid: string): string {
  return uuid.replace(/-/g, "").toLowerCase();
}

export class SkykingsClient {
  private readonly apiKey: string | null;
  private readonly http: HttpFetcher;
  private readonly log: Logger;
  private readonly baseUrl: string;
  private readonly cache: SkykingsCache;
  /**
   * In-flight requests by cache key.
   *
   * A guild raid is exactly the situation this client sees load in: a dozen
   * join requests for the same handful of accounts inside a minute. Without
   * this, each one is its own round trip.
   */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(opts: SkykingsClientOptions) {
    const key = opts.apiKey?.trim();
    this.apiKey = key !== undefined && key.length > 0 ? key : null;
    this.http = opts.fetch;
    this.log = opts.logger.child({ service: "skykings" });
    this.baseUrl = (opts.baseUrl ?? SKYKINGS_BASE_URL).replace(/\/+$/, "");
    this.cache = opts.cache ?? new InMemorySkykingsCache();

    if (this.apiKey === null) {
      // Once, at construction: a per-call warning would be one line per join
      // request, and the fact being reported is a static deployment fact.
      this.log.warn("skykings api key not configured — scammer screening will report UNKNOWN");
    }
  }

  get configured(): boolean {
    return this.apiKey !== null;
  }

  /** `GET /health`. True only on a healthy answer; anything else is false. */
  async healthy(): Promise<boolean> {
    const res = await this.request("/health", {});
    if (res.status !== "OK") return false;
    const body = asRecord(res.data);
    return body !== null && body["status"] === "healthy";
  }

  /**
   * `GET /user/lookup?uuid=` — is this Minecraft account on the scammer list?
   */
  async checkUuid(uuid: string): Promise<ScammerCheck> {
    return this.check(`uuid=${encodeURIComponent(normalizeUuid(uuid))}`, `sk:scam:u:${normalizeUuid(uuid)}`);
  }

  /**
   * `GET /user/lookup?userid=` — the same question about a Discord account.
   *
   * Worth asking separately: a scammer who has been listed under one identifier
   * is often not listed under the other, and someone applying with a linked
   * Discord gives us two chances to find out.
   */
  async checkDiscordId(userId: string): Promise<ScammerCheck> {
    if (!/^\d{17,20}$/.test(userId)) {
      return { status: "UNKNOWN", cause: "UNAVAILABLE", detail: "not a Discord id" };
    }
    return this.check(`userid=${encodeURIComponent(userId)}`, `sk:scam:d:${userId}`);
  }

  private async check(query: string, cacheKey: string): Promise<ScammerCheck> {
    const cached = await this.cache.get<ScammerCheck>(cacheKey).catch(() => null);
    if (cached) return cached;

    return this.single(cacheKey, async () => {
      const res = await this.request(`/user/lookup?${query}`, {});
      if (res.status !== "OK") {
        return { status: "UNKNOWN", cause: res.cause, ...(res.detail ? { detail: res.detail } : {}) } as const;
      }

      const body = asRecord(res.data);
      const result = asRecord(body?.["result"]);
      // A 200 whose body doesn't carry the field we asked about is not a clear
      // answer, it is an unreadable one. Saying CLEAR here would be inventing a
      // verdict out of a shape change upstream.
      if (result === null || typeof result["scammer"] !== "boolean") {
        this.log.warn("skykings lookup returned an unreadable body");
        return { status: "UNKNOWN", cause: "UNAVAILABLE", detail: "unreadable body" } as const;
      }

      const verdict: ScammerCheck = result["scammer"]
        ? {
            status: "FLAGGED",
            reason: asString(result["reason"]),
            message: asString(result["message"]),
          }
        : { status: "CLEAR" };

      await this.cache
        .set(cacheKey, verdict, verdict.status === "FLAGGED" ? FLAGGED_TTL_MS : CLEAR_TTL_MS)
        .catch(() => {});
      return verdict;
    });
  }

  /**
   * `GET /user/info` — the Discord account SkyKings has on file for a player.
   *
   * Not a substitute for our own verification: SkyKings' link says the player
   * proved themselves to *them*. It is useful as a second identifier to run the
   * scammer check against, and as a hint when someone joins unlinked.
   */
  async getLink(by: { uuid: string } | { userId: string }): Promise<SkykingsResult<SkykingsLinkDTO | null>> {
    const query = "uuid" in by ? `uuid=${encodeURIComponent(normalizeUuid(by.uuid))}` : `userid=${encodeURIComponent(by.userId)}`;
    const res = await this.request(`/user/info?${query}`, { notFoundIsNull: true });
    if (res.status !== "OK") return res;
    if (res.data === null) return { status: "OK", data: null };

    const data = asRecord(asRecord(res.data)?.["data"]);
    const uuid = asString(data?.["uuid"]);
    const userid = asString(data?.["userid"]);
    if (uuid === null || userid === null) return { status: "OK", data: null };
    return { status: "OK", data: { uuid, userid } };
  }

  /**
   * `GET /leaderboard/user` — SkyKings' tracked snapshot of a player.
   *
   * `null` data means "not tracked", which is ordinary: SkyKings only follows
   * players it has seen. Treating it as an error would make every unknown
   * newcomer look like an outage.
   */
  async getPlayer(uuid: string): Promise<SkykingsResult<SkykingsPlayerDTO | null>> {
    const id = normalizeUuid(uuid);
    const cacheKey = `sk:lb:u:${id}`;
    const cached = await this.cache.get<SkykingsPlayerDTO | null>(cacheKey).catch(() => null);
    if (cached !== null) return { status: "OK", data: cached };

    return this.single(cacheKey, async () => {
      const res = await this.request(`/leaderboard/user?uuid=${encodeURIComponent(id)}`, { notFoundIsNull: true });
      if (res.status !== "OK") return res;

      const data = asRecord(asRecord(res.data)?.["data"]);
      if (data === null) return { status: "OK", data: null } as const;

      const recent = asRecord(data["recent_data"]);
      const player: SkykingsPlayerDTO = {
        uuid: asString(data["uuid"]) ?? id,
        username: asString(data["username"]),
        guild: asString(data["guild"]),
        networth: asNumber(recent?.["networth"]),
        lilyWeight: asNumber(recent?.["lily_weight_total"]),
        senitherWeight: asNumber(recent?.["senither_weight_total"]),
        eliteWeight: asNumber(recent?.["elite_weight_total"]),
        profiles: asProfiles(recent?.["profiles"]),
        lastChecked: asString(data["last_checked"]),
      };
      await this.cache.set(cacheKey, player, PLAYER_TTL_MS).catch(() => {});
      return { status: "OK", data: player } as const;
    });
  }

  /** `GET /leaderboard/guild` — the aggregate SkyKings holds for a guild by name. */
  async getGuild(name: string): Promise<SkykingsResult<SkykingsGuildDTO | null>> {
    const res = await this.request(`/leaderboard/guild?guild=${encodeURIComponent(name)}`, { notFoundIsNull: true });
    if (res.status !== "OK") return res;

    const data = asRecord(asRecord(res.data)?.["data"]);
    if (data === null) return { status: "OK", data: null };

    const recent = asRecord(data["recent_data"]);
    return {
      status: "OK",
      data: {
        name: asString(data["name"]) ?? name,
        discordLink: asString(data["discord_link"]),
        averageNetworth: asNumber(recent?.["average_networth"]),
        averageLilyWeight: asNumber(recent?.["average_lily_weight"]),
        averageSenitherWeight: asNumber(recent?.["average_senither_weight"]),
        memberCount: asNumber(recent?.["member_count"]),
        lastChecked: asString(data["last_checked"]),
      },
    };
  }

  // ─────────────────────────── plumbing ───────────────────────────

  /**
   * One request, with the status ladder that decides whether a caller may retry.
   *
   * The key travels in the `Authorization` header rather than the `api_key`
   * query parameter the docs also accept: query strings end up in proxy logs and
   * in our own request logging, and a leaked key to a scammer database is a key
   * someone else can use to check whether *they* are listed.
   */
  private async request(
    path: string,
    opts: { readonly notFoundIsNull?: boolean },
  ): Promise<{ status: "OK"; data: unknown } | { status: "UNKNOWN"; cause: SkykingsUnknownCause; detail?: string }> {
    if (this.apiKey === null) return { status: "UNKNOWN", cause: "NOT_CONFIGURED" };

    let res;
    try {
      res = await this.http.get(`${this.baseUrl}${path}`, { Authorization: this.apiKey, Accept: "application/json" });
    } catch (error) {
      // The shipped fetcher turns transport failures into a 504 rather than
      // throwing, but a caller may inject anything, and an exception escaping
      // into a chat handler would take the screening down with it.
      this.log.warn("skykings request threw", { error: error instanceof Error ? error.message : "unknown" });
      return { status: "UNKNOWN", cause: "UNAVAILABLE", detail: "transport" };
    }

    if (res.status === 404 && opts.notFoundIsNull === true) return { status: "OK", data: null };
    if (res.status === 401 || res.status === 403) {
      this.log.error("skykings rejected the api key", { status: res.status });
      return { status: "UNKNOWN", cause: "UNAUTHORIZED" };
    }
    if (res.status === 429) return { status: "UNKNOWN", cause: "RATE_LIMITED" };
    if (res.status < 200 || res.status >= 300) {
      this.log.warn("skykings request failed", { status: res.status, path: path.split("?")[0] });
      return { status: "UNKNOWN", cause: "UNAVAILABLE", detail: `http ${res.status}` };
    }

    const body = asRecord(res.json);
    // The API reports its own failures inside a 200. `success: false` is an
    // upstream refusal, not a payload.
    if (body !== null && body["success"] === false) {
      if (opts.notFoundIsNull === true) return { status: "OK", data: null };
      return { status: "UNKNOWN", cause: "UNAVAILABLE", detail: asString(body["message"]) ?? "success: false" };
    }

    return { status: "OK", data: res.json };
  }

  /** Collapse concurrent identical requests onto one promise. */
  private async single<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = run().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
}

// ── readers, tolerant by design: an unexpected shape yields null, never a throw ──

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asProfiles(value: unknown): readonly SkykingsProfileDTO[] {
  if (!Array.isArray(value)) return [];
  const out: SkykingsProfileDTO[] = [];
  for (const entry of value) {
    const row = asRecord(entry);
    if (row === null) continue;
    out.push({
      profileName: asString(row["profile_name"]),
      skyblockXp: asNumber(row["skyblock_xp"]),
      networth: asNumber(row["networth"]),
    });
  }
  return out;
}
