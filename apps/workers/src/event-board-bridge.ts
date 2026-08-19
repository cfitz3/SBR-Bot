/**
 * The workers' client for the bridge bot's event-board API.
 *
 * Fourth client for that little API and, like the ticket sweep's, the quiet
 * one: nobody is watching a board being redrawn, so a failure is a log line and
 * a false, and the next pass tries again half an hour later. See
 * `apps/workers/src/ticket-bridge.ts` — the shape is deliberately the same.
 */
import type { Logger } from "@sbr/observability";
import type { BoardableEvent } from "@sbr/jobs";

/** One board is a read, a render and a single Discord edit. */
const TIMEOUT_MS = 10_000;

export interface WorkerEventBoardDeps {
  readonly baseUrl: string;
  /** Absent means the bridge isn't serving; every call reports as unpublished. */
  readonly token: string | undefined;
  readonly logger: Logger;
}

export interface WorkerEventBoard {
  publish(event: BoardableEvent): Promise<boolean>;
}

export function createWorkerEventBoard(deps: WorkerEventBoardDeps): WorkerEventBoard {
  const base = deps.baseUrl.replace(/\/+$/, "");
  return {
    async publish(event) {
      if (deps.token === undefined) return false;
      try {
        const res = await fetch(`${base}/internal/g/${encodeURIComponent(event.guildId)}/event-board`, {
          method: "POST",
          headers: { authorization: `Bearer ${deps.token}`, "content-type": "application/json" },
          body: JSON.stringify({ eventId: event.id }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
          // 404 is ordinary — the event was deleted between the list and the
          // call — and 503 is the bridge still connecting. Neither is news.
          const level = res.status === 404 || res.status === 503 ? "debug" : "warn";
          deps.logger[level]("event board refused", { eventId: event.id, status: res.status });
          return false;
        }
        return true;
      } catch (error) {
        deps.logger.warn("bridge event board api unreachable", { eventId: event.id, error: String(error) });
        return false;
      }
    },
  };
}
