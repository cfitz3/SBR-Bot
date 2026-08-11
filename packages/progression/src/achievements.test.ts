import assert from "node:assert/strict";
import test from "node:test";
import type { MilestoneDTO, MilestoneDefinitionDTO, SnapshotMetricsDTO } from "@sbr/shared-types";
import { buildAchievements } from "./achievements.js";

function def(over: Partial<MilestoneDefinitionDTO> = {}): MilestoneDefinitionDTO {
  return {
    id: null,
    guildId: "g1",
    key: "networth-10b",
    label: "10b networth",
    description: null,
    type: "NETWORTH_THRESHOLD",
    metric: "networth",
    threshold: 10_000_000_000,
    xpReward: 500,
    announce: true,
    enabled: true,
    source: "DEFAULT",
    ...over,
  };
}

function earnedRow(over: Partial<MilestoneDTO> = {}): MilestoneDTO {
  return {
    id: "m1",
    minecraftUuid: "uuid-a",
    type: "NETWORTH_THRESHOLD",
    metric: "networth",
    thresholdValue: 10_000_000_000,
    achievedAt: "2026-01-02T00:00:00Z",
    label: "10b networth",
    ...over,
  };
}

const snapshot: SnapshotMetricsDTO = {
  capturedAt: "2026-02-01T00:00:00Z",
  networth: 8_000_000_000,
  skillAverage: 42,
  catacombsLevel: 30,
  slayerXp: 1_500_000,
  senitherWeight: 8_000,
};

test("splits definitions into earned and outstanding", () => {
  const result = buildAchievements(
    [def(), def({ key: "cata-40", metric: "catacombsLevel", threshold: 40, xpReward: 100 })],
    [earnedRow()],
    snapshot,
  );
  assert.equal(result.earnedCount, 1);
  assert.equal(result.totalCount, 2);
  assert.equal(result.earned[0]?.key, "networth-10b");
  assert.equal(result.upcoming[0]?.key, "cata-40");
  assert.equal(result.measuredAt, "2026-02-01T00:00:00Z");
});

test("only earned definitions count towards XP", () => {
  const result = buildAchievements([def(), def({ key: "cata-40", metric: "catacombsLevel", threshold: 40 })], [earnedRow()], snapshot);
  assert.equal(result.xpEarned, 500);
});

test("progress is the clamped fraction of the threshold", () => {
  const result = buildAchievements([def({ threshold: 10_000_000_000 })], [], snapshot);
  assert.equal(result.upcoming[0]?.progress, 0.8);
  assert.equal(result.upcoming[0]?.current, 8_000_000_000);
});

test("an unmeasured metric reports null progress rather than zero", () => {
  // Zero would read as "measured, and you have none" — a claim we can't make
  // for a member the snapshot worker has never covered.
  const result = buildAchievements([def()], [], null);
  assert.equal(result.upcoming[0]?.progress, null);
  assert.equal(result.upcoming[0]?.current, null);
  assert.equal(result.measuredAt, null);
});

test("a zero threshold is met rather than dividing", () => {
  const result = buildAchievements([def({ threshold: 0 })], [], snapshot);
  assert.equal(result.upcoming[0]?.progress, 1);
});

test("disabled definitions are absent entirely", () => {
  const result = buildAchievements([def({ enabled: false })], [], snapshot);
  assert.equal(result.totalCount, 0);
});

test("an earned row survives its definition being deleted", () => {
  const result = buildAchievements([], [earnedRow()], snapshot);
  assert.equal(result.earnedCount, 1);
  assert.equal(result.earned[0]?.label, "10b networth");
  // The reward belonged to a definition that no longer exists, so it pays none.
  assert.equal(result.xpEarned, 0);
});

test("an earned row with no label falls back to metric and threshold", () => {
  const result = buildAchievements([], [earnedRow({ label: null })], snapshot);
  assert.equal(result.earned[0]?.label, "networth 10000000000");
});

test("re-crossing a threshold keeps the first date", () => {
  const result = buildAchievements(
    [def()],
    [earnedRow({ id: "m2", achievedAt: "2026-03-01T00:00:00Z" }), earnedRow()],
    snapshot,
  );
  assert.equal(result.earned.length, 1);
  assert.equal(result.earned[0]?.achievedAt, "2026-01-02T00:00:00Z");
});

test("earned lists newest first and upcoming lists closest first", () => {
  const result = buildAchievements(
    [
      def(),
      def({ key: "cata-40", metric: "catacombsLevel", threshold: 40 }), // 30/40 = 0.75
      def({ key: "sa-60", metric: "skillAverage", threshold: 60 }), // 42/60 = 0.70
    ],
    [
      earnedRow({ id: "m9", metric: "senitherWeight", thresholdValue: 5_000, achievedAt: "2026-05-01T00:00:00Z", label: "5k weight" }),
      earnedRow(),
    ],
    snapshot,
  );
  assert.deepEqual(result.earned.map((a) => a.label), ["5k weight", "10b networth"]);
  assert.deepEqual(result.upcoming.map((a) => a.key), ["cata-40", "sa-60"]);
});

test("an unmeasured upcoming sorts behind every measured one", () => {
  const result = buildAchievements(
    [
      def({ key: "slayer-1m", metric: "slayerXp", threshold: 1_000_000 }),
      def({ key: "custom", metric: "somethingUntracked", threshold: 5 }),
    ],
    [],
    snapshot,
  );
  assert.deepEqual(result.upcoming.map((a) => a.key), ["slayer-1m", "custom"]);
  assert.equal(result.upcoming[1]?.progress, null);
});

test("carries the configured flag through", () => {
  assert.equal(buildAchievements([], [], null, { configured: false }).configured, false);
  assert.equal(buildAchievements([], [], null).configured, true);
});
