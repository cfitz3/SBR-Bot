import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { LeaderboardSource } from "./ports.js";
import { DEFAULT_POSITION_CATEGORIES, LeaderboardService } from "./service.js";
import { CATEGORY_SPECS, type LeaderboardCategory, type MemberValue } from "./types.js";

function values(...pairs: readonly (readonly [string, number])[]): MemberValue[] {
  return pairs.map(([label, value]) => ({ key: label, label, value, at: null }));
}

interface StubOptions {
  readonly rows?: Partial<Record<LeaderboardCategory, MemberValue[]>>;
  readonly viewer?: string | null;
  readonly failOn?: LeaderboardCategory;
}

function source(options: StubOptions = {}): LeaderboardSource {
  return {
    async values(_guildId, category) {
      if (options.failOn === category) throw new Error("source down");
      return options.rows?.[category] ?? values(["a", 30], ["me", 20], ["b", 10]);
    },
    async roster() {
      return [];
    },
    async viewerKey() {
      return options.viewer === undefined ? "me" : options.viewer;
    },
  };
}

test("reports a rank per default category", async () => {
  const rows = await new LeaderboardService(source()).positions("g1", "111");
  assert.deepEqual(
    rows.map((r) => r.category),
    [...DEFAULT_POSITION_CATEGORIES],
  );
  for (const row of rows) {
    assert.equal(row.rank, 2);
    assert.equal(row.value, 20);
    assert.equal(row.totalRanked, 3);
    assert.equal(row.label, CATEGORY_SPECS[row.category].label);
  }
});

test("totalRanked counts ranked members only", async () => {
  // Two of the five have nothing to rank; "12th of 40" must mean the same
  // thing on the card as it does on the board.
  const rows = values(["a", 30], ["me", 20], ["b", 10], ["c", 0], ["d", -1]);
  const positions = await new LeaderboardService(
    source({ rows: { level: rows, wealth: rows, catacombs: rows, xp: rows } }),
  ).positions("g1", "111");
  assert.equal(positions[0]?.totalRanked, 3);
});

test("an unlinked caller has no position anywhere", async () => {
  const rows = await new LeaderboardService(source({ viewer: null })).positions("g1", "111");
  assert.deepEqual(rows, []);
});

test("a caller with no ranked value is absent rather than last", async () => {
  const rows = values(["a", 30], ["b", 10], ["me", 0]);
  const positions = await new LeaderboardService(
    source({ rows: { level: rows, wealth: rows, catacombs: rows, xp: rows } }),
  ).positions("g1", "111");
  assert.deepEqual(positions, []);
});

test("one unreadable board does not blank the others", async () => {
  const positions = await new LeaderboardService(source({ failOn: "wealth" })).positions("g1", "111");
  assert.deepEqual(
    positions.map((r) => r.category),
    DEFAULT_POSITION_CATEGORIES.filter((c) => c !== "wealth"),
  );
});

test("explicit categories are honoured and de-duplicated", async () => {
  const positions = await new LeaderboardService(source()).positions("g1", "111", [
    "xp",
    "xp",
    "level",
  ]);
  assert.deepEqual(
    positions.map((r) => r.category),
    ["xp", "level"],
  );
});
