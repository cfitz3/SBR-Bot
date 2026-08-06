/**
 * HypixelClient — the single centralized entry point for Hypixel/Mojang calls
 * (HYPIXEL_DATA_LAYER.md). One request path:
 *   cache lookup → rate-limit gate → HTTP → header ingest → retry/backoff
 *   → normalize → cache set → typed HypixelResult.
 *
 * Implements HypixelSocialLookup so it finishes the /link flow (slice 1).
 */
import {
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
import { realSleep, type HttpFetcher, type HypixelCache, type RateGate, type Sleeper } from "./ports.js";
import type {
  HypixelPlayerDTO,
  RawHypixelPlayer,
  RawHypixelPlayerResponse,
  RawMojangProfile,
  RawSkyblockProfile,
  RawSkyblockProfilesResponse,
  SkyblockProfileDTO,
} from "./types.js";

const MOJANG_PROFILE_URL = "https://api.mojang.com/users/profiles/minecraft/";
const HYPIXEL_PLAYER_URL = "https://api.hypixel.net/v2/player?uuid=";
const HYPIXEL_SB_PROFILES_URL = "https://api.hypixel.net/v2/skyblock/profiles?uuid=";

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
  readonly logger: Logger;
  readonly sleep?: Sleeper;
  readonly maxRetries?: number;
  readonly playerTtlMs?: number;
}

function envelope<T>(data: T, freshness: "LIVE" | "STALE", source: "LIVE" | "CACHE", fetchedAt?: string): DataEnvelope<T> {
  return { data, freshness, source, fetchedAt: fetchedAt ?? new Date().toISOString() };
}

function backoffMs(attempt: number): number {
  const base = 200 * 2 ** attempt;
  return base + Math.floor(Math.random() * 100); // jitter
}

export class HypixelClient implements HypixelSocialLookup {
  private readonly apiKey: string | undefined;
  private readonly http: HttpFetcher;
  private readonly cache: HypixelCache;
  private readonly rateGate: RateGate;
  private readonly log: Logger;
  private readonly sleep: Sleeper;
  private readonly maxRetries: number;
  private readonly playerTtlMs: number;

  constructor(opts: HypixelClientOptions) {
    this.apiKey = opts.apiKey;
    this.http = opts.http ?? fetchHttp;
    this.cache = opts.cache ?? new InMemoryHypixelCache();
    this.rateGate = opts.rateGate ?? new InMemoryRateGate();
    this.log = opts.logger.child({ service: "hypixel" });
    this.sleep = opts.sleep ?? realSleep;
    this.maxRetries = opts.maxRetries ?? 3;
    this.playerTtlMs = opts.playerTtlMs ?? 3 * 60 * 1000;
  }

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

