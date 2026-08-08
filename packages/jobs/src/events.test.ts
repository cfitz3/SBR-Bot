import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_EVENT_DURATION_MS,
  dispatchReminders,
  dueReminders,
  nextEventStatus,
  transitionEvents,
  type EventRow,
  type EventStatus,
} from "./events.js";

const AT = (iso: string): Date => new Date(iso);

function event(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: "evt1",
    guildId: "g1",
    title: "F7 carry night",
    status: "SCHEDULED",
    startsAt: "2026-08-07T20:00:00.000Z",
    endsAt: null,
    reminderState: {},
    ...overrides,
  };
}

test("a scheduled event goes live once its start time passes", () => {
  assert.equal(nextEventStatus(event(), AT("2026-08-07T19:59:00Z")), null);
  assert.equal(nextEventStatus(event(), AT("2026-08-07T20:00:00Z")), "LIVE");
});

test("a live event completes at its end time", () => {
  const live = event({ status: "LIVE", endsAt: "2026-08-07T22:00:00.000Z" });
  assert.equal(nextEventStatus(live, AT("2026-08-07T21:30:00Z")), null);
  assert.equal(nextEventStatus(live, AT("2026-08-07T22:00:00Z")), "COMPLETED");
});

test("an open-ended event completes after the default duration rather than running forever", () => {
  const live = event({ status: "LIVE" });
  const start = Date.parse(live.startsAt);
  assert.equal(nextEventStatus(live, new Date(start + DEFAULT_EVENT_DURATION_MS - 1)), null);
  assert.equal(nextEventStatus(live, new Date(start + DEFAULT_EVENT_DURATION_MS)), "COMPLETED");
});

test("cancelled and completed are terminal — a later sweep never revives them", () => {
  const late = AT("2027-01-01T00:00:00Z");
  assert.equal(nextEventStatus(event({ status: "CANCELLED" }), late), null);
  assert.equal(nextEventStatus(event({ status: "COMPLETED" }), late), null);
});

test("an unparseable start time is left alone instead of guessed at", () => {
  assert.equal(nextEventStatus(event({ startsAt: "sometime friday" }), AT("2026-08-07T20:00:00Z")), null);
});

test("a sweep only writes the events that actually moved", async () => {
  const writes: { id: string; status: EventStatus }[] = [];
  const moved = await transitionEvents({
    listOpenEvents: async () => [
      event({ id: "starting" }),
      event({ id: "waiting", startsAt: "2026-08-08T20:00:00.000Z" }),
      event({ id: "ending", status: "LIVE", endsAt: "2026-08-07T19:00:00.000Z" }),
    ],
    setStatus: async (id, status) => {
      writes.push({ id, status });
    },
    now: () => AT("2026-08-07T20:00:00Z"),
  });

  assert.equal(moved, 2);
  assert.deepEqual(writes, [
    { id: "starting", status: "LIVE" },
    { id: "ending", status: "COMPLETED" },
  ]);
});

test("a reminder fires inside its window and not before", () => {
  const e = event();
  assert.deepEqual(dueReminders(e, AT("2026-08-07T18:55:00Z")), []);
  assert.deepEqual(dueReminders(e, AT("2026-08-07T19:00:00Z")), [{ eventId: "evt1", offsetMinutes: 60 }]);
});

test("a reminder more than ten minutes late is dropped rather than delivered stale", () => {
  assert.deepEqual(dueReminders(event(), AT("2026-08-07T19:11:00Z")), []);
});

test("reminderState suppresses a re-fire, so a second sweep sends nothing", () => {
  const already = event({ reminderState: { "60": "2026-08-07T19:00:00.000Z" } });
  assert.deepEqual(dueReminders(already, AT("2026-08-07T19:02:00Z")), []);
});

test("only scheduled events are reminded — a live event needs no heads-up", () => {
  assert.deepEqual(dueReminders(event({ status: "LIVE" }), AT("2026-08-07T19:00:00Z")), []);
});

test("an event with nobody going still marks the reminder sent", async () => {
  const notified: string[] = [];
  const marked: { id: string; offset: number }[] = [];

  const sent = await dispatchReminders({
    listOpenEvents: async () => [event()],
    listAttendees: async () => [],
    notify: async (e) => {
      notified.push(e.id);
    },
    markSent: async (id, offset) => {
      marked.push({ id, offset });
    },
    now: () => AT("2026-08-07T19:00:00Z"),
  });

  assert.equal(sent, 1);
  assert.deepEqual(notified, [], "nobody to ping means no ping");
  assert.deepEqual(marked, [{ id: "evt1", offset: 60 }], "but the offset is closed out");
});

test("attendees are pinged once and the offset recorded", async () => {
  const calls: { ids: readonly string[]; offset: number }[] = [];
  const sent = await dispatchReminders({
    listOpenEvents: async () => [event()],
    listAttendees: async () => ["111", "222"],
    notify: async (_e, ids, offset) => {
      calls.push({ ids, offset });
    },
    markSent: async () => {},
    now: () => AT("2026-08-07T19:00:00Z"),
  });

  assert.equal(sent, 1);
  assert.deepEqual(calls, [{ ids: ["111", "222"], offset: 60 }]);
});

test("a failed notify leaves the reminder unmarked so the next sweep retries it", async () => {
  let marked = false;
  await assert.rejects(
    dispatchReminders({
      listOpenEvents: async () => [event()],
      listAttendees: async () => ["111"],
      notify: async () => {
        throw new Error("discord down");
      },
      markSent: async () => {
        marked = true;
      },
      now: () => AT("2026-08-07T19:00:00Z"),
    }),
  );
  assert.equal(marked, false);
});
