import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectGexp,
  isCacheFresh,
  scanGuild,
  MEMBER_CACHE_TTL_MS,
  type CachedMemberRow,
  type GexpDailyWrite,
  type GuildScanDeps,
  type GuildScanResult,
  type MemberCacheWrite,
  type ScannedMember,
} from "./guild-scan.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");

function member(uuid: string, over: Partial<ScannedMember> = {}): ScannedMember {
  return { uuid, rank: "Member", joinedAt: null, expHistory: {}, weeklyGexp: 0, ...over };
}

interface Recorder {
  readonly upserts: MemberCacheWrite[][];
  readonly removed: string[][];
  readonly gexp: GexpDailyWrite[][];
  readonly scans: { result: GuildScanResult; error: string | null }[];
}

function deps(over: Partial<GuildScanDeps> & { cached?: readonly CachedMemberRow[] } = {}): {
  deps: GuildScanDeps;
  rec: Recorder;
} {
  const rec: Recorder = { upserts: [], removed: [], gexp: [], scans: [] };
  const cached = over.cached ?? [];
  return {
    rec,
    deps: {
      async fetchRoster() { return []; },
      async listCached() { return cached; },
      async upsertMembers(_g, rows) { rec.upserts.push([...rows]); },
      async removeMembers(_g, uuids) { rec.removed.push([...uuids]); },
      async writeGexp(_g, rows) { rec.gexp.push([...rows]); return rows.length; },
      async recordScan(_g, result, error) { rec.scans.push({ result, error }); },
      now: () => NOW,
      ...over,
    },
  };
}

test("a scan reports who joined and who left relative to the cache", async () => {
  const { deps: d, rec } = deps({
    cached: [{ uuid: "a", ign: "Ann" }, { uuid: "b", ign: "Ben" }],
    async fetchRoster() { return [member("a"), member("c")]; },
  });

  const result = await scanGuild("g1", d);
  assert.deepEqual(result.joined, ["c"]);
  assert.deepEqual(result.left, ["b"]);
  assert.equal(result.memberCount, 2);
  assert.deepEqual(rec.removed, [["b"]]);
});

test("a failed fetch writes nothing and evicts nobody", async () => {
  const { deps: d, rec } = deps({
    cached: [{ uuid: "a", ign: "Ann" }, { uuid: "b", ign: "Ben" }],
    async fetchRoster() { return null; },
  });

  const result = await scanGuild("g1", d);
  assert.equal(result.skipped, "fetch-failed");
  // The whole point: an unreadable API must not read as the guild disbanding.
  assert.deepEqual(rec.upserts, []);
  assert.deepEqual(rec.removed, []);
  assert.deepEqual(rec.gexp, []);
  assert.equal(rec.scans[0]?.error, "roster fetch failed");
});

test("a fetch that throws is treated as a failed fetch, not a crash", async () => {
  const { deps: d, rec } = deps({
    cached: [{ uuid: "a", ign: "Ann" }],
    async fetchRoster() { throw new Error("socket hang up"); },
  });

  const result = await scanGuild("g1", d);
  assert.equal(result.skipped, "fetch-failed");
  assert.deepEqual(rec.removed, []);
});

test("nobody is removed when the roster is unchanged", async () => {
  const { deps: d, rec } = deps({
    cached: [{ uuid: "a", ign: "Ann" }],
    async fetchRoster() { return [member("a")]; },
  });

  await scanGuild("g1", d);
  assert.deepEqual(rec.removed, [], "an empty removal must not cost a write");
});

test("cached names are kept and only the nameless are looked up", async () => {
  const asked: string[][] = [];
  const { deps: d, rec } = deps({
    cached: [{ uuid: "a", ign: "Ann" }, { uuid: "b", ign: null }],
    async fetchRoster() { return [member("a"), member("b"), member("c")]; },
    async resolveNames(uuids) { asked.push([...uuids]); return { b: "Ben", c: "Cal" }; },
  });

  await scanGuild("g1", d);
  assert.deepEqual([...(asked[0] ?? [])].sort(), ["b", "c"], "Ann is already known");
  const written = rec.upserts[0] ?? [];
  assert.deepEqual(
    written.map((r) => [r.uuid, r.ign]),
    [["a", "Ann"], ["b", "Ben"], ["c", "Cal"]],
  );
});

test("name lookups are capped, and a joiner is looked up before a known member", async () => {
  const asked: string[][] = [];
  const { deps: d } = deps({
    cached: [{ uuid: "a", ign: null }, { uuid: "b", ign: null }],
    async fetchRoster() { return [member("a"), member("b"), member("new")]; },
    async resolveNames(uuids) { asked.push([...uuids]); return {}; },
    nameBatchSize: 1,
  });

  await scanGuild("g1", d);
  assert.deepEqual(asked, [["new"]]);
});

test("a name lookup that fails leaves members nameless rather than failing the scan", async () => {
  const { deps: d, rec } = deps({
    async fetchRoster() { return [member("a")]; },
    async resolveNames() { throw new Error("mojang down"); },
  });

  const result = await scanGuild("g1", d);
  assert.equal(result.memberCount, 1);
  assert.equal(rec.upserts[0]?.[0]?.ign, null);
});

test("every member's expHistory becomes one row per day, zeroes included", () => {
  const rows = collectGexp([
    member("a", { expHistory: { "2026-08-08": 1_200, "2026-08-09": 0 } }),
    member("b", { expHistory: { "2026-08-09": 350 } }),
  ]);
  assert.deepEqual(rows, [
    { uuid: "a", day: "2026-08-08", gexp: 1_200 },
    { uuid: "a", day: "2026-08-09", gexp: 0 },
    { uuid: "b", day: "2026-08-09", gexp: 350 },
  ]);
});

test("a member with no GEXP history contributes no rows", () => {
  assert.deepEqual(collectGexp([member("a")]), []);
});

test("scan writes the flattened GEXP and reports the row count", async () => {
  const { deps: d, rec } = deps({
    async fetchRoster() { return [member("a", { expHistory: { "2026-08-09": 500 }, weeklyGexp: 500 })]; },
  });

  const result = await scanGuild("g1", d);
  assert.equal(result.gexpRows, 1);
  assert.deepEqual(rec.gexp[0], [{ uuid: "a", day: "2026-08-09", gexp: 500 }]);
  assert.equal(rec.upserts[0]?.[0]?.weeklyGexp, 500);
  assert.equal(rec.upserts[0]?.[0]?.refreshedAt.toISOString(), NOW.toISOString());
});

test("joinedAt is carried across as a Date, and absent stays absent", async () => {
  const at = Date.parse("2025-01-02T03:04:05.000Z");
  const { deps: d, rec } = deps({
    async fetchRoster() { return [member("a", { joinedAt: at }), member("b")]; },
  });

  await scanGuild("g1", d);
  assert.equal(rec.upserts[0]?.[0]?.joinedAt?.toISOString(), "2025-01-02T03:04:05.000Z");
  assert.equal(rec.upserts[0]?.[1]?.joinedAt, null);
});

test("cache freshness is bounded by the TTL and a never-scanned guild is stale", () => {
  const fresh = new Date(NOW.getTime() - MEMBER_CACHE_TTL_MS + 1_000);
  const stale = new Date(NOW.getTime() - MEMBER_CACHE_TTL_MS - 1_000);
  assert.equal(isCacheFresh(fresh, NOW, MEMBER_CACHE_TTL_MS), true);
  assert.equal(isCacheFresh(stale, NOW, MEMBER_CACHE_TTL_MS), false);
  assert.equal(isCacheFresh(null, NOW, MEMBER_CACHE_TTL_MS), false);
});
