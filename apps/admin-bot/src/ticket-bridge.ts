/**
 * The admin bot's client for the bridge bot's ticket API.
 *
 * `/tickets list` and `/tickets view` read the database directly — this process
 * has the same tables. The other two do not: closing has to dispose of a
 * channel in the community server, where the *bridge* bot holds the gateway,
 * and a transcript is rendered from that gateway's archive with the opener's
 * tag resolved. Both go over loopback to the process that can actually do them.
 *
 * Failure is always words rather than a thrown error, because the caller is a
 * slash-command handler replying to a staffer who is standing there waiting.
 * "The bridge bot isn't reachable" is a useful answer; a stack trace is not.
 */
import type { TicketBridge } from "@sbr/commands-admin";
import type { Logger } from "@sbr/observability";

/** Rendering a transcript reads every message in the ticket, then uploads it. */
const TIMEOUT_MS = 10_000;

interface TicketBridgeDeps {
  readonly baseUrl: string;
  readonly token: string | undefined;
  readonly logger: Logger;
}

interface Answer {
  readonly ok: boolean;
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function call(deps: TicketBridgeDeps, path: string, init: RequestInit): Promise<Answer | null> {
  if (deps.token === undefined) return null;
  try {
    const res = await fetch(`${deps.baseUrl.replace(/\/+$/, "")}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${deps.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, body };
  } catch (error) {
    deps.logger.warn("bridge ticket api unreachable", { path, error: String(error) });
    return null;
  }
}

function detailOf(answer: Answer): string {
  const detail = answer.body["detail"];
  if (typeof detail === "string" && detail !== "") return detail;
  if (answer.status === 401) return "INTERNAL_API_TOKEN differs between the two bots";
  return `the bridge refused that (${String(answer.status)})`;
}

/**
 * Constructed unconditionally. With no token every call reports the bridge as
 * unreachable, which is the same answer a stopped bridge gives — one failure
 * mode for the handler to phrase, not two.
 */
export function createTicketBridge(deps: TicketBridgeDeps): TicketBridge {
  return {
    async close(request) {
      const answer = await call(deps, `/internal/g/${encodeURIComponent(request.guildId)}/ticket-close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticketId: request.ticketId,
          actorDiscordId: request.actorDiscordId,
          reason: request.reason,
        }),
      });
      if (answer === null) return { ok: false, detail: "the bridge bot isn't reachable" };
      if (!answer.ok) return { ok: false, detail: detailOf(answer) };
      const number = answer.body["number"];
      return { ok: true, number: typeof number === "number" ? number : 0 };
    },

    async transcript(guildId, ticketId) {
      const answer = await call(
        deps,
        `/internal/g/${encodeURIComponent(guildId)}/ticket-transcript?ticketId=${encodeURIComponent(ticketId)}`,
        { method: "GET" },
      );
      if (answer === null || !answer.ok) return null;
      const name = answer.body["name"];
      const content = answer.body["content"];
      if (typeof name !== "string" || typeof content !== "string") return null;
      return { name, content };
    },
  };
}
