/**
 * The workers' client for the bridge bot's ticket API — the sweep half.
 *
 * Third client for the same small API, after the panel's and the admin bot's,
 * and the one with the least to say: nobody is waiting on this call, so a
 * failure is a log line and a null, and the next pass tries again. That is the
 * whole difference from `apps/admin-bot/src/ticket-bridge.ts`, which has to
 * turn every failure into words for a staffer standing in front of it.
 */
import type { Logger } from "@sbr/observability";
import type { SweepableTicket, TicketSweepAction } from "@sbr/jobs";

/**
 * A sweep of one ticket can post an embed, render a transcript, DM it and
 * delete a channel — several Discord round trips, on the far side of a lock the
 * whole pass is holding. Generous, but bounded.
 */
const TIMEOUT_MS = 15_000;

const ACTIONS: readonly TicketSweepAction[] = ["NONE", "WARN_STALE", "AUTO_CLOSE"];

export interface WorkerTicketBridgeDeps {
  readonly baseUrl: string;
  /** Absent means the bridge isn't serving; every call reports as unreachable. */
  readonly token: string | undefined;
  readonly logger: Logger;
}

export interface WorkerTicketBridge {
  sweep(ticket: SweepableTicket, staleWarned: boolean): Promise<TicketSweepAction | null>;
}

export function createWorkerTicketBridge(deps: WorkerTicketBridgeDeps): WorkerTicketBridge {
  const base = deps.baseUrl.replace(/\/+$/, "");
  return {
    async sweep(ticket, staleWarned) {
      if (deps.token === undefined) return null;
      try {
        const res = await fetch(`${base}/internal/g/${encodeURIComponent(ticket.guildId)}/ticket-sweep`, {
          method: "POST",
          headers: { authorization: `Bearer ${deps.token}`, "content-type": "application/json" },
          body: JSON.stringify({ ticketId: ticket.id, staleWarned }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
          // 404 is ordinary: the ticket closed between the list and the call.
          // 503 is the bridge still connecting, which the next pass will find
          // resolved. Neither is worth more than a debug line.
          const level = res.status === 404 || res.status === 503 ? "debug" : "warn";
          deps.logger[level]("ticket sweep refused", { ticketId: ticket.id, status: res.status });
          return null;
        }
        const body = (await res.json().catch(() => ({}))) as { action?: unknown };
        const action = ACTIONS.find((a) => a === body.action);
        return action ?? null;
      } catch (error) {
        deps.logger.warn("bridge ticket api unreachable", { ticketId: ticket.id, error: String(error) });
        return null;
      }
    },
  };
}
