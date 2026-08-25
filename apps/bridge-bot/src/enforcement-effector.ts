/**
 * The bridge bot's client for the admin bot's enforcement endpoint.
 *
 * Automod lives here, because this is the only process that sees guild chat.
 * The Discord write it implies — a timeout, a kick — does not: privileged writes
 * to the member server belong to the admin bot, which holds the permission and
 * the preflight. So automod decides here and enforces there, exactly as a
 * self-service role press does (`role-effector.ts`) and a ticket close does.
 *
 * Same rule as those two, and it is the rule this whole change exists to
 * restore: **a failure is never a claim.** An unreachable admin bot reports that
 * nothing happened, the moderation service marks the case `enforcement_failed`,
 * and staff are told — rather than the audit log quietly recording an automod
 * mute that silenced nobody.
 */
import type { Logger } from "@sbr/observability";
import type { DiscordEnforcer, EnforcementOutcome } from "@sbr/moderation";
import type { ModerationActionDTO } from "@sbr/shared-types";

/** One member fetch plus one Discord write, behind the loopback hop. */
const TIMEOUT_MS = 10_000;

/** Discord's own ceiling on a communication timeout. */
const MAX_TIMEOUT_SECONDS = 28 * 24 * 60 * 60;

interface EnforceRequest {
  readonly type: "KICK" | "BAN" | "UNBAN" | "TIMEOUT" | "UNTIMEOUT";
  readonly userId: string;
  readonly reason: string;
  readonly durationSeconds: number | null;
}

export interface BridgeEnforcementDeps {
  readonly baseUrl: string;
  /** Absent means the admin bot isn't serving; every call reports as unenforced. */
  readonly token: string | undefined;
  readonly logger: Logger;
}

/**
 * Which Discord action, if any, a recorded moderation action implies.
 *
 * Null for WARN and NOTE on purpose: those are records, not removals. An
 * unbounded MUTE is also null — Discord has no unbounded timeout, and clamping
 * one to 28 days would quietly convert a permanent punishment into a temporary
 * one. The Redis mirror still holds it on every surface the platform owns.
 */
function requestFor(action: ModerationActionDTO): EnforceRequest | null {
  if (action.targetDiscordId === null) return null;
  const base = {
    userId: action.targetDiscordId,
    reason: action.reason ?? "No reason given",
    durationSeconds: action.durationSeconds,
  };
  switch (action.type) {
    case "MUTE":
      if (action.durationSeconds === null || action.durationSeconds <= 0) return null;
      return { ...base, type: "TIMEOUT", durationSeconds: Math.min(action.durationSeconds, MAX_TIMEOUT_SECONDS) };
    case "UNMUTE":
      return { ...base, type: "UNTIMEOUT" };
    case "KICK":
      return { ...base, type: "KICK" };
    case "BAN":
      return { ...base, type: "BAN" };
    case "UNBAN":
      return { ...base, type: "UNBAN" };
    default:
      return null;
  }
}

export function createBridgeEnforcer(deps: BridgeEnforcementDeps): DiscordEnforcer {
  const base = deps.baseUrl.replace(/\/+$/, "");
  const log = deps.logger.child({ service: "enforcer" });

  return {
    async enforce(action): Promise<EnforcementOutcome> {
      const request = requestFor(action);
      if (request === null) {
        return { ok: true, skipped: true, reason: "no Discord effect for this action" };
      }
      if (deps.token === undefined) {
        return { ok: false, reason: "the admin bot's internal API is not configured here" };
      }

      try {
        const res = await fetch(`${base}/internal/g/${encodeURIComponent(action.guildId)}/enforce`, {
          method: "POST",
          headers: { authorization: `Bearer ${deps.token}`, "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
          // 503 is the admin bot still connecting, which fixes itself; anything
          // else is worth an operator's attention.
          const level = res.status === 503 ? "debug" : "warn";
          log[level]("enforcement refused", { guildId: action.guildId, status: res.status });
          return { ok: false, reason: `the admin bot answered HTTP ${res.status}` };
        }
        const body = (await res.json()) as { ok?: unknown; error?: unknown };
        if (body.ok === true) return { ok: true };
        return { ok: false, reason: typeof body.error === "string" ? body.error : "Discord refused it" };
      } catch (error) {
        log.warn("admin bot enforcement api unreachable", {
          guildId: action.guildId,
          type: action.type,
          error: String(error),
        });
        return { ok: false, reason: "the admin bot is unreachable" };
      }
    },
  };
}
