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
 * How stale a live board may get. Half an hour matches the tracker's default
 * poll interval: editing more often than the numbers change is rate limit spent
 * on redrawing the same table.
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
