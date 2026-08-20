/**
 * The reminder sweeper.
 *
 * Simpler than the announcers: there is no per-guild configuration to consult
 * and nothing to exclude, because a reminder already knows the channel it is
 * going back to. What it shares with them is the ordering — deliver, then flip
 * the flag — so a crash mid-post repeats a reminder rather than losing one.
 *
 * A reminder that cannot be delivered stays pending. That is right for a
 * restarting bot and for a momentary outage, and wrong only for a channel that
 * has been deleted, which is why the pass gives up on a row after enough
 * failures rather than retrying it forever.
 */
import type { Logger } from "@sbr/observability";
import type { ReminderDTO, ReminderPort } from "@sbr/shared-types";

/** How many due reminders one pass will deliver. */
export const REMINDER_BATCH = 25;
/** A minute is the resolution the command promises, so it is the sweep interval. */
export const REMINDER_INTERVAL_MS = 60_000;
/**
 * How far past due a reminder may be before the sweeper stops trying.
 *
 * A day. Past that the channel is almost certainly gone rather than busy, and a
 * permanently undeliverable row would otherwise occupy a slot in every batch
 * forever, crowding out reminders that could be delivered.
 */
export const REMINDER_GIVE_UP_MS = 24 * 60 * 60_000;

export interface ReminderSweeperDeps {
  readonly reminders: ReminderPort;
  /** Deliver one. `false` means it did not land and should be retried. */
  post(reminder: ReminderDTO): Promise<boolean>;
  readonly log: Logger;
  /** Injectable for the test; the sweeper never reads the clock directly. */
  now?(): number;
}

/** Deliver everything due. Returns how many landed. */
export async function sweepRemindersOnce(
  deps: ReminderSweeperDeps,
  limit: number = REMINDER_BATCH,
): Promise<number> {
  const now = deps.now?.() ?? Date.now();
  const due = await deps.reminders.listDue(new Date(now), limit);
  if (due.length === 0) return 0;

  const done: string[] = [];
  let abandoned = 0;

  for (const reminder of due) {
    const ok = await deps.post(reminder).catch(() => false);
    if (ok) {
      done.push(reminder.id);
      continue;
    }

    const overdueBy = now - Date.parse(reminder.dueAt);
    if (Number.isFinite(overdueBy) && overdueBy > REMINDER_GIVE_UP_MS) {
      // Marked delivered because there is nowhere left to deliver it, and
      // because the alternative is a row that blocks a batch slot forever.
      done.push(reminder.id);
      abandoned += 1;
      deps.log.warn("reminder abandoned — undeliverable for a day", {
        id: reminder.id,
        channelId: reminder.channelId,
      });
      continue;
    }
    deps.log.warn("reminder did not land", { id: reminder.id, channelId: reminder.channelId });
  }

  if (done.length > 0) await deps.reminders.markDelivered(done);
  return done.length - abandoned;
}

export interface ReminderSweeperHandle {
  stop(): void;
}

export function startReminderSweeper(
  deps: ReminderSweeperDeps,
  intervalMs: number = REMINDER_INTERVAL_MS,
): ReminderSweeperHandle {
  let running = false;
  const timer = setInterval(() => {
    // Two passes in flight would read the same due rows and deliver them twice.
    if (running) return;
    running = true;
    void sweepRemindersOnce(deps)
      .then((count) => {
        if (count > 0) deps.log.info("reminders delivered", { count });
      })
      .catch((error: unknown) => {
        deps.log.error("reminder sweep failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
