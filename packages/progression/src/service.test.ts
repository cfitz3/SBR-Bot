import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hypixelFailure,
  ok,
  type DataEnvelope,
  type HypixelResult,
  type NetworthDTO,
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
