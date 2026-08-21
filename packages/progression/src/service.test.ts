import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hypixelFailure,
  ok,
  type DataEnvelope,
  type HypixelResult,
  type NetworthDTO,
  type ProgressionRepository,
  SAVED_SNAPSHOT_LIMIT,
} from "@sbr/shared-types";
import type { NetworthService, NetworthRequest } from "@sbr/pricing";
import type { Logger } from "@sbr/observability";
import { ProgressionServiceImpl } from "./service.js";
import type { ProfileProvider, SkyblockProfileData } from "./ports.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

const REQUIRED = ["inventory", "armor", "museum", "bank"];

/** One readable skill at 50 and maxed catacombs — enough to exercise the derivation. */
const MAXED_MEMBER = {
  player_data: { experience: { SKILL_MINING: 55_172_425 } },
  dungeons: { dungeon_types: { catacombs: { experience: 569_809_640 } } },
};

function profileData(over: Partial<SkyblockProfileData> = {}): SkyblockProfileData {
  return {
    profileId: "prof-1",
    cuteName: "Mango",
    gameMode: "NORMAL",
    rawMember: MAXED_MEMBER,
    networthEngineInput: { profile: {} },
    readableSections: REQUIRED,
    requiredSections: REQUIRED,
    ...over,
  };
}

function providerOk(data: SkyblockProfileData, freshness: "LIVE" | "STALE" = "LIVE"): ProfileProvider {
  const env: DataEnvelope<SkyblockProfileData> = { data, freshness, source: "LIVE", fetchedAt: "t" };
  return {
    async getSelectedProfile() { return ok(env); },
    async listProfiles() { return ok({ ...env, data: [data] }); },
  };
}

function providerFail(state: "MISSING_PROFILE" | "RATE_LIMITED"): ProfileProvider {
  return {
    async getSelectedProfile(): Promise<HypixelResult<SkyblockProfileData>> { return hypixelFailure(state); },
    async listProfiles(): Promise<HypixelResult<readonly SkyblockProfileData[]>> { return hypixelFailure(state); },
  };
}

const networthStub = (dto: NetworthDTO): NetworthService => ({
  async getNetworth(_req: NetworthRequest) { return ok(dto); },
});

test("getProfileSummary maps fields and preserves freshness", async () => {
  const svc = new ProgressionServiceImpl({
    profiles: providerOk(profileData(), "STALE"),
    networth: networthStub({ total: 1, exact: true, missing: [], breakdown: {}, topItems: {} }),
    logger: silent,
  });
  const r = await svc.getProfileSummary("uuid-aria");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.freshness, "STALE");
    // The summary is derived from the raw member, not passed in — so these
    // assert the parse, not a fixture echo.
    assert.equal(r.value.data.catacombsLevel, 50);
    assert.equal(r.value.data.skillAverage, 50);
    assert.ok((r.value.data.senitherWeight ?? 0) > 0);
  }
});

test("getProfileSummary propagates MISSING_PROFILE", async () => {
  const svc = new ProgressionServiceImpl({
    profiles: providerFail("MISSING_PROFILE"),
    networth: networthStub({ total: 1, exact: true, missing: [], breakdown: {}, topItems: {} }),
    logger: silent,
  });
  const r = await svc.getProfileSummary("uuid-ghost");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.state, "MISSING_PROFILE");
});

test("getNetworth composes valuation and preserves freshness", async () => {
  const svc = new ProgressionServiceImpl({
    profiles: providerOk(profileData(), "LIVE"),
    networth: networthStub({ total: 8_200_000_000, exact: true, missing: [], breakdown: { gear: 8.2e9 }, topItems: {} }),
    logger: silent,
  });
  const r = await svc.getNetworth("uuid-aria");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.data.total, 8_200_000_000);
    assert.equal(r.value.data.exact, true);
    assert.equal(r.value.freshness, "LIVE");
  }
});

test("getNetworth propagates RATE_LIMITED from the profile read", async () => {
  const svc = new ProgressionServiceImpl({
    profiles: providerFail("RATE_LIMITED"),
    networth: networthStub({ total: 1, exact: true, missing: [], breakdown: {}, topItems: {} }),
    logger: silent,
  });
  const r = await svc.getNetworth("uuid-aria");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.state, "RATE_LIMITED");
});

