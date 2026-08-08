/**
 * Event lifecycle jobs (WORKERS.md §2.7–2.8): `event-transition` moves events
 * through SCHEDULED → LIVE → COMPLETED, and `reminder-dispatch` pings the people
 * who said they'd be there.
 *
 * Both are written as sweeps over current database truth rather than as
 * follow-ups to a previously scheduled job. A delayed job that fires once is
 * lost if the worker was down at that moment; a sweep that re-evaluates from the
 * rows catches up on the next tick, which is the difference between an event
 * label lagging five minutes and it being wrong until someone notices.
 */

/** The subset of an Event row these jobs reason about. */
export interface EventRow {
  readonly id: string;
  readonly guildId: string;
  readonly title: string;
  readonly status: "SCHEDULED" | "LIVE" | "COMPLETED" | "CANCELLED";
  /** ISO-8601. */
  readonly startsAt: string;
  readonly endsAt: string | null;
  /** Which reminder offsets have already been sent, keyed by minutes-before. */
  readonly reminderState: Readonly<Record<string, unknown>>;
}

export type EventStatus = EventRow["status"];

/**
 * How long a LIVE event runs when nobody set an end time. Without a default an
 * open-ended event would sit LIVE forever and keep appearing at the top of
 * `/events` weeks later.
 */
export const DEFAULT_EVENT_DURATION_MS = 3 * 60 * 60_000;

/**
 * The next valid status for an event, or null to leave it alone.
 *
 * Only forward transitions are produced, and CANCELLED is terminal — a staff
 * cancellation must not be undone by a sweep that runs a minute later and sees
 * the start time pass.
 */
export function nextEventStatus(event: EventRow, now: Date): EventStatus | null {
  if (event.status === "CANCELLED" || event.status === "COMPLETED") return null;

  const startsAt = Date.parse(event.startsAt);
  if (!Number.isFinite(startsAt)) return null;

  const endsAt = event.endsAt === null ? startsAt + DEFAULT_EVENT_DURATION_MS : Date.parse(event.endsAt);
  const ms = now.getTime();

  if (Number.isFinite(endsAt) && ms >= endsAt) return "COMPLETED";
  if (ms >= startsAt) return event.status === "LIVE" ? null : "LIVE";
  return null;
}

export interface EventTransitionDeps {
  /** Events that could still move — SCHEDULED or LIVE, across all guilds. */
  listOpenEvents(): Promise<readonly EventRow[]>;
  setStatus(eventId: string, status: EventStatus): Promise<void>;
  now?: () => Date;
}

/** Runs one sweep; returns how many events actually changed status. */
export async function transitionEvents(deps: EventTransitionDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const events = await deps.listOpenEvents();

  let moved = 0;
  for (const event of events) {
    const next = nextEventStatus(event, now);
    if (next === null) continue;
    await deps.setStatus(event.id, next);
    moved += 1;
  }
  return moved;
}

// ─────────────────────────────── reminders ───────────────────────────────

/**
 * Offsets before `startsAt`, in minutes. Descending so the day-before reminder
 * is considered first when a sweep catches up on several at once.
 */
export const REMINDER_OFFSETS_MINUTES: readonly number[] = [24 * 60, 60];

/**
 * How late a reminder may be and still be worth sending. A "starts in 1 hour"
 * ping that arrives after the event began is worse than no ping.
 */
const REMINDER_GRACE_MS = 10 * 60_000;

export interface DueReminder {
  readonly eventId: string;
  readonly offsetMinutes: number;
}

/**
 * The reminders this event is owed right now.
 *
 * `reminderState` is the idempotency guard: a key present for an offset means it
 * was sent, so a re-run — or two workers sweeping at once — produces nothing.
 */
export function dueReminders(event: EventRow, now: Date): readonly DueReminder[] {
  if (event.status !== "SCHEDULED") return [];

  const startsAt = Date.parse(event.startsAt);
  if (!Number.isFinite(startsAt)) return [];

  const ms = now.getTime();
  const due: DueReminder[] = [];

  for (const offsetMinutes of REMINDER_OFFSETS_MINUTES) {
    if (event.reminderState[String(offsetMinutes)] !== undefined) continue;
    const fireAt = startsAt - offsetMinutes * 60_000;
    if (ms >= fireAt && ms <= fireAt + REMINDER_GRACE_MS) {
      due.push({ eventId: event.id, offsetMinutes });
    }
  }
  return due;
}

export interface ReminderDispatchDeps {
  listOpenEvents(): Promise<readonly EventRow[]>;
  /** Discord ids to ping: everyone who said GOING or MAYBE. */
  listAttendees(eventId: string): Promise<readonly string[]>;
  /** Deliver the ping. Throwing leaves the reminder unmarked, so it retries. */
  notify(event: EventRow, discordIds: readonly string[], offsetMinutes: number): Promise<void>;
  markSent(eventId: string, offsetMinutes: number): Promise<void>;
  now?: () => Date;
}

/** Runs one sweep; returns how many reminders were dispatched. */
export async function dispatchReminders(deps: ReminderDispatchDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const events = await deps.listOpenEvents();

  let sent = 0;
  for (const event of events) {
    for (const reminder of dueReminders(event, now)) {
      const attendees = await deps.listAttendees(event.id);
      // Nobody to ping still marks the offset sent: the alternative is
      // re-checking an empty RSVP list on every sweep until the event starts.
      if (attendees.length > 0) await deps.notify(event, attendees, reminder.offsetMinutes);
      await deps.markSent(event.id, reminder.offsetMinutes);
      sent += 1;
    }
  }
  return sent;
}
