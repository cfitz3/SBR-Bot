/**
 * Goals as the service sees them: what it refuses to store, what it stores as
 * the floor of the bar, and the arithmetic behind the projection on the card.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ok } from "@sbr/shared-types";
import type {
  GoalRepository,
  NetworthDTO,
  ProgressionRepository,
  SnapshotMetricsDTO,
  StoredGoalDTO,
} from "@sbr/shared-types";
import type { NetworthService } from "@sbr/pricing";
import type { Logger } from "@sbr/observability";
import { ProgressionServiceImpl } from "./service.js";
import type { ProfileProvider } from "./ports.js";

const silent: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

const NW: NetworthDTO = { total: 1, exact: true, missing: [], breakdown: {}, topItems: {} };
const networth: NetworthService = { async getNetworth() { return ok(NW); } };
const profiles = { async listProfiles() { return ok({ data: [] }); } } as unknown as ProfileProvider;

const GUILD = "guild-1";
const UUID = "uuid-1";

/** A day-spaced snapshot series on one metric, oldest first. */
function snapshots(metric: keyof SnapshotMetricsDTO, values: readonly number[]): SnapshotMetricsDTO[] {
  const day = 24 * 60 * 60_000;
  const start = Date.now() - (values.length - 1) * day;
  return values.map((v, i) => {
    const at = new Date(start + i * day);
    return {
      capturedAt: at.toISOString(),
      label: null,
      skyblockLevel: null,
      networth: null,
      skillAverage: null,
      catacombsLevel: null,
      slayerXp: null,
      senitherWeight: null,
      [metric]: v,
    } as unknown as SnapshotMetricsDTO;
  });
}

function repoWith(rows: readonly SnapshotMetricsDTO[]): ProgressionRepository {
  return {
    async listSnapshots() {
      return rows;
    },
    async latestSnapshot() {
      return rows[rows.length - 1] ?? null;
    },
  } as unknown as ProgressionRepository;
}

function goalStore(): GoalRepository & { readonly rows: StoredGoalDTO[] } {
  const rows: StoredGoalDTO[] = [];
  return {
    rows,
    async setGoal(input) {
      const existing = rows.findIndex(
        (r) => r.minecraftUuid === input.minecraftUuid && r.metric === input.metric,
      );
      const row: StoredGoalDTO = {
        id: `goal-${rows.length + 1}`,
        guildId: input.guildId,
        minecraftUuid: input.minecraftUuid,
        discordId: null,
        metric: input.metric,
        target: input.target,
        startValue: input.startValue,
        createdAt: new Date().toISOString(),
        achievedAt: null,
      };
      // The store's own constraint, honoured by the fake: one goal per metric.
      if (existing >= 0) rows[existing] = row;
      else rows.push(row);
      return row;
    },
    async listGoals(_g, uuid) {
      return rows.filter((r) => r.minecraftUuid === uuid);
    },
    async clearGoal(_g, uuid, metric) {
      const at = rows.findIndex((r) => r.minecraftUuid === uuid && r.metric === metric);
      if (at < 0) return false;
      rows.splice(at, 1);
      return true;
    },
    async listUnachieved() {
      return rows.filter((r) => r.achievedAt === null);
    },
    async markAchieved(ids) {
      return ids.length;
    },
  };
}

function service(rows: readonly SnapshotMetricsDTO[], goals?: GoalRepository) {
  return new ProgressionServiceImpl({
    profiles,
    networth,
    logger: silent,
    repo: repoWith(rows),
    ...(goals ? { goals } : {}),
  });
}

test("a target that isn't a usable number is refused before it reaches the store", async () => {
  const goals = goalStore();
  const svc = service(snapshots("skyblockLevel", [200]), goals);

  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = await svc.setGoal(GUILD, UUID, "skyblockLevel", bad);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.kind, "BAD_TARGET");
  }
  assert.equal(goals.rows.length, 0);
});