// ── saveSnapshot ────────────────────────────────────────────────────────────

/** A repository that records what it was asked and answers as told. */
function saveRepo(
  answer: Awaited<ReturnType<ProgressionRepository["saveSnapshot"]>>,
  calls: { uuid: string; savedBy: string; label: string | null }[],
): ProgressionRepository {
  return {
    async listMilestones() { return []; },
    async listSnapshots() { return []; },
    async latestSnapshot() { return null; },
    async saveSnapshot(uuid, savedBy, label) {
      calls.push({ uuid, savedBy, label });
      return answer;
    },
    async getSelectedProfileId() { return null; },
    async setSelectedProfile() {},
  };
}

/** Any read of this fails the test: saving must cost no upstream request. */
const noUpstream: ProfileProvider = {
  async getSelectedProfile(): Promise<HypixelResult<SkyblockProfileData>> {
    throw new Error("saveSnapshot must not fetch from Hypixel");
  },
  async listProfiles(): Promise<HypixelResult<readonly SkyblockProfileData[]>> {
    throw new Error("saveSnapshot must not fetch from Hypixel");
  },
};

function saveService(repo: ProgressionRepository): ProgressionServiceImpl {
  return new ProgressionServiceImpl({
    profiles: noUpstream,
    networth: networthStub({ total: 1, exact: true, missing: [], breakdown: {}, topItems: {} }),
    repo,
    logger: silent,
  });
}

test("saving a snapshot copies a stored reading and never fetches", async () => {
  // The provider throws on any call, so reaching the assertion at all is the
  // proof: an explicit, member-triggered save is not a way to poll Hypixel on
  // demand (docs/HYPIXEL_COMPLIANCE.md §1).
  const calls: { uuid: string; savedBy: string; label: string | null }[] = [];
  const svc = saveService(saveRepo({ kind: "SAVED", capturedAt: "2026-08-21T10:00:00.000Z", savedCount: 5 }, calls));

  const r = await svc.saveSnapshot("uuid-aria", "111", null);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.savedCount, 5);
    assert.equal(r.value.limit, SAVED_SNAPSHOT_LIMIT);
    assert.equal(r.value.capturedAt, "2026-08-21T10:00:00.000Z");
  }
  assert.deepEqual(calls, [{ uuid: "uuid-aria", savedBy: "111", label: null }]);
});

test("a label is trimmed and bounded, and blank is the same as none", async () => {
  const calls: { uuid: string; savedBy: string; label: string | null }[] = [];
  const svc = saveService(saveRepo({ kind: "SAVED", capturedAt: "t", savedCount: 1 }, calls));

  await svc.saveSnapshot("u", "111", "   ");
  await svc.saveSnapshot("u", "111", "  before dungeon grind  ");
  await svc.saveSnapshot("u", "111", "x".repeat(200));

  assert.equal(calls[0]?.label, null, "whitespace is not a name");
  assert.equal(calls[1]?.label, "before dungeon grind");
  // Truncated rather than rejected — somebody who typed an essay meant its start.
  assert.equal(calls[2]?.label?.length, 60);
});

test("each way a save can fail keeps its own kind", async () => {
  const calls: { uuid: string; savedBy: string; label: string | null }[] = [];
  const none = await saveService(saveRepo({ kind: "NO_READING" }, calls)).saveSnapshot("u", "1", null);
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.error.kind, "NO_READING");

  const dup = await saveService(saveRepo({ kind: "ALREADY_SAVED", capturedAt: "t" }, calls))
    .saveSnapshot("u", "1", null);
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.equal(dup.error.kind, "ALREADY_SAVED");

  // No repository at all is a deployment fact, not a member's problem.
  const off = new ProgressionServiceImpl({
    profiles: noUpstream,
    networth: networthStub({ total: 1, exact: true, missing: [], breakdown: {}, topItems: {} }),
    logger: silent,
  });
  const unavailable = await off.saveSnapshot("u", "1", null);
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.error.kind, "UNAVAILABLE");
});
