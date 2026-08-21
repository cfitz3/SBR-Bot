/**
 * HypixelClient — the single centralized entry point for Hypixel/Mojang calls
 * (HYPIXEL_DATA_LAYER.md). One request path:
 *   cache lookup → single-flight → rate-limit gate → HTTP → header ingest
 *   → retry/backoff → normalize → cache set → typed HypixelResult.
 *
 * Every endpoint goes through `cached()`, so caching, staleness, retries and
 * fallback states are implemented exactly once rather than per method.
 *
 * Implements HypixelSocialLookup so it finishes the /link flow.
 */
import {
  err,
  hypixelFailure,
  ok,
  type DataEnvelope,
  type HypixelResult,
  type HypixelSocialLookup,
  type HypixelSocialResult,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { InMemoryHypixelCache, InMemoryRateGate } from "./memory.js";
import { fetchHttp } from "./http.js";
import { decodeItemBytes } from "./nbt.js";
import {
  realSleep,
  unlimitedPlayers,
  type HttpFetcher,
  type HypixelCache,
  type PlayerRateLimiter,
  type RateGate,
  type Sleeper,
} from "./ports.js";
import type {
  AuctionDTO,
  AuctionPageDTO,
  BazaarDTO,
  BazaarProductDTO,
  BingoDTO,
  ElectionDTO,
  EndedAuctionDTO,
  EndedAuctionsDTO,
  FiresalesDTO,
  GuildDTO,
  HypixelPlayerDTO,
  MuseumDTO,
  RawAuction,
  RawAuctionsResponse,
  RawBazaarResponse,
  RawBingoResponse,
  RawElectionResponse,
  RawEndedAuctionsResponse,
  RawFiresalesResponse,
  RawGuild,
  RawGuildMember,
  RawGuildResponse,
  RawHypixelPlayer,
  RawHypixelPlayerResponse,
  RawMojangProfile,
  RawMuseumResponse,
  RawSkyblockProfile,
  RawSkyblockProfilesResponse,
  ResourceDTO,
  SkyblockProfileDTO,
} from "./types.js";

const MOJANG_PROFILE_URL = "https://api.mojang.com/users/profiles/minecraft/";
const MOJANG_SESSION_URL = "https://sessionserver.mojang.com/session/minecraft/profile/";
const API = "https://api.hypixel.net/v2";

/**
 * Endpoint TTLs. Global datasets are refreshed by workers, so the client's TTL
 * here is a floor that keeps a live read from re-fetching a snapshot the worker
 * is already maintaining.
 *
 * Two regimes, and the split is the policy's own:
 *
 * - **Player data — hours.** The Hypixel API policy asks for aggressive caching
 *   of player-specific data, and this is the control that actually delivers it:
 *   at a 6-hour TTL a member viewed twenty times a day costs four upstream
 *   reads, not twenty. The per-player limiter is a floor underneath this, not a
 *   substitute for it. These were 3–10 minutes, which is a freshness nobody
 *   asked for — a SkyBlock level does not move meaningfully inside an hour, let
 *   alone three minutes.
 * - **Market data — seconds to minutes.** Bazaar and auction-page reads are
 *   public, guild-agnostic, and one request serves every member at once, so they
 *   are not player polling in any sense and stay as short as the feature needs.
 *
 * `playerAuctions` sits in the first group despite being about the market: it is
 * addressed by player, so it counts as a read of that player.
 */
const TTL = {
  player: 6 * 60 * 60_000,
  profile: 6 * 60 * 60_000,
  museum: 12 * 60 * 60_000,
  playerAuctions: 6 * 60 * 60_000,
  guild: 5 * 60_000,
  resource: 6 * 60 * 60_000,
  bazaar: 90_000,
  auctionPage: 60_000,
  auctionsEnded: 90_000,
  election: 10 * 60_000,
  firesales: 5 * 60_000,
  bingo: 10 * 60_000,
} as const;

/** Thrown for truly exceptional upstream failures with no cached fallback. */
export class HypixelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HypixelUnavailableError";
  }
}

