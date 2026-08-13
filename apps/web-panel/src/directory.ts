/**
 * The panel's client for the admin bot's internal API — the thing that lets a
 * config page offer "#general" in a dropdown instead of a box wanting
 * `1234567890123456789`.
 *
 * The panel process holds no Discord gateway connection and is not going to get
 * one: a second client would mean a second privileged intent, a second identity
 * in the member list, and a cache that disagrees with the bot's. So the bot —
 * which already has all three — answers over loopback, and this file is the
 * typed caller.
 *
 * Two rules shape everything here:
 *
 * 1. **It never fails hard.** Bot down, token wrong, request slow: the answer is
 *    `available: false` with an empty list, and the control falls back to the
 *    raw-id field the panel had before pickers existed. A picker is a
 *    convenience; losing it must not take a settings page with it.
 * 2. **It caches.** A picker fetches on every keystroke. Redis absorbs that so a
 *    typing operator costs the bot — and Discord — nothing.
 */
import type {
  DirectoryChannel,
  DirectoryMember,
  DirectoryRole,
  DirectorySource,
} from "@sbr/panel-core";
import { getJson, getRedis, setJson } from "@sbr/redis";
import type { Logger } from "@sbr/observability";

/**
 * Short, because this sits in front of a live gateway cache. A channel created
 * thirty seconds ago appearing in the picker is worth more than the handful of
 * loopback requests this saves, and the per-keystroke case is already absorbed
 * inside the window.
 */
const CACHE_TTL_S = 60;

/**
 * The bot answers from memory, so a slow response means it is wedged, not busy.
 * Waiting longer would only hold the picker's spinner open on a request that is
 * not going to arrive.
 */
const TIMEOUT_MS = 3_000;

/** Keeps a pathological `?q=` out of the key space. */
const MAX_QUERY = 64;

interface DirectoryDeps {
  /** Where the bot listens; loopback unless the two are deployed apart. */
  readonly baseUrl: string;
  /** Absent means the bot isn't serving — every read reports unavailable. */
  readonly token: string | undefined;
  readonly logger: Logger;
}

type Resource = "channels" | "roles" | "members";

interface Answer<T> {
  readonly available: boolean;
  readonly rows: readonly T[];
}

const UNAVAILABLE = { available: false, rows: [] } as const;

/**
 * Live-fetch + cache, with the cache written only on success.
 *
 * Caching a failure would turn a two-second bot restart into a minute of dead
 * pickers, so an unavailable answer is recomputed on the next request — which is
 * also what makes the picker come back on its own once the bot returns.
 */
export function createBotDirectory(deps: DirectoryDeps): DirectorySource {
  const log = deps.logger.child({ service: "directory" });
  const base = deps.baseUrl.replace(/\/+$/, "");

  async function read<T>(guildId: string, resource: Resource, rawQuery: string): Promise<Answer<T>> {
    if (deps.token === undefined) return UNAVAILABLE;
    const q = rawQuery.trim().slice(0, MAX_QUERY);

    const ctx = await getRedis();
    const key = ctx.keys.directory(guildId, resource, q);

    // A cache miss and an unreachable Redis are the same situation here — go to
    // the bot — so the read is allowed to fail without taking the picker down.
    const cached = await getJson<readonly T[]>(key).catch(() => null);
    if (cached !== null && Array.isArray(cached)) return { available: true, rows: cached };

    const url = `${base}/internal/g/${encodeURIComponent(guildId)}/${resource}${
      q.length > 0 ? `?q=${encodeURIComponent(q)}` : ""
    }`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${deps.token}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        // 401 is a misconfiguration an operator has to fix and would otherwise
        // present only as "the dropdown is always empty", so it is named.
        log.warn("directory request refused", {
          guildId,
          resource,
          status: res.status,
          hint: res.status === 401 ? "INTERNAL_API_TOKEN differs between the panel and the bot" : undefined,
        });
        return UNAVAILABLE;
      }
      const body = (await res.json()) as Record<string, unknown>;
      const rows = body[resource];
      if (!Array.isArray(rows)) return UNAVAILABLE;

      await setJson(key, rows, CACHE_TTL_S).catch(() => undefined);
      return { available: true, rows: rows as readonly T[] };
    } catch (error: unknown) {
      // Includes the abort. Debug rather than warn: with the bot deliberately
      // not running — a panel-only dev box — this would otherwise log on every
      // keystroke to say something the operator already knows.
      log.debug("directory request failed", {
        guildId,
        resource,
        error: error instanceof Error ? error.message : "unknown",
      });
      return UNAVAILABLE;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    channels: (guildId, q) => read<DirectoryChannel>(guildId, "channels", q),
    roles: (guildId, q) => read<DirectoryRole>(guildId, "roles", q),
    members: (guildId, q) => read<DirectoryMember>(guildId, "members", q),
  };
}