test("a target already met is refused with the current reading", async () => {
  const goals = goalStore();
  const svc = service(snapshots("skyblockLevel", [200, 260]), goals);

  const r = await svc.setGoal(GUILD, UUID, "skyblockLevel", 250);
  assert.equal(r.ok, false);
  if (!r.ok && r.error.kind === "ALREADY_THERE") assert.equal(r.error.current, 260);
  assert.equal(goals.rows.length, 0);
});

test("goals are unavailable rather than silently dropped when the store is unwired", async () => {
  const svc = service(snapshots("skyblockLevel", [200]));

  const set = await svc.setGoal(GUILD, UUID, "skyblockLevel", 250);
  assert.equal(set.ok, false);
  if (!set.ok) assert.equal(set.error.kind, "UNAVAILABLE");
  assert.deepEqual((await svc.listGoals(GUILD, UUID)).ok ? [] : null, []);
});

test("the stored floor is where they were when they set it", async () => {
  const goals = goalStore();
  const svc = service(snapshots("skyblockLevel", [200, 210]), goals);

  await svc.setGoal(GUILD, UUID, "skyblockLevel", 250);
  assert.equal(goals.rows[0]?.startValue, 210);
});

test("pace, progress and ETA come off the snapshot window", async () => {
  const goals = goalStore();
  // Four days, +10 a day, finishing at 240 with a target of 250.
  const svc = service(snapshots("skyblockLevel", [210, 220, 230, 240]), goals);

  await svc.setGoal(GUILD, UUID, "skyblockLevel", 250);
  const listed = await svc.listGoals(GUILD, UUID);
  assert.equal(listed.ok, true);
  if (!listed.ok) return;

  const g = listed.value[0];
  assert.ok(g);
  assert.equal(g.current, 240);
  assert.equal(g.perDay, 10);
  // startValue 240 → target 250, current 240: nothing covered yet.
  assert.equal(g.progress, 0);
  assert.equal(g.etaDays, 1);
});

test("one snapshot is not a pace, and no pace is not an ETA", async () => {
  const goals = goalStore();
  const svc = service(snapshots("skyblockLevel", [210]), goals);

  await svc.setGoal(GUILD, UUID, "skyblockLevel", 250);
  const listed = await svc.listGoals(GUILD, UUID);
  assert.equal(listed.ok, true);
  if (!listed.ok) return;

  assert.equal(listed.value[0]?.perDay, null);
  assert.equal(listed.value[0]?.etaDays, null);
});

test("a member going backwards gets no projection rather than a negative one", async () => {
  const goals = goalStore();
  const svc = service(snapshots("networth", [3e9, 2e9]), goals);

  await svc.setGoal(GUILD, UUID, "networth", 5e9);
  const listed = await svc.listGoals(GUILD, UUID);
  assert.equal(listed.ok, true);
  if (!listed.ok) return;

  assert.ok((listed.value[0]?.perDay ?? 0) < 0);
  assert.equal(listed.value[0]?.etaDays, null);
});

test("clearing says whether there was anything to clear", async () => {
  const goals = goalStore();
  const svc = service(snapshots("skyblockLevel", [210]), goals);

  await svc.setGoal(GUILD, UUID, "skyblockLevel", 250);
  assert.deepEqual(await svc.clearGoal(GUILD, UUID, "skyblockLevel"), ok(true));
  assert.deepEqual(await svc.clearGoal(GUILD, UUID, "skyblockLevel"), ok(false));
});

test("setting the same metric twice replaces rather than accumulates", async () => {
  const goals = goalStore();
  const svc = service(snapshots("skyblockLevel", [210]), goals);

  await svc.setGoal(GUILD, UUID, "skyblockLevel", 250);
  await svc.setGoal(GUILD, UUID, "skyblockLevel", 300);
  assert.equal(goals.rows.length, 1);
  assert.equal(goals.rows[0]?.target, 300);
});
