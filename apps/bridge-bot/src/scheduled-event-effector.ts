/**
 * The bridge bot's client for the admin bot's scheduled-event endpoint.
 *
 * The event message lives here, because this is the process that owns the
 * guild's channels. The native Discord scheduled event it mirrors does not:
 * making one needs `Manage Events`, and this bot deliberately holds none of the
 * privileged permissions — the same split that sends an automod timeout
 * (`enforcement-effector.ts`) and a self-service role grant (`role-effector.ts`)
 * over the loopback hop to the admin bot.
 *
 * Unlike those two, a failure here is not a claim that has to be retracted. The
 * mirror is a convenience: it puts the event in the server's event list and
 * lets Discord send the reminder. The message is the event, and it publishes
 * whether or not this call succeeds. So every failure returns null, the card is
 * drawn without the reminder line, and the next redraw tries again.
 */
import type { Logger } from "@sbr/observability";
import type { EventBoardDiscordPort, ScheduledEventRef, ScheduledEventSpec } from "./event-board.js";

/** One Discord write behind the loopback hop. */
const TIMEOUT_MS = 10_000;

export interface ScheduledEventMirrorDeps {
  readonly baseUrl: string;
  /** Absent means the admin bot isn't serving; the card simply has no link. */
  readonly token: string | undefined;
  readonly logger: Logger;
}

interface MirrorResponse {
  readonly ok?: unknown;
  readonly id?: unknown;
  readonly url?: unknown;
  readonly error?: unknown;
}

/**
 * The two optional halves of `EventBoardDiscordPort`, ready to spread into it.
 *
 * A `Pick` rather than a bare object so the shapes stay tied to the port: this
 * is wired in by spreading, which is exactly the position in which a signature
 * drift would otherwise go unnoticed.
 */
export function createScheduledEventMirror(
  deps: ScheduledEventMirrorDeps,
): Pick<EventBoardDiscordPort, "scheduleEvent" | "updateScheduledEvent"> {
  const base = deps.baseUrl.replace(/\/+$/, "");
  const log = deps.logger.child({ service: "scheduled-event-mirror" });

  async function call(guildId: string, body: Record<string, unknown>): Promise<ScheduledEventRef | null> {
    if (deps.token === undefined) return null;
    try {
      const res = await fetch(`${base}/internal/g/${encodeURIComponent(guildId)}/scheduled-event`, {
        method: "POST",
        headers: { authorization: `Bearer ${deps.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        // 503 is the admin bot still connecting, which fixes itself.
        const level = res.status === 503 ? "debug" : "warn";
        log[level]("scheduled event refused", { guildId, status: res.status });
        return null;
      }
      const payload = (await res.json()) as MirrorResponse;
      if (payload.ok !== true || typeof payload.id !== "string" || typeof payload.url !== "string") {
        log.debug("scheduled event not mirrored", { guildId, error: String(payload.error ?? "") });
        return null;
      }
      return { id: payload.id, url: payload.url };
    } catch (error) {
      log.warn("admin bot scheduled-event api unreachable", { guildId, error: String(error) });
      return null;
    }
  }

  function payload(spec: ScheduledEventSpec): Record<string, unknown> {
    return {
      name: spec.name,
      description: spec.description,
      startsAt: spec.startsAt,
      endsAt: spec.endsAt,
      location: spec.location,
      status: spec.status,
    };
  }

  return {
    async scheduleEvent(guildId, spec) {
      return call(guildId, payload(spec));
    },
    async updateScheduledEvent(guildId, discordEventId, spec) {
      return call(guildId, { ...payload(spec), discordEventId });
    },
  };
}