  /** Fetch a player by UUID with caching, rate-limiting, retries, and typed fallbacks. */
  async getPlayer(uuid: string): Promise<HypixelResult<HypixelPlayerDTO>> {
    const key = `player:${uuid}`;

    const cached = await this.cache.get<HypixelPlayerDTO>(key);
    if (cached && !cached.expired) {
      return ok(envelope(cached.data, "LIVE", "CACHE", cached.fetchedAt));
    }

    const gate = await this.rateGate.acquire();
    if (!gate.allowed) {
      if (cached) {
        this.log.warn("serving stale player (rate-limited)", { uuid });
        return ok(envelope(cached.data, "STALE", "CACHE", cached.fetchedAt));
      }
      return gate.retryAfterMs !== undefined
        ? hypixelFailure("RATE_LIMITED", { retryAfterMs: gate.retryAfterMs })
        : hypixelFailure("RATE_LIMITED");
    }

    const headers = this.apiKey ? { "API-Key": this.apiKey } : {};

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let res;
      try {
        res = await this.http.get(HYPIXEL_PLAYER_URL + uuid, headers);
      } catch (error) {
        if (attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        if (cached) return ok(envelope(cached.data, "STALE", "CACHE", cached.fetchedAt));
        throw new HypixelUnavailableError(
          `Hypixel request failed for ${uuid}: ${error instanceof Error ? error.message : "network error"}`,
        );
      }

      this.rateGate.observe(res.headers, res.status);

      if (res.status === 200) {
        const body = res.json as RawHypixelPlayerResponse;
        if (body.success && body.player) {
          const dto = normalizePlayer(uuid, body.player);
          await this.cache.set(key, dto, this.playerTtlMs);
          return ok(envelope(dto, "LIVE", "LIVE"));
        }
        // Valid response, but the player has no Hypixel data.
        return hypixelFailure("MISSING_PROFILE");
      }

      if (res.status === 429) {
        if (attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        if (cached) return ok(envelope(cached.data, "STALE", "CACHE", cached.fetchedAt));
        return hypixelFailure("RATE_LIMITED");
      }

      if (res.status >= 500) {
        if (attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        if (cached) return ok(envelope(cached.data, "STALE", "CACHE", cached.fetchedAt));
        throw new HypixelUnavailableError(`Hypixel returned ${res.status} for ${uuid}`);
      }

      // 4xx (bad key / bad request): don't retry.
      if (res.status === 403) return hypixelFailure("API_DISABLED", { message: "invalid or missing API key" });
      if (cached) return ok(envelope(cached.data, "STALE", "CACHE", cached.fetchedAt));
      throw new HypixelUnavailableError(`Hypixel returned ${res.status} for ${uuid}`);
    }

    // Unreachable, but satisfies the type checker.
    return hypixelFailure("RATE_LIMITED");
  }

  /** Fetch the member's selected Skyblock profile (cached, rate-limited, retried). */
  async getSkyblockProfile(uuid: string): Promise<HypixelResult<SkyblockProfileDTO>> {
    const key = `sbprofile:${uuid}`;

    const cached = await this.cache.get<SkyblockProfileDTO>(key);
    if (cached && !cached.expired) return ok(envelope(cached.data, "LIVE", "CACHE", cached.fetchedAt));

    const gate = await this.rateGate.acquire();
    if (!gate.allowed) {
      if (cached) return ok(envelope(cached.data, "STALE", "CACHE", cached.fetchedAt));
      return gate.retryAfterMs !== undefined
        ? hypixelFailure("RATE_LIMITED", { retryAfterMs: gate.retryAfterMs })
        : hypixelFailure("RATE_LIMITED");
    }

    const headers = this.apiKey ? { "API-Key": this.apiKey } : {};

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let res;
      try {
        res = await this.http.get(HYPIXEL_SB_PROFILES_URL + uuid, headers);
      } catch (error) {
        if (attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        if (cached) return ok(envelope(cached.data, "STALE", "CACHE", cached.fetchedAt));
        throw new HypixelUnavailableError(
          `Hypixel profiles request failed for ${uuid}: ${error instanceof Error ? error.message : "network error"}`,
        );
      }

      this.rateGate.observe(res.headers, res.status);

      if (res.status === 200) {
        const body = res.json as RawSkyblockProfilesResponse;
        const profiles = body.success ? body.profiles ?? [] : [];
        if (profiles.length === 0) return hypixelFailure("MISSING_PROFILE");
        const dto = normalizeProfile(uuid, profiles);
        if (!dto) return hypixelFailure("MISSING_PROFILE");
        await this.cache.set(key, dto, this.playerTtlMs);
        return ok(envelope(dto, "LIVE", "LIVE"));
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        if (cached) return ok(envelope(cached.data, "STALE", "CACHE", cached.fetchedAt));
        if (res.status === 429) return hypixelFailure("RATE_LIMITED");
        throw new HypixelUnavailableError(`Hypixel returned ${res.status} for ${uuid}`);
      }

      if (res.status === 403) return hypixelFailure("API_DISABLED", { message: "invalid or missing API key" });
      if (cached) return ok(envelope(cached.data, "STALE", "CACHE", cached.fetchedAt));
      throw new HypixelUnavailableError(`Hypixel returned ${res.status} for ${uuid}`);
    }

    return hypixelFailure("RATE_LIMITED");
  }

  /** HypixelSocialLookup: read the in-game Discord social field for an IGN. */
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
}

function normalizePlayer(uuid: string, raw: RawHypixelPlayer): HypixelPlayerDTO {
  const discord = raw.socialMedia?.links?.DISCORD;
  return {
    uuid,
    ign: raw.displayname ?? null,
    // Unknown ⇒ null, never coerced.
    discordSocial: discord && discord.length > 0 ? discord : null,
  };
}

const GAME_MODES: Record<string, SkyblockProfileDTO["gameMode"]> = {
  ironman: "IRONMAN",
  island: "STRANDED",
  bingo: "BINGO",
};

function normalizeProfile(uuid: string, profiles: readonly RawSkyblockProfile[]): SkyblockProfileDTO | null {
  const chosen = profiles.find((p) => p.selected) ?? profiles[0];
  if (!chosen || !chosen.profile_id) return null;

  const member = chosen.members?.[uuid] ?? {};
  const readable: string[] = ["bank"]; // banking balance always available on the profile
  if ("inv_contents" in member || "inventory" in member) readable.push("inventory");
  if ("inv_armor" in member || "inventory" in member) readable.push("armor");

  return {
    profileId: chosen.profile_id,
    cuteName: chosen.cute_name ?? null,
    gameMode: chosen.game_mode ? GAME_MODES[chosen.game_mode] ?? "NORMAL" : "NORMAL",
    member,
    bankBalance: typeof chosen.banking?.balance === "number" ? chosen.banking.balance : null,
    readableSections: readable,
  };
}
