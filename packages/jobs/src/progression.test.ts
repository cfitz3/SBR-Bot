import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectAndRecord,
  detectMilestones,
  resolveDefinitions,
  snapshotProfiles,
  DEFAULT_MILESTONE_DEFINITIONS,
  type MilestoneCandidate,
  type MilestoneDefinition,
  type SnapshotMetrics,
  type SnapshotWrite,
  type TrackedAccount,
} from "./progression.js";

const NOW = new Date("2026-08-07T12:00:00.000Z");

/** What a guild that has configured nothing is measured against. */
const DEFAULTS = resolveDefinitions();

function metrics(over: Partial<SnapshotMetrics> = {}): SnapshotMetrics {
  return {
    skyblockLevel: null,
    networth: null,
    skillAverage: null,
    catacombsLevel: null,
    slayerXp: null,
    senitherWeight: null,
    ...over,
  };
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
  const found = detectMilestones("a1", DEFAULTS, metrics({ catacombsLevel: 29 }), metrics({ catacombsLevel: 31 }));
  assert.equal(found.length, 1);
  assert.partialDeepStrictEqual(found[0], {
    minecraftAccountId: "a1",
    type: "CATACOMBS_LEVEL",
    metric: "catacombsLevel",
    thresholdValue: 30,
    key: "catacombs:30",
    definitionId: null,
  });
});

test("a jump past several thresholds reports each one", () => {
  const found = detectMilestones("a1", DEFAULTS, metrics({ networth: 5e8 }), metrics({ networth: 1.1e10 }));
  assert.deepEqual(
    found.map((m) => m.thresholdValue),
    [1e9, 5e9, 1e10],
  );
});

test("staying below or already above a threshold reports nothing", () => {
  assert.deepEqual(detectMilestones("a1", DEFAULTS, metrics({ catacombsLevel: 31 }), metrics({ catacombsLevel: 33 })), []);
  assert.deepEqual(detectMilestones("a1", DEFAULTS, metrics({ catacombsLevel: 5 }), metrics({ catacombsLevel: 9 })), []);
});

test("a first-ever snapshot announces nothing, rather than every threshold at once", () => {
  assert.deepEqual(detectMilestones("a1", DEFAULTS, null, metrics({ networth: 5e10, catacombsLevel: 45 })), []);
});

test("an unreadable metric on either side is skipped instead of read as zero", () => {
  assert.deepEqual(detectMilestones("a1", DEFAULTS, metrics({ networth: null }), metrics({ networth: 1e10 })), []);
  assert.deepEqual(detectMilestones("a1", DEFAULTS, metrics({ networth: 1e8 }), metrics({ networth: null })), []);
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

// ── guild-configured definitions ────────────────────────────────────────────

function definition(over: Partial<MilestoneDefinition> = {}): MilestoneDefinition {
  return {
    id: "d1",
    key: "catacombs:30",
    label: "Catacombs 30",
    type: "CATACOMBS_LEVEL",
    metric: "catacombsLevel",
    threshold: 30,
    xpReward: 0,
    announce: true,
    enabled: true,
    ...over,
  };
}

test("a guild definition overrides the default with the same key, and keeps the rest", () => {
  const resolved = resolveDefinitions([definition({ threshold: 32, xpReward: 500 })]);
  const cata30 = resolved.find((d) => d.key === "catacombs:30");
  assert.equal(cata30?.threshold, 32, "the guild's threshold wins");
  assert.equal(cata30?.xpReward, 500);
  assert.equal(cata30?.id, "d1", "and the candidate can point back at the row");
  assert.equal(
    resolved.length,
    DEFAULT_MILESTONE_DEFINITIONS.length,
    "overriding one default must not drop the others",
  );
});

test("a guild can switch a default off by storing it disabled", () => {
  const resolved = resolveDefinitions([definition({ enabled: false })]);
  assert.equal(resolved.find((d) => d.key === "catacombs:30"), undefined);
  assert.equal(resolved.length, DEFAULT_MILESTONE_DEFINITIONS.length - 1);
});

test("a guild's own key is added alongside the defaults", () => {
  const resolved = resolveDefinitions([
    definition({ id: "d9", key: "networth:250b", label: "250b networth", metric: "networth", threshold: 2.5e11 }),
  ]);
  assert.equal(resolved.length, DEFAULT_MILESTONE_DEFINITIONS.length + 1);
});

test("a disabled definition never fires, even passed directly", () => {
  const found = detectMilestones(
    "a1",
    [definition({ enabled: false })],
    metrics({ catacombsLevel: 29 }),
    metrics({ catacombsLevel: 31 }),
  );
  assert.deepEqual(found, []);
});

test("a candidate carries the reward and the announce flag the definition set", async () => {
  const attempted: MilestoneCandidate[] = [];
  await detectAndRecord("a1", {
    definitions: [definition({ xpReward: 250, announce: false })],
    recentSnapshots: async () => [metrics({ catacombsLevel: 31 }), metrics({ catacombsLevel: 29 })],
    record: async (c) => {
      attempted.push(c);
      return true;
    },
  });

  assert.equal(attempted[0]?.xpReward, 250);
  assert.equal(attempted[0]?.announce, false);
  assert.equal(attempted[0]?.definitionId, "d1");
});

test("a definition added after the fact does not fire retroactively", () => {
  // The member was already past 30 in the previous snapshot, so raising the bar
  // to a level they had also already passed reports nothing: this detects
  // crossings, not standings.
  const found = detectMilestones(
    "a1",
    [definition({ threshold: 25 })],
    metrics({ catacombsLevel: 29 }),
    metrics({ catacombsLevel: 31 }),
  );
  assert.deepEqual(found, []);
});