export interface HypixelClientOptions {
  readonly apiKey?: string;
  readonly http?: HttpFetcher;
  readonly cache?: HypixelCache;
  readonly rateGate?: RateGate;
  /**
   * The self-imposed per-player floor. Omitted means unlimited, which is the
   * right default for a unit test and the wrong one for a deployment — the
   * composition roots pass the configured limiter.
   */
  readonly playerLimiter?: PlayerRateLimiter;
  readonly logger: Logger;
  readonly sleep?: Sleeper;
  readonly maxRetries?: number;
  readonly playerTtlMs?: number;
}

/**
 * Per-call options on a player-scoped read.
 *
 * This is the *only* route to data fresher than the endpoint's TTL, and it
 * exists for one case: a member or an operator explicitly asking for a refresh.
 * Nothing scheduled passes it — a worker takes the default, because a worker
 * asking for fresher data than the cache holds is the polling pattern the TTLs
 * were raised to prevent.
 *
 * It relaxes the cache, not the cap: the per-player limiter still gates the
 * request that results, so a refresh button pressed twenty times in a minute
 * costs one upstream call at most.
 */
export interface PlayerReadOptions {
  /**
   * Accept a cached entry only if it was fetched within this many milliseconds.
   * Older than that and the read goes upstream even though the TTL has not
   * lapsed. Larger than the TTL has no effect — the TTL is still the ceiling.
   */
  readonly maxAgeMs?: number;
}

/** One cached endpoint read. `normalize` returning null means MISSING_PROFILE. */
interface CachedRequest<T> {
  readonly key: string;
  readonly url: string;
  readonly ttlMs: number;
  /** Used in error messages so a failure names the thing that failed. */
  readonly label: string;
  /**
   * Set on player-scoped reads, and only those. Its presence is what makes the
   * per-player limiter apply, so a new endpoint opts into the cap by naming the
   * player it is about rather than by remembering to call something.
   */
  readonly playerUuid?: string;
  /** See `PlayerReadOptions.maxAgeMs`. Absent means the TTL alone decides. */
  readonly maxAgeMs?: number;
  normalize(raw: unknown): T | null;
}

function envelope<T>(data: T, freshness: "LIVE" | "STALE", source: "LIVE" | "CACHE", fetchedAt?: string): DataEnvelope<T> {
  return { data, freshness, source, fetchedAt: fetchedAt ?? new Date().toISOString() };
}

/**
 * Whether a cache entry predates an explicit freshness request. Unparseable
 * timestamps read as fresh: a bad `fetchedAt` should not force an upstream call.
 */
function olderThan(fetchedAt: string, maxAgeMs: number | undefined): boolean {
  if (maxAgeMs === undefined) return false;
  const at = Date.parse(fetchedAt);
  return Number.isFinite(at) && Date.now() - at > maxAgeMs;
}

function backoffMs(attempt: number): number {
  const base = 200 * 2 ** attempt;
  return base + Math.floor(Math.random() * 100); // jitter
}

