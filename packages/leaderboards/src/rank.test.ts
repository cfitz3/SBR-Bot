import { strict as assert } from "node:assert";
import { test } from "node:test";
import { rank } from "./rank.js";
import { LeaderboardService } from "./service.js";
import { CATEGORY_SPECS, categoryFor, LEADERBOARD_CATEGORIES, type MemberValue } from "./types.js";

const XP = CATEGORY_SPECS.xp;
const CHAT = CATEGORY_SPECS["guild-chat"];

function values(...pairs: readonly (readonly [string, number])[]): MemberValue[] {
  return pairs.map(([label, value]) => ({ key: label, label, value, at: null }));
}

// ── ordering ──

test("ranks descending and numbers from one", () => {
  const page = rank(values(["b", 10], ["a", 30], ["c", 20]), { spec: XP });
  assert.deepEqual(
    page.entries.map((e) => [e.label, e.rank]),
    [
      ["a", 1],
      ["c", 2],
      ["b", 3],
    ],
  );
  assert.equal(page.totalRanked, 3);
});

test("ties share a rank and consume the ones after it", () => {
  const page = rank(values(["a", 50], ["b", 40], ["c", 40], ["d", 10]), { spec: XP });
  assert.deepEqual(
    page.entries.map((e) => e.rank),
    [1, 2, 2, 4],
  );
});

test("tied members are ordered by label, so the same data prints the same way", () => {
  const forward = rank(values(["zed", 40], ["alice", 40]), { spec: XP });
  const reverse = rank(values(["alice", 40], ["zed", 40]), { spec: XP });
  assert.deepEqual(
    forward.entries.map((e) => e.label),
    ["alice", "zed"],
  );
  assert.deepEqual(
    forward.entries.map((e) => e.label),
    reverse.entries.map((e) => e.label),
  );
});

test("members with nothing are not ranked at all", () => {
  const page = rank(values(["a", 10], ["b", 0], ["c", -5]), { spec: XP });
  assert.equal(page.totalRanked, 1);
  assert.equal(page.entries[0]?.label, "a");
});

test("a non-finite value is dropped rather than sorted", () => {
  const page = rank([{ key: "a", label: "a", value: Number.NaN, at: null }, ...values(["b", 3])], { spec: XP });
  assert.deepEqual(
    page.entries.map((e) => e.label),
    ["b"],
  );
});

// ── paging ──

test("pages from the top and reports how many there are", () => {
  const rows = values(...Array.from({ length: 25 }, (_, i) => [`m${i}`, 100 - i] as const));
  const first = rank(rows, { spec: XP, pageSize: 10 });
  assert.equal(first.pageCount, 3);
  assert.equal(first.entries.length, 10);
  assert.equal(first.entries[0]?.rank, 1);

  const third = rank(rows, { spec: XP, page: 3, pageSize: 10 });
  assert.equal(third.entries.length, 5);
  assert.equal(third.entries[0]?.rank, 21);
});

test("a page past the end clamps to the last one instead of erroring", () => {
  const page = rank(values(["a", 3], ["b", 2]), { spec: XP, page: 99, pageSize: 10 });
  assert.equal(page.page, 1);
  assert.equal(page.entries.length, 2);
});

test("an empty board is one empty page, not zero pages", () => {
  const page = rank([], { spec: XP });
  assert.equal(page.pageCount, 1);
  assert.equal(page.totalRanked, 0);
  assert.equal(page.entries.length, 0);
  assert.equal(page.oldestReadingAt, null);
});

test("page size is clamped to something a Discord embed can hold", () => {
  const rows = values(...Array.from({ length: 60 }, (_, i) => [`m${i}`, 100 - i] as const));
  assert.equal(rank(rows, { spec: XP, pageSize: 500 }).entries.length, 25);
  assert.equal(rank(rows, { spec: XP, pageSize: 0 }).entries.length, 1);
});

// ── the viewer ──

test("the viewer is marked on the page and not repeated below it", () => {
  const page = rank(values(["a", 30], ["b", 20]), { spec: XP, viewerKey: "b" });
  assert.equal(page.entries[1]?.isViewer, true);
  assert.equal(page.viewer, null);
});

test("a viewer off the page comes back separately, with their real rank", () => {
  const rows = values(...Array.from({ length: 20 }, (_, i) => [`m${i}`, 100 - i] as const));
  const page = rank(rows, { spec: XP, pageSize: 5, viewerKey: "m17" });
  assert.equal(page.viewer?.rank, 18);
  assert.equal(page.viewer?.isViewer, true);
});

test("an unranked viewer is simply absent — no zero row is invented", () => {
  const page = rank(values(["a", 30]), { spec: XP, viewerKey: "nobody" });
  assert.equal(page.viewer, null);
});

// ── freshness ──

test("staleness reports the oldest reading on the page, not the newest", () => {
  const page = rank(
    [
      { key: "a", label: "a", value: 3, at: "2026-08-09T10:00:00.000Z" },
      { key: "b", label: "b", value: 2, at: "2026-08-08T02:00:00.000Z" },
    ],
    { spec: CATEGORY_SPECS.wealth },
  );
  assert.equal(page.oldestReadingAt, "2026-08-08T02:00:00.000Z");
});

test("rows with no reading do not become the staleness answer", () => {
  const page = rank(
    [
      { key: "a", label: "a", value: 3, at: null },
      { key: "b", label: "b", value: 2, at: "2026-08-08T02:00:00.000Z" },
    ],
    { spec: CATEGORY_SPECS.wealth },
  );
  assert.equal(page.oldestReadingAt, "2026-08-08T02:00:00.000Z");
});

test("the window is reported only for categories that have one", () => {
  assert.equal(rank([], { spec: CHAT, windowDays: 30 }).windowDays, 30);
  assert.equal(rank([], { spec: XP, windowDays: 30 }).windowDays, null);
});

// ── the catalog ──

test("every category has a spec under its own id", () => {
  for (const id of LEADERBOARD_CATEGORIES) {
    assert.equal(CATEGORY_SPECS[id]?.id, id);
  }
});

test("categories resolve from their canonical name, punctuation and aliases", () => {
  assert.equal(categoryFor("skill-average"), "skill-average");
  assert.equal(categoryFor("Skill Average"), "skill-average");
  assert.equal(categoryFor("skill_average"), "skill-average");
  assert.equal(categoryFor("sa"), "skill-average");
  assert.equal(categoryFor(" NW "), "wealth");
  assert.equal(categoryFor("cata"), "catacombs");
  assert.equal(categoryFor("gc"), "guild-chat");
  assert.equal(categoryFor("nonsense"), null);
});

// ── the service ──

test("the service clamps the window and passes it to the source", () => {
  let asked: number | null = null;
  const service = new LeaderboardService({
    async values(_guildId, _category, windowDays) {
      asked = windowDays;
      return values(["a", 5]);
    },
    async roster() {
      return [];
    },
    async viewerKey() {
      return null;
    },
  });

  return service
    .page({ guildId: "g", category: "guild-chat", discordId: "1", windowDays: 10_000 })
    .then((page) => {
      assert.equal(asked, 365);
      assert.equal(page.windowDays, 365);
    });
});

test("a failing viewer lookup costs the caller their own row, not the board", async () => {
  const service = new LeaderboardService({
    async values() {
      return values(["a", 5]);
    },
    async roster() {
      return [];
    },
    async viewerKey() {
      throw new Error("db down");
    },
  });

  const page = await service.page({ guildId: "g", category: "xp", discordId: "1" });
  assert.equal(page.entries.length, 1);
  assert.equal(page.viewer, null);
});
