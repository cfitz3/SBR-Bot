/**
 * What the tracker promises: it measures gains rather than readings, it spends
 * the Hypixel budget only on live events with participants, and one broken
 * event does not cost the others their poll.
 *
 * The baseline arithmetic itself lives in the repository — `trackEvents` hands
 * over a reading and is told nothing about what it became — so what is asserted
 * here is which readings are handed over at all.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isEventMetric,
  EVENT_POLL_FLOOR_MINUTES,
  trackEvents,
  type EventParticipant,
  type EventScoreWrite,
  type EventTrackingDeps,
  type TrackableEvent,
} from "./event-tracking.js";
import type { SnapshotMetrics, SnapshotWrite } from "./progression.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");

function participant(over: Partial<EventParticipant> = {}): EventParticipant {
  return {
    discordId: "111",
    minecraftAccountId: "acct-1",
    uuid: "uuid-1",
    profileId: "prof-1",
    lastCapturedAt: null,
    ...over,
  };
}

function metrics(over: Partial<SnapshotMetrics> = {}): SnapshotMetrics {
  return {
    skyblockLevel: 300,
    networth: 1_000,
    skillAverage: 50,
    catacombsLevel: 40,
    slayerXp: 900,
    senitherWeight: 7_000,
    ...over,
  };
}

function harness(options: {
  events?: readonly TrackableEvent[];
  participants?: Readonly<Record<string, readonly EventParticipant[]>>;
  readings?: Readonly<Record<string, SnapshotMetrics | null>>;
  failEvents?: readonly string[];
  failEventList?: boolean;
}) {
  const scores: EventScoreWrite[] = [];
  const baselines: SnapshotWrite[] = [];
  const finals: SnapshotWrite[] = [];
  const captured: string[] = [];
  const errors: string[] = [];

  const deps: EventTrackingDeps = {
    async listLiveTracked() {
      if (options.failEventList) throw new Error("database down");
      return options.events ?? [{ id: "e1", guildId: "g1", trackedMetrics: ["catacombsLevel"], pollIntervalMinutes: 30 }];
    },
    async listParticipants(eventId) {
      if ((options.failEvents ?? []).includes(eventId)) throw new Error("query failed");
      return options.participants?.[eventId] ?? [participant()];
    },
    async capture(account) {
      captured.push(account.minecraftAccountId);
      const reading = options.readings?.[account.minecraftAccountId];
      const resolved = reading === undefined ? metrics() : reading;
      return resolved === null ? null : { profileId: account.profileId ?? "prof-1", metrics: resolved };
    },
    async write() {},
    async writeBaseline(snapshot) {
      // Write-once in the repository, so the double is write-once too: a second
      // call for the same participant and event must not move the starting line.
      const key = `${snapshot.minecraftAccountId}:${snapshot.eventId}`;
      if (baselines.some((b) => `${b.minecraftAccountId}:${b.eventId}` === key)) return;
      baselines.push(snapshot);
    },
    async writeFinal(snapshot) {
      const key = `${snapshot.minecraftAccountId}:${snapshot.eventId}`;
      const at = finals.findIndex((f) => `${f.minecraftAccountId}:${f.eventId}` === key);
      if (at === -1) finals.push(snapshot);
      else finals[at] = snapshot;
    },
    async upsertScore(write) {
      scores.push(write);
    },
    onError(scope) {
      errors.push(scope);
    },
    now: () => NOW,
  };

  return { deps, scores, baselines, finals, captured, errors };
}

describe("trackEvents", () => {
  it("scores every tracked metric for every participant", async () => {
    const h = harness({
      events: [{ id: "e1", guildId: "g1", trackedMetrics: ["catacombsLevel", "networth"], pollIntervalMinutes: 30 }],
      participants: { e1: [participant(), participant({ discordId: "222", minecraftAccountId: "acct-2", uuid: "uuid-2" })] },
    });

    assert.equal(await trackEvents(h.deps), 4);
    assert.deepEqual(
      h.scores.map((s) => `${s.uuid}:${s.metric}:${s.value}`),
      ["uuid-1:catacombsLevel:40", "uuid-1:networth:1000", "uuid-2:catacombsLevel:40", "uuid-2:networth:1000"],
    );
  });

  it("records a baseline and a final against the event, and nothing between them", async () => {
    const h = harness({});

    await trackEvents(h.deps);
    assert.equal(h.baselines.length, 1);
    assert.equal(h.finals.length, 1);
    assert.equal(h.baselines[0]?.source, "EVENT_BASELINE");
    assert.equal(h.finals[0]?.source, "EVENT_FINAL");
    assert.equal(h.baselines[0]?.eventId, "e1");
    assert.equal(h.baselines[0]?.savedBy, null, "a boundary is nobody's saved marker");
  });

  it("a second pass moves the final and leaves the baseline where it was", async () => {
    // The two rows per participant are the ceiling, not the starting point: a
    // long event polls many times and must still end with exactly two rows.
    const stale = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    const h = harness({
      participants: { e1: [participant({ lastCapturedAt: stale })] },
      readings: { "acct-1": metrics({ catacombsLevel: 41 }) },
    });

    await trackEvents(h.deps);
    await trackEvents(h.deps);

    assert.equal(h.baselines.length, 1);
    assert.equal(h.finals.length, 1);
    assert.equal(h.captured.length, 2, "two passes did fetch twice");
  });

  it("ignores a metric nothing captures rather than failing the event", async () => {
    const h = harness({
      events: [{ id: "e1", guildId: "g1", trackedMetrics: ["catacombsLevel", "vibes"], pollIntervalMinutes: 30 }],
    });

    assert.equal(await trackEvents(h.deps), 1);
    assert.deepEqual(
      h.scores.map((s) => s.metric),
      ["catacombsLevel"],
    );
  });

  it("skips an event whose metrics are all unrecognised, without spending a fetch", async () => {
    const h = harness({
      events: [{ id: "e1", guildId: "g1", trackedMetrics: ["vibes"], pollIntervalMinutes: 30 }],
    });

    assert.equal(await trackEvents(h.deps), 0);
    assert.deepEqual(h.captured, []);
  });

  it("leaves the last good score standing when a reading comes back null", async () => {
    const h = harness({
      events: [{ id: "e1", guildId: "g1", trackedMetrics: ["catacombsLevel", "networth"], pollIntervalMinutes: 30 }],
      readings: { "acct-1": metrics({ networth: null }) },
    });

    assert.equal(await trackEvents(h.deps), 1);
    assert.deepEqual(
      h.scores.map((s) => s.metric),
      ["catacombsLevel"],
    );
  });

  it("respects the event's own poll interval", async () => {
    const recent = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    const h = harness({
      events: [{ id: "e1", guildId: "g1", trackedMetrics: ["catacombsLevel"], pollIntervalMinutes: 30 }],
      participants: { e1: [participant({ lastCapturedAt: recent })] },
    });

    assert.equal(await trackEvents(h.deps), 0);
    assert.deepEqual(h.captured, []);
  });

  it("polls again once the interval has passed", async () => {
    const stale = new Date(NOW.getTime() - 61 * 60_000).toISOString();
    const h = harness({
      events: [{ id: "e1", guildId: "g1", trackedMetrics: ["catacombsLevel"], pollIntervalMinutes: 30 }],
      participants: { e1: [participant({ lastCapturedAt: stale })] },
    });

    assert.equal(await trackEvents(h.deps), 1);
  });

  it("a configured interval under an hour is clamped up to the floor", async () => {
    // 30 was a legal value before the floor existed, and rows carrying it are
    // still in the database — the clamp has to be here, not only in the panel.
    const stale = new Date(NOW.getTime() - 45 * 60_000).toISOString();
    const h = harness({
      events: [{ id: "e1", guildId: "g1", trackedMetrics: ["catacombsLevel"], pollIntervalMinutes: 5 }],
      participants: { e1: [participant({ lastCapturedAt: stale })] },
    });

    assert.equal(await trackEvents(h.deps), 0, "45 minutes is inside the 60-minute floor");
    assert.deepEqual(h.captured, []);
    assert.equal(EVENT_POLL_FLOOR_MINUTES, 60);
  });

  it("spends nothing on an event nobody RSVP'd to", async () => {
    const h = harness({ participants: { e1: [] } });

    assert.equal(await trackEvents(h.deps), 0);
    assert.deepEqual(h.captured, []);
  });

  it("an unreadable profile costs one participant, not the event", async () => {
    const h = harness({
      participants: {
        e1: [participant(), participant({ discordId: "222", minecraftAccountId: "acct-2", uuid: "uuid-2" })],
      },
      readings: { "acct-1": null },
    });

    assert.equal(await trackEvents(h.deps), 1);
    assert.deepEqual(
      h.scores.map((s) => s.uuid),
      ["uuid-2"],
    );
  });

  it("keeps going when one event's participant read fails", async () => {
    const h = harness({
      events: [
        { id: "e1", guildId: "g1", trackedMetrics: ["catacombsLevel"], pollIntervalMinutes: 30 },
        { id: "e2", guildId: "g1", trackedMetrics: ["catacombsLevel"], pollIntervalMinutes: 30 },
      ],
      failEvents: ["e1"],
    });

    assert.equal(await trackEvents(h.deps), 1);
    assert.deepEqual(h.errors, ["event e1"]);
  });

  it("gives up quietly when the event list itself fails", async () => {
    const h = harness({ failEventList: true });

    assert.equal(await trackEvents(h.deps), 0);
    assert.deepEqual(h.errors, ["event list"]);
  });
});

describe("isEventMetric", () => {
  it("accepts the metrics a snapshot records and nothing else", () => {
    assert.equal(isEventMetric("catacombsLevel"), true);
    assert.equal(isEventMetric("senitherWeight"), true);
    assert.equal(isEventMetric("catacombs"), false);
    assert.equal(isEventMetric(""), false);
  });
});