/** Absent or non-finite ⇒ unknown, never coerced to 0 (HYPIXEL_DATA_LAYER.md §5). */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export class HypixelClient implements HypixelSocialLookup {
  private readonly apiKey: string | undefined;
  private readonly http: HttpFetcher;
  private readonly cache: HypixelCache;
  private readonly rateGate: RateGate;
  private readonly playerLimiter: PlayerRateLimiter;
  private readonly log: Logger;
  private readonly sleep: Sleeper;
  private readonly maxRetries: number;
  private readonly playerTtlMs: number;
  /**
   * Single-flight: concurrent misses for the same key share one upstream call.
   * In-process rather than the Redis lock the doc describes — this collapses the
   * fan-out that actually happens (many interactions hitting one bot) without
   * making every cache miss pay a network round trip for a lock.
   */
  private readonly inflight = new Map<string, Promise<HypixelResult<unknown>>>();

  constructor(opts: HypixelClientOptions) {
    this.apiKey = opts.apiKey;
    this.http = opts.http ?? fetchHttp;
    this.cache = opts.cache ?? new InMemoryHypixelCache();
    this.rateGate = opts.rateGate ?? new InMemoryRateGate();
    this.playerLimiter = opts.playerLimiter ?? unlimitedPlayers;
    this.log = opts.logger.child({ service: "hypixel" });
    this.sleep = opts.sleep ?? realSleep;
    this.maxRetries = opts.maxRetries ?? 3;
    this.playerTtlMs = opts.playerTtlMs ?? TTL.player;
  }

  // ── The one request path ──────────────────────────────────────────────────

  private async cached<T>(req: CachedRequest<T>): Promise<HypixelResult<T>> {
    const hit = await this.cache.get<T>(req.key);
    if (hit && !hit.expired && !olderThan(hit.fetchedAt, req.maxAgeMs)) {
      return ok(envelope(hit.data, "LIVE", "CACHE", hit.fetchedAt));
    }

    const running = this.inflight.get(req.key);
    if (running) return running as Promise<HypixelResult<T>>;

    const pending = this.fetch(req, hit).finally(() => {
      this.inflight.delete(req.key);
    });
    this.inflight.set(req.key, pending as Promise<HypixelResult<unknown>>);
    return pending;
  }

  private async fetch<T>(
    req: CachedRequest<T>,
    hit: { data: T; fetchedAt: string } | null,
  ): Promise<HypixelResult<T>> {
    /** Stale-if-error: last-known data beats an error whenever we have it. */
    const stale = (): HypixelResult<T> | null =>
      hit ? ok(envelope(hit.data, "STALE", "CACHE", hit.fetchedAt)) : null;

    // The per-player floor comes first, and deliberately so. The shared gate is
    // about the fleet's budget; this is about a promise made to Hypixel that
    // does not bend when there happens to be budget going spare.
    //
    // A claim is spent on the *attempt*, not on a successful response: if the
    // request then fails, the slot stays consumed until the window rolls. That
    // is the conservative direction, and the only one that keeps the cap true —
    // releasing on failure would let a flapping endpoint be retried without
    // limit, which is exactly the pattern the cap exists to prevent. Stale cache
    // covers the user-visible cost.
    if (req.playerUuid !== undefined) {
      const claimed = await this.playerLimiter.claim(req.playerUuid).catch(() => true);
      if (!claimed) {
        const fallback = stale();
        if (fallback) {
          this.log.debug("serving stale data (per-player window)", { key: req.key });
          return fallback;
        }
        return hypixelFailure("RATE_LIMITED");
      }
    }

    const gate = await this.rateGate.acquire();
    if (!gate.allowed) {
      const fallback = stale();
      if (fallback) {
        this.log.warn("serving stale data (rate-limited)", { key: req.key });
        return fallback;
      }
      return gate.retryAfterMs !== undefined
        ? hypixelFailure("RATE_LIMITED", { retryAfterMs: gate.retryAfterMs })
        : hypixelFailure("RATE_LIMITED");
    }

    const headers = this.apiKey ? { "API-Key": this.apiKey } : {};

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let res;
      try {
        res = await this.http.get(req.url, headers);
      } catch (error) {
        if (attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        return (
          stale() ??
          this.unavailable(req, error instanceof Error ? error.message : "network error")
        );
      }

      this.rateGate.observe(res.headers, res.status);

      if (res.status === 200) {
        const dto = req.normalize(res.json);
        // Well-formed response carrying no data — a real answer, not a failure.
        if (dto === null) return hypixelFailure("MISSING_PROFILE");
        await this.cache.set(req.key, dto, req.ttlMs);
        return ok(envelope(dto, "LIVE", "LIVE"));
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        const fallback = stale();
        if (fallback) return fallback;
        if (res.status === 429) return hypixelFailure("RATE_LIMITED");
        return this.unavailable(req, `status ${res.status}`);
      }

      // Auth/permission problems are permanent: retrying just burns budget.
      if (res.status === 403 || res.status === 401) {
        return hypixelFailure("API_DISABLED", { message: "invalid or missing API key" });
      }
      return stale() ?? this.unavailable(req, `status ${res.status}`);
    }

    return hypixelFailure("RATE_LIMITED");
  }

  private unavailable(req: CachedRequest<unknown>, detail: string): never {
    throw new HypixelUnavailableError(`Hypixel request failed for ${req.label} (${detail})`);
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  /** Resolve an IGN to a (undashed) UUID via Mojang. Returns null if the name doesn't exist. */
  async resolveUuid(ign: string): Promise<{ uuid: string; name: string } | null> {
    const res = await this.http.get(MOJANG_PROFILE_URL + encodeURIComponent(ign));
    if (res.status === 200) {
      const profile = res.json as RawMojangProfile;
      if (profile.id) return { uuid: profile.id, name: profile.name ?? ign };
      return null;
    }
    if (res.status === 204 || res.status === 404) return null;
    throw new HypixelUnavailableError(`Mojang lookup failed for "${ign}" (status ${res.status})`);
  }

  /**
   * The reverse: a (undashed) UUID to its current IGN, or null if Mojang has no
   * profile for it.
   *
   * Mojang's session server rather than the Hypixel player endpoint, because the
   * guild scan resolves names in batches and a name is not worth spending the
   * Hypixel budget on. Throws on an unexpected status so the caller can treat an
   * outage as "not resolved yet" rather than "this account has no name" — the
   * two would otherwise be indistinguishable, and the second is written down.
   */
  async resolveIgn(uuid: string): Promise<string | null> {
    const res = await this.http.get(MOJANG_SESSION_URL + encodeURIComponent(uuid));
    if (res.status === 200) {
      const profile = res.json as RawMojangProfile;
      return profile.name ?? null;
    }
    if (res.status === 204 || res.status === 404) return null;
    throw new HypixelUnavailableError(`Mojang name lookup failed for "${uuid}" (status ${res.status})`);
  }

  /**
   * HypixelSocialLookup: read the in-game Discord social field for an IGN.
   *
   * Exactly two upstream reads, always: Mojang for the uuid, then the Hypixel
   * player object. **There is deliberately no fallback route**, and the absence
   * is the point rather than an omission. A name that Mojang does not know is a
   * name that does not exist — which is what a nick looks like from here — and
   * the obvious next moves (scan the guild roster for a similar name, search
   * active auctions, walk recent chat) would all amount to working out who is
   * behind the nick. The Hypixel policy prohibits de-anonymising nicked players,
   * and "we only did it to help them link" is not an exception to that.
   *
   * So an inconclusive lookup stays inconclusive: `IGN_NOT_FOUND` when Mojang
   * has nothing, and a thrown `HypixelUnavailableError` when Hypixel will not
   * answer. Both are honest, and neither identifies anybody.
   */
  async getLinkedDiscord(ign: string): Promise<HypixelSocialResult> {
    const resolved = await this.resolveUuid(ign);
    if (!resolved) return { kind: "IGN_NOT_FOUND" };

    const player = await this.getPlayer(resolved.uuid);
    if (player.ok) {
      return {
        kind: "FOUND",
        uuid: resolved.uuid,
        ign: resolved.name,
        discordId: player.value.data.discordSocial,
      };
    }

    // Account resolves but has no Hypixel profile ⇒ social field is effectively unset.
    if (player.error.state === "MISSING_PROFILE") {
      return { kind: "FOUND", uuid: resolved.uuid, ign: resolved.name, discordId: null };
    }

    // RATE_LIMITED / API_DISABLED: not a linking verdict — surface as unavailable.
    throw new HypixelUnavailableError(`Cannot read Hypixel social for "${ign}" (${player.error.state})`);
  }

  // ── Player-scoped (live, cached on demand) ────────────────────────────────

  async getPlayer(uuid: string, opts?: PlayerReadOptions): Promise<HypixelResult<HypixelPlayerDTO>> {
    return this.cached<HypixelPlayerDTO>({
      key: `player:${uuid}`,
      url: `${API}/player?uuid=${uuid}`,
      ttlMs: this.playerTtlMs,
      label: `player ${uuid}`,
      playerUuid: `${uuid}:player`,
      ...(opts?.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {}),
      normalize: (raw) => {
        const body = raw as RawHypixelPlayerResponse;
        return body.success && body.player ? normalizePlayer(uuid, body.player) : null;
      },
    });
  }

  /** Fetch the member's selected Skyblock profile. */
  /**
   * Every profile on the account. This is the cached unit rather than the
   * selected profile alone: Hypixel returns them all in one response, so caching
   * the list lets `/profile`, `/setprofile` and a plain `/stats` share a single
   * upstream call instead of one each.
   */
  async getSkyblockProfiles(
    uuid: string,
    opts?: PlayerReadOptions,
  ): Promise<HypixelResult<readonly SkyblockProfileDTO[]>> {
    return this.cached<readonly SkyblockProfileDTO[]>({
      key: `sbprofiles:${uuid}`,
      url: `${API}/skyblock/profiles?uuid=${uuid}`,
      ttlMs: TTL.profile,
      label: `skyblock profiles ${uuid}`,
      playerUuid: `${uuid}:profiles`,
      ...(opts?.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {}),
      normalize: (raw) => {
        const body = raw as RawSkyblockProfilesResponse;
        const profiles = body.success ? body.profiles ?? [] : [];
        const out = profiles
          .map((p) => normalizeProfile(uuid, p))
          .filter((p): p is SkyblockProfileDTO => p !== null);
        return out.length === 0 ? null : out;
      },
    });
  }

  /**
   * One profile: the named one if `profileId` is given (id or cute name, since
   * that is what a member types), otherwise the account's selected profile.
   */
  async getSkyblockProfile(
    uuid: string,
    profileId?: string,
    opts?: PlayerReadOptions,
  ): Promise<HypixelResult<SkyblockProfileDTO>> {
    const all = await this.getSkyblockProfiles(uuid, opts);
    if (!all.ok) return err(all.error);

    const list = all.value.data;
    const wanted = profileId?.toLowerCase();
    const chosen = wanted
      ? list.find((p) => p.profileId.toLowerCase() === wanted || p.cuteName?.toLowerCase() === wanted)
      : list.find((p) => p.selected) ?? list[0];

    if (!chosen) return hypixelFailure("MISSING_PROFILE");
    return ok({ ...all.value, data: chosen });
  }

  /**
   * Museum contents for a profile. Fetched separately and only when a command
   * needs an exact valuation — it is the difference between "≥ X" and an exact
   * networth, and it costs a second call per profile.
   */
  async getMuseum(profileId: string, opts?: PlayerReadOptions): Promise<HypixelResult<MuseumDTO>> {
    return this.cached<MuseumDTO>({
      key: `museum:${profileId}`,
      url: `${API}/skyblock/museum?profile=${profileId}`,
      ttlMs: TTL.museum,
      label: `museum ${profileId}`,
      // Keyed by profile because that is the only identifier this endpoint
      // takes. A profile belongs to one account, so the claim is still
      // per-player in effect.
      playerUuid: `${profileId}:museum`,
      ...(opts?.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {}),
      normalize: (raw) => {
        const body = raw as RawMuseumResponse;
        if (!body.success || !body.members) return null;
        return { profileId, members: body.members };
      },
    });
  }

  /**
   * Guild by its Hypixel id, by a member's uuid when `by` is "player", or by its
   * name when `by` is "name".
   *
   * The name form is what onboarding uses: an admin linking a guild knows what
   * it is called and has no reason to have ever seen its 24-character id.
   *
   * Encoded rather than interpolated raw, because a guild name is the one
   * lookup key here that is free text — spaces and `&` are ordinary in one, and
   * either would otherwise produce a URL that queries something else entirely.
   */
  async getGuild(id: string, by: "id" | "player" | "name" = "id"): Promise<HypixelResult<GuildDTO>> {
    return this.cached<GuildDTO>({
      key: `guild:${by}:${id}`,
      url: `${API}/guild?${by}=${encodeURIComponent(id)}`,
      ttlMs: TTL.guild,
      label: `guild ${by}=${id}`,
      normalize: (raw) => {
        const body = raw as RawGuildResponse;
        return body.success && body.guild ? normalizeGuild(body.guild) : null;
      },
    });
  }

  // ── Global datasets (worker-primary; these reads serve the cache) ──────────

  /**
   * Bazaar quick-status for every product. One large object, so commands should
   * prefer the per-item cache the pricing jobs derive from this.
   */
  async getBazaar(): Promise<HypixelResult<BazaarDTO>> {
    return this.cached<BazaarDTO>({
      key: "bazaar",
      url: `${API}/skyblock/bazaar`,
      ttlMs: TTL.bazaar,
      label: "bazaar",
      normalize: (raw) => {
        const body = raw as RawBazaarResponse;
        if (!body.success || !body.products) return null;
        const products: Record<string, BazaarProductDTO> = {};
        for (const [id, product] of Object.entries(body.products)) {
          const q = product.quick_status;
          products[id] = {
            productId: product.product_id ?? id,
            instantBuy: num(q?.buyPrice),
            instantSell: num(q?.sellPrice),
            buyVolume: num(q?.buyVolume),
            sellVolume: num(q?.sellVolume),
          };
        }
        return { lastUpdated: num(body.lastUpdated), products };
      },
    });
  }

  /**
   * One page of the auction house.
   *
   * Callers must be workers: a full sweep is hundreds of pages, and
   * HYPIXEL_DATA_LAYER.md forbids paginating the AH inside a command handler.
   * The page count comes back in the DTO so a sweep can drive its own loop.
   */
  async getAuctions(page = 0): Promise<HypixelResult<AuctionPageDTO>> {
    return this.cached<AuctionPageDTO>({
      key: `auctions:${page}`,
      url: `${API}/skyblock/auctions?page=${page}`,
      ttlMs: TTL.auctionPage,
      label: `auctions page ${page}`,
      normalize: (raw) => {
        const body = raw as RawAuctionsResponse;
        if (!body.success) return null;
        return {
          page: num(body.page) ?? page,
          totalPages: num(body.totalPages) ?? 0,
          totalAuctions: num(body.totalAuctions) ?? 0,
          lastUpdated: num(body.lastUpdated),
          auctions: (body.auctions ?? []).map(normalizeAuction),
        };
      },
    });
  }

  /**
   * A single player's active auctions. Unlike a sweep this is one request, so
   * `/auctions player:<ign>` can call it live — the AH-wide equivalent cannot.
   */
  async getPlayerAuctions(uuid: string): Promise<HypixelResult<readonly AuctionDTO[]>> {
    return this.cached<readonly AuctionDTO[]>({
      key: `auctions:player:${uuid}`,
      url: `${API}/skyblock/auction?player=${uuid}`,
      // A player-scoped read despite being about the market, so it takes the
      // player TTL rather than the auction-page one. `ah-sweep` is where
      // market-wide freshness comes from; this endpoint answers "what has *this
      // person* listed", which is a question about a player.
      ttlMs: TTL.playerAuctions,
      label: `player auctions ${uuid}`,
      playerUuid: `${uuid}:auctions`,
      normalize: (raw) => {
        const body = raw as RawAuctionsResponse;
        if (!body.success) return null;
        // An empty list is a real answer ("nothing listed"), so it must not
        // normalize to null — that would be reported as a missing player.
        return (body.auctions ?? []).map(normalizeAuction);
      },
    });
  }

  /** Recently sold auctions — the sold-price signal the pricing blend uses. */
  async getEndedAuctions(): Promise<HypixelResult<EndedAuctionsDTO>> {
    return this.cached<EndedAuctionsDTO>({
      key: "auctions:ended",
      url: `${API}/skyblock/auctions_ended`,
      ttlMs: TTL.auctionsEnded,
      label: "ended auctions",
      normalize: (raw) => {
        const body = raw as RawEndedAuctionsResponse;
        if (!body.success) return null;
        const auctions: EndedAuctionDTO[] = (body.auctions ?? []).map((a) => {
          // Decoding here rather than in the job keeps the wire format inside
          // the client � everything downstream sees a normalized item id.
          const item = a.item_bytes ? decodeItemBytes(a.item_bytes) : null;
          return {
            auctionId: a.auction_id ?? "",
            sellerUuid: str(a.seller),
            buyerUuid: str(a.buyer),
            price: num(a.price),
            bin: a.bin === true,
            soldAt: num(a.timestamp),
            itemId: item?.itemId ?? null,
            itemName: item?.itemName ?? null,
            count: item?.count ?? 1,
          };
        });
        return { lastUpdated: num(body.lastUpdated), auctions };
      },
    });
  }

  /** Current mayor + running election. Null mayor is normal between terms. */
  async getElection(): Promise<HypixelResult<ElectionDTO>> {
    return this.cached<ElectionDTO>({
      key: "election",
      url: `${API}/resources/skyblock/election`,
      ttlMs: TTL.election,
      label: "election",
      normalize: (raw) => {
        const body = raw as RawElectionResponse;
        if (!body.success) return null;
        const mayor = body.mayor;
        return {
          lastUpdated: num(body.lastUpdated),
          mayor: mayor
            ? {
                key: str(mayor.key),
                name: str(mayor.name),
                perks: (mayor.perks ?? []).map((p) => str(p.name)).filter((n): n is string => n !== null),
              }
            : null,
          ministerName: str(mayor?.minister?.name),
          electionYear: num(body.current?.year),
          candidates: (body.current?.candidates ?? []).map((c) => ({
            name: str(c.name),
            votes: num(c.votes),
          })),
        };
      },
    });
  }

  async getFiresales(): Promise<HypixelResult<FiresalesDTO>> {
    return this.cached<FiresalesDTO>({
      key: "firesales",
      url: `${API}/skyblock/firesales`,
      ttlMs: TTL.firesales,
      label: "firesales",
      normalize: (raw) => {
        const body = raw as RawFiresalesResponse;
        if (!body.success) return null;
        return {
          sales: (body.sales ?? []).map((s) => ({
            itemId: str(s.item_id),
            startsAt: num(s.start),
            endsAt: num(s.end),
            amount: num(s.amount),
            price: num(s.price),
          })),
        };
      },
    });
  }

  async getBingo(): Promise<HypixelResult<BingoDTO>> {
    return this.cached<BingoDTO>({
      key: "bingo",
      url: `${API}/resources/skyblock/bingo`,
      ttlMs: TTL.bingo,
      label: "bingo",
      normalize: (raw) => {
        const body = raw as RawBingoResponse;
        if (!body.success) return null;
        return {
          id: num(body.id),
          name: str(body.name),
          startsAt: num(body.start),
          endsAt: num(body.end),
          goals: (body.goals ?? []).map((g) => ({
            id: str(g.id),
            name: str(g.name),
            lore: str(g.lore),
            requiredAmount: num(g.requiredAmount),
          })),
        };
      },
    });
  }

  /**
   * Reference data under `resources/skyblock/{name}` — `skills`, `collections`,
   * `items`, and friends. Cached for hours: it changes on game updates, not on
   * player activity.
   */
  async getResources(name: string): Promise<HypixelResult<ResourceDTO>> {
    return this.cached<ResourceDTO>({
      key: `resource:${name}`,
      url: `${API}/resources/skyblock/${encodeURIComponent(name)}`,
      ttlMs: TTL.resource,
      label: `resource ${name}`,
      normalize: (raw) => {
        if (typeof raw !== "object" || raw === null) return null;
        const body = raw as Record<string, unknown> & { success?: boolean; lastUpdated?: number };
        if (body.success === false) return null;
        return { name, lastUpdated: num(body.lastUpdated), data: body };
      },
    });
  }
}

// ── Normalization ───────────────────────────────────────────────────────────

function normalizePlayer(uuid: string, raw: RawHypixelPlayer): HypixelPlayerDTO {
  const discord = raw.socialMedia?.links?.DISCORD;
  return {
    uuid,
    ign: raw.displayname ?? null,
    // Unknown ⇒ null, never coerced.
    discordSocial: discord && discord.length > 0 ? discord : null,
    firstLoginMs: epoch(raw.firstLogin),
    lastLoginMs: epoch(raw.lastLogin),
  };
}

/** A usable epoch timestamp, or null. Tolerates absent and nonsensical alike. */
function epoch(ms: number | undefined): number | null {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : null;
}

const GAME_MODES: Record<string, SkyblockProfileDTO["gameMode"]> = {
  ironman: "IRONMAN",
  island: "STRANDED",
  bingo: "BINGO",
};

function normalizeProfile(uuid: string, chosen: RawSkyblockProfile): SkyblockProfileDTO | null {
  if (!chosen.profile_id) return null;

  const member = chosen.members?.[uuid] ?? {};
  const readable: string[] = ["bank"]; // banking balance always available on the profile
  if ("inv_contents" in member || "inventory" in member) readable.push("inventory");
  if ("inv_armor" in member || "inventory" in member) readable.push("armor");

  return {
    profileId: chosen.profile_id,
    cuteName: chosen.cute_name ?? null,
    gameMode: chosen.game_mode ? GAME_MODES[chosen.game_mode] ?? "NORMAL" : "NORMAL",
    selected: chosen.selected === true,
    member,
    bankBalance: typeof chosen.banking?.balance === "number" ? chosen.banking.balance : null,
    readableSections: readable,
  };
}

function normalizeAuction(raw: RawAuction): AuctionDTO {
  const bin = raw.bin === true;
  return {
    auctionId: raw.uuid ?? "",
    sellerUuid: str(raw.auctioneer),
    itemName: str(raw.item_name),
    tier: str(raw.tier),
    category: str(raw.category),
    bin,
    // A BIN's ask never moves; an auction's live price is the standing bid, and
    // falls back to the opening bid while nobody has bid yet.
    price: bin ? num(raw.starting_bid) : num(raw.highest_bid_amount) || num(raw.starting_bid),
    endsAt: num(raw.end),
    // A BIN that sold reports its ask as the winning bid, so this is the amount
    // waiting to be collected either way.
    highestBid: (num(raw.highest_bid_amount) ?? 0) > 0 ? num(raw.highest_bid_amount) : null,
    claimed: raw.claimed === true,
  };
}

function normalizeGuild(raw: RawGuild): GuildDTO {
  const ranks = [...(raw.ranks ?? [])]
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .map((r) => str(r.name))
    .filter((n): n is string => n !== null);

  return {
    id: raw._id ?? "",
    name: str(raw.name),
    tag: str(raw.tag),
    tagColor: str(raw.tagColor),
    createdAt: num(raw.created),
    members: (raw.members ?? [])
      .filter((m) => typeof m.uuid === "string")
      .map((m) => {
        const expHistory = normalizeExpHistory(m.expHistory);
        return {
          uuid: m.uuid as string,
          rank: str(m.rank),
          joinedAt: num(m.joined),
          expHistory,
          weeklyGexp: Object.values(expHistory).reduce((sum, n) => sum + n, 0),
        };
      }),
    ranks,
  };
}

/** Hypixel day keys, matched strictly so a shape change reads as absent, not as a day. */
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Coerce `expHistory` into a plain day→number map.
 *
 * The field is absent for guilds whose API access is off and has been seen
 * carrying non-numeric junk, so anything unrecognised is dropped rather than
 * propagated: a bad key here would otherwise become a bad `GuildGexpDaily` row
 * that the XP system then treats as fact.
 */
function normalizeExpHistory(raw: RawGuildMember["expHistory"]): Record<string, number> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [day, value] of Object.entries(raw)) {
    if (!DAY_KEY.test(day)) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    out[day] = Math.floor(value);
  }
  return out;
}
