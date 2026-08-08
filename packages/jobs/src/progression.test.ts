import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectAndRecord,
  detectMilestones,
  snapshotProfiles,
  type MilestoneCandidate,
  type SnapshotMetrics,
  type SnapshotWrite,
  type TrackedAccount,
} from "./progression.js";

const NOW = new Date("2026-08-07T12:00:00.000Z");

function metrics(over: Partial<SnapshotMetrics> = {}): SnapshotMetrics {
  return { networth: null, skillAverage: null, catacombsLevel: null, senitherWeight: null, ...over };
}

function account(over: Partial<TrackedAccount> = {}): TrackedAccount {
  return { minecraftAccountId: "a1", uuid: "u1", profileId: "p1", lastCapturedAt: null, ...over };
}

test("accounts captured recently are skipped, so a tick doesn't burn the rate budget", async () => {
  const captured: string[] = [];
  const written = await snapshotProfiles({
    listTracked: async () => [
      account({ minecraftAccountId: "fresh", lastCapturedAt: "2026-08-07T11:00:00.000Z" }),
      account({ minecraftAccountId: "stale", lastCapturedAt: "2026-08-06T00:00:00.000Z" }),
      account({ minecraftAccountId: "never" }),
    ],
    capture: async (a) => {
      captured.push(a.minecraftAccountId);
      return { profileId: "p1", metrics: metrics({ networth: 1 }) };
    },
    write: async () => {},
    now: () => NOW,
  });

  assert.equal(written, 2);
  assert.deepEqual(captured, ["never", "stale"], "never-captured first, then oldest");
});

test("the batch size caps how many accounts one run touches", async () => {
  let captures = 0;
  await snapshotProfiles({
    listTracked: async () =>
      Array.from({ length: 40 }, (_, i) => account({ minecraftAccountId: `a${i}` })),
    capture: async () => {
      captures += 1;
      return { profileId: "p1", metrics: metrics() };
    },
    write: async () => {},
    batchSize: 10,
    now: () => NOW,
  });
  assert.equal(captures, 10);
});

test("one unreadable profile does not cost the rest of the batch their snapshot", async () => {
  const rows: SnapshotWrite[] = [];
  const written = await snapshotProfiles({
    listTracked: async () => [
      account({ minecraftAccountId: "hidden" }),
      account({ minecraftAccountId: "broken" }),
      account({ minecraftAccountId: "ok" }),
    ],
    capture: async (a) => {
      if (a.minecraftAccountId === "hidden") return null;
      if (a.minecraftAccountId === "broken") throw new Error("upstream 500");
      return { profileId: "p1", metrics: metrics({ networth: 5 }) };
    },
    write: async (s) => {
      rows.push(s);
    },
    now: () => NOW,
  });

  assert.equal(written, 1);
  assert.equal(rows[0]?.minecraftAccountId, "ok");
});

test("a scheduled snapshot lands in the day's bucket at seq 0", async () => {
  const rows: SnapshotWrite[] = [];
  await snapshotProfiles({
    listTracked: async () => [account()],
    capture: async () => ({ profileId: "profile-x", metrics: metrics({ catacombsLevel: 42 }) }),
    write: async (s) => {
      rows.push(s);
    },
    now: () => NOW,
  });

  const row = rows[0];
  assert.ok(row);
  assert.equal(row.captureDate, "2026-08-07");
  assert.equal(row.seq, 0);
  assert.equal(row.source, "SCHEDULED");
  assert.equal(row.eventId, null);
  assert.equal(row.catacombsLevel, 42);
  assert.equal(row.networth, null, "unknown stays null, never zero");
});

test("the event-tracked cohort gets distinct sequences so several rows fit in one day", async () => {
  const rows: SnapshotWrite[] = [];
  const write = async (s: SnapshotWrite): Promise<void> => {
    rows.push(s);
  };
  const common = {
    listTracked: async () => [account()],
    capture: async () => ({ profileId: "p1", metrics: metrics() }),
    write,
    source: "EVENT_TRACKED" as const,
    eventId: "evt1",
    minIntervalMs: 0,
  };

  await snapshotProfiles({ ...common, now: () => new Date("2026-08-07T12:00:00Z") });
  await snapshotProfiles({ ...common, now: () => new Date("2026-08-07T12:30:00Z") });

  assert.equal(rows.length, 2);
  assert.notEqual(rows[0]?.seq, rows[1]?.seq);
  assert.equal(rows[0]?.eventId, "evt1");
});

test("crossing a threshold produces exactly one milestone", () => {
  const found = detectMilestones("a1", metrics({ catacombsLevel: 29 }), metrics({ catacombsLevel: 31 }));
  assert.deepEqual(found, [
    { minecraftAccountId: "a1", type: "CATACOMBS_LEVEL", metric: "catacombsLevel", thresholdValue: 30 },
  ]);
});

test("a jump past several thresholds reports each one", () => {
  const found = detectMilestones("a1", metrics({ networth: 5e8 }), metrics({ networth: 1.1e10 }));
  assert.deepEqual(
    found.map((m) => m.thresholdValue),
    [1e9, 5e9, 1e10],
  );
});

test("staying below or already above a threshold reports nothing", () => {
  assert.deepEqual(detectMilestones("a1", metrics({ catacombsLevel: 31 }), metrics({ catacombsLevel: 33 })), []);
  assert.deepEqual(detectMilestones("a1", metrics({ catacombsLevel: 5 }), metrics({ catacombsLevel: 9 })), []);
});

test("a first-ever snapshot announces nothing, rather than every threshold at once", () => {
  assert.deepEqual(detectMilestones("a1", null, metrics({ networth: 5e10, catacombsLevel: 45 })), []);
});

test("an unreadable metric on either side is skipped instead of read as zero", () => {
  assert.deepEqual(detectMilestones("a1", metrics({ networth: null }), metrics({ networth: 1e10 })), []);
  assert.deepEqual(detectMilestones("a1", metrics({ networth: 1e8 }), metrics({ networth: null })), []);
});

test("only newly recorded milestones are counted — a duplicate insert is not a new one", async () => {
  const attempted: MilestoneCandidate[] = [];
  const recorded = await detectAndRecord("a1", {
    recentSnapshots: async () => [metrics({ skillAverage: 41 }), metrics({ skillAverage: 39 })],
    record: async (c) => {
      attempted.push(c);
      return false; // unique constraint said we already have it
    },
  });

  assert.equal(recorded, 0);
  assert.equal(attempted.length, 1);
  assert.equal(attempted[0]?.thresholdValue, 40);
});

test("an account with a single snapshot yields nothing to compare", async () => {
  const recorded = await detectAndRecord("a1", {
    recentSnapshots: async () => [metrics({ networth: 1e11 })],
    record: async () => true,
  });
  assert.equal(recorded, 0);
});
