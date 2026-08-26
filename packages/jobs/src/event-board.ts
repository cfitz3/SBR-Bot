/**
 * `event-board` (WORKERS.md §2.7c): keep every live event's tracker board
 * current, and write the result card once when one finishes.
 *
 * The pass itself decides nothing about what a board says — that is the bridge
 * bot's, because the board needs a gateway to the community server and this
 * process has none. What lives here is the work list and the arithmetic of how
 * often a board is worth an edit, both of which are database questions.
 *
 * A sweep rather than a scheduled follow-up, for the same reason the event
 * lifecycle jobs are: a board missed because the bridge was restarting is
 * picked up on the next pass instead of being lost.
 */

/** An event needing a board pass, and nothing else — the bridge reads the rest. */
export interface BoardableEvent {
  readonly id: string;
  readonly guildId: string;
}

/**
 * How stale a live board may get -- the ceiling, not the cadence.
 *
 * The board sweep and the metric poll are deliberately *not* one clock. Polling
 * is bounded by the Hypixel per-player budget and cannot go below an hour;
 * redrawing is a local render and one Discord edit, and tying it to the slower
 * of the two would mean a board that lags the data it is drawn from. So the
 * sweep keeps its own half-hourly pass, and `listBoardDue` filters it down to
 * the events whose scores have actually moved since their board was last drawn.
 *
 * The half hour is therefore how long a *changed* standing may wait to appear,
 * not how often a board is rewritten. A quiet event costs one query per pass
 * and no edit at all.
 */
export const BOARD_REFRESH_MS = 30 * 60_000;

export interface EventBoardJobDeps {
  /** Live events overdue a refresh, plus finished ones owed a result card. */
  listDue(staleBefore: Date): Promise<readonly BoardableEvent[]>;
  /** Ask the bridge to publish one board. False means it did not land. */
  publish(event: BoardableEvent): Promise<boolean>;
  onError(scope: string, error: unknown): void;
  now?: () => Date;
}

/** Runs one pass; returns how many boards were actually written. */
export async function publishEventBoards(deps: EventBoardJobDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();

  let events: readonly BoardableEvent[];
  try {
    events = await deps.listDue(new Date(now.getTime() - BOARD_REFRESH_MS));
  } catch (error) {
    deps.onError("board list", error);
    return 0;
  }

  let written = 0;
  for (const event of events) {
    try {
      // One failed board must not cost the rest of the pass theirs: a guild
      // that revoked the bot's permission in its events channel would otherwise
      // stop every other guild's board too.
      if (await deps.publish(event)) written += 1;
    } catch (error) {
      deps.onError(`board ${event.id}`, error);
    }
  }
  return written;
}