/**
 * How a panel-issued punishment reaches Discord itself.
 *
 * Until this existed, `moderation.action` wrote an audit row and a Redis mirror
 * and stopped: a ban issued from the panel banned nobody, and the page said it
 * had worked. The mirror is still what the relay reads — this is the other half,
 * the part that removes a person from the server.
 *
 * Only the bot can do it (it is the process holding the gateway), so the panel
 * asks. Unlike the pickers, a failure here is *not* cosmetic, so every outcome
 * is returned rather than swallowed and the caller decides what to say.
 */
export interface DiscordEnforcer {
  enforce(guildId: string, request: EnforceRequest): Promise<EnforceOutcome>;
}

export interface EnforceRequest {
  readonly type: "KICK" | "BAN" | "UNBAN" | "TIMEOUT" | "UNTIMEOUT";
  readonly userId: string;
  readonly reason: string;
  readonly durationSeconds: number | null;
}

export type EnforceOutcome =
  | { readonly ok: true }
  /** `UNAVAILABLE` means the bot never answered; anything else is Discord's own refusal. */
  | { readonly ok: false; readonly error: string };

/**
 * Discord's own limit, restated here so the panel can explain it instead of
 * letting the request come back as a bare 400 from the gateway.
 */
export const MAX_TIMEOUT_SECONDS = 28 * 24 * 60 * 60;

export function createDiscordEnforcer(deps: DirectoryDeps): DiscordEnforcer {
  const log = deps.logger.child({ service: "enforcer" });
  const base = deps.baseUrl.replace(/\/+$/, "");

  return {
    async enforce(guildId, request) {
      if (deps.token === undefined) return { ok: false, error: "UNAVAILABLE" };

      const controller = new AbortController();
      // Longer than a picker's budget: this one is a live Discord API call
      // behind the loopback hop, not a read from a cache in memory.
      const timer = setTimeout(() => controller.abort(), ENFORCE_TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/internal/g/${encodeURIComponent(guildId)}/enforce`, {
          method: "POST",
          headers: { authorization: `Bearer ${deps.token}`, "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
        if (!res.ok) {
          log.warn("enforcement request refused", { guildId, status: res.status });
          return { ok: false, error: res.status === 401 ? "UNAUTHORIZED" : `HTTP_${res.status}` };
        }
        const body = (await res.json()) as { ok?: unknown; error?: unknown };
        if (body.ok === true) return { ok: true };
        return { ok: false, error: typeof body.error === "string" ? body.error : "FAILED" };
      } catch (error: unknown) {
        // Warn, not debug — the picker's quiet failure is a missing dropdown,
        // this one is a punishment that did not happen.
        log.warn("enforcement request failed", {
          guildId,
          type: request.type,
          error: error instanceof Error ? error.message : "unknown",
        });
        return { ok: false, error: "UNAVAILABLE" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

const ENFORCE_TIMEOUT_MS = 8_000;
