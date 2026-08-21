import assert from "node:assert/strict";
import { test } from "node:test";

import {
  backfillMilestones,
  detectAndRecord,
  detectMilestones,
  resolveDefinitions,
  refreshProfiles,
  DEFAULT_MILESTONE_DEFINITIONS,
  type MilestoneCandidate,
  type MilestoneDefinition,
  type SnapshotMetrics,
  type ProfileReading,
  type TrackedAccount,
  standingMilestones,
  type BackfillTarget,
  type MilestoneBackfillDeps,
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
  const written = await refreshProfiles({
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
  await refreshProfiles({
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
  const rows: ProfileReading[] = [];
  const written = await refreshProfiles({
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

test("a refresh writes the reading itself, with no bucket or sequence to place it in", async () => {
  const rows: ProfileReading[] = [];
  await refreshProfiles({
    listTracked: async () => [account()],
    capture: async () => ({ profileId: "profile-x", metrics: metrics({ catacombsLevel: 42 }) }),
    write: async (s) => {
      rows.push(s);
    },
    now: () => NOW,
  });

  const row = rows[0];
  assert.ok(row);
  assert.equal(row.profileId, "profile-x");
  assert.equal(row.capturedAt, NOW.toISOString());
  assert.equal(row.catacombsLevel, 42);
  assert.equal(row.networth, null, "unknown stays null, never zero");
  // The shape is the guarantee: no day bucket, no sequence, nothing that would
  // let two readings of one profile coexist. See docs/HYPIXEL_COMPLIANCE.md §1.
  assert.deepEqual(
    Object.keys(row).filter((k) => k === "captureDate" || k === "seq" || k === "source"),
    [],
  );
});

test("repeated refreshes of one profile address the same row rather than accumulating", async () => {
  const rows: ProfileReading[] = [];
  const common = {
    listTracked: async () => [account()],
    capture: async () => ({ profileId: "p1", metrics: metrics() }),
    write: async (s: ProfileReading): Promise<void> => {
      rows.push(s);
    },
    minIntervalMs: 0,
  };

  await refreshProfiles({ ...common, now: () => new Date("2026-08-07T12:00:00Z") });
  await refreshProfiles({ ...common, now: () => new Date("2026-08-07T13:30:00Z") });

  assert.equal(rows.length, 2, "two passes, two writes");
  // Both carry the same key, so the upsert behind `write` addresses one row.
  assert.equal(rows[0]?.minecraftAccountId, rows[1]?.minecraftAccountId);
  assert.equal(rows[0]?.profileId, rows[1]?.profileId);
  assert.notEqual(rows[0]?.capturedAt, rows[1]?.capturedAt);
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
    recentReadings: async () => [metrics({ skillAverage: 41 }), metrics({ skillAverage: 39 })],
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
    recentReadings: async () => [metrics({ networth: 1e11 })],
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
    tier: "SILVER",
    icon: null,
    hidden: false,
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
    recentReadings: async () => [metrics({ catacombsLevel: 31 }), metrics({ catacombsLevel: 29 })],
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

// ─────────────────────────── backfill ───────────────────────────

function target(over: Partial<BackfillTarget> = {}): BackfillTarget {
  return { minecraftAccountId: "a1", guildId: "g1", discordId: "111", ...over };
}

/** A one-page backfill over `targets`, with everything else defaulted. */
function backfillDeps(
  targets: readonly BackfillTarget[],
  over: Partial<MilestoneBackfillDeps> = {},
): MilestoneBackfillDeps & { readonly recorded: MilestoneCandidate[] } {
  const recorded: MilestoneCandidate[] = [];
  return {
    recorded,
    async listTargets(limit, offset) {
      return targets.slice(offset, offset + limit);
    },
    async latestSnapshot() {
      return metrics({ catacombsLevel: 31 });
    },
    async definitionsFor() {
      return [definition()];
    },
    async record(_t, candidate) {
      recorded.push(candidate);
      return true;
    },
    ...over,
  };
}

test("standings report everything already passed, not just the last crossing", () => {
  const found = standingMilestones(
    "a1",
    [definition({ id: "d1", key: "catacombs:20", threshold: 20 }), definition({ id: "d2", threshold: 30 })],
    metrics({ catacombsLevel: 31 }),
  );
  assert.deepEqual(found.map((f) => f.definitionId), ["d1", "d2"]);
});

test("a standing under the threshold is not one", () => {
  assert.deepEqual(standingMilestones("a1", [definition()], metrics({ catacombsLevel: 29 })), []);
});

test("a missing metric is not a standing, however the definition reads", () => {
  assert.deepEqual(standingMilestones("a1", [definition()], metrics()), []);
});

test("the backfill records what an account already stands at", async () => {
  // The guild's definitions are merged with the platform defaults, so the count
  // is whatever a level-31 account has passed in total; what this asserts is
  // that the guild's own definition is among them and the account cleared it.
  const d = backfillDeps([target()]);
  const written = await backfillMilestones(d);
  assert.equal(written, d.recorded.length);
  assert.ok(d.recorded.some((c) => c.definitionId === "d1"));
  assert.ok(d.recorded.every((c) => c.minecraftAccountId === "a1"));
});

test("an account with no snapshot is skipped rather than guessed at", async () => {
  const d = backfillDeps([target()], { async latestSnapshot() { return null; } });
  assert.equal(await backfillMilestones(d), 0);
});

test("a row the store already has does not count as written", async () => {
  // `record` returning false is the unique-constraint hit: the milestone exists,
  // so a nightly re-run reports zero rather than the same number every night.
  const d = backfillDeps([target()], { async record() { return false; } });
  assert.equal(await backfillMilestones(d), 0);
});

test("keys narrow the run to the definition that was just added", async () => {
  const d = backfillDeps([target()], {
    keys: ["catacombs:20"],
    async definitionsFor() {
      return [definition({ id: "d1", key: "catacombs:20", threshold: 20 }), definition({ id: "d2", threshold: 30 })];
    },
  });
  assert.equal(await backfillMilestones(d), 1);
  assert.equal(d.recorded[0]?.definitionId, "d1");
});

test("definitions are read once per guild, not once per account", async () => {
  let reads = 0;
  const d = backfillDeps([target({ minecraftAccountId: "a1" }), target({ minecraftAccountId: "a2" })], {
    async definitionsFor() {
      reads += 1;
      return [definition()];
    },
  });
  await backfillMilestones(d);
  assert.equal(reads, 1);
});

test("paging stops at maxAccounts rather than walking the whole table", async () => {
  const many = Array.from({ length: 10 }, (_, i) => target({ minecraftAccountId: `a${i}` }));
  const d = backfillDeps(many, { pageSize: 2, maxAccounts: 4 });
  await backfillMilestones(d);
  assert.deepEqual([...new Set(d.recorded.map((c) => c.minecraftAccountId))], ["a0", "a1", "a2", "a3"]);
});

test("a short page ends the walk", async () => {
  let calls = 0;
  const d = backfillDeps([target()], {
    pageSize: 10,
    async listTargets(limit, offset) {
      calls += 1;
      return [target()].slice(offset, offset + limit);
    },
  });
  await backfillMilestones(d);
  assert.equal(calls, 1);
});
