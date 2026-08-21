import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPodiums, memberPodiumSource, type PodiumRepository, type PodiumScoreRow } from "./podium.js";

const ME = "me";

function row(over: Partial<PodiumScoreRow> = {}): PodiumScoreRow {
  return {
    eventId: "e1",
    eventTitle: "Mining week",
    eventStatus: "COMPLETED",
    endsAt: "2026-08-01T00:00:00.000Z",
    metric: "skill:mining",
    discordId: ME,
    delta: 10,
    ...over,
  };
}

/** A contest with `deltas.length` entrants, the first of which is the caller. */
function contest(deltas: readonly number[], over: Partial<PodiumScoreRow> = {}): PodiumScoreRow[] {
  return deltas.map((delta, i) =>
    row({ ...over, delta, discordId: i === 0 ? ME : `other${String(i)}` }),
  );
}

// ── placing ──

test("gold when the member gained most in a contested metric", () => {
  const podium = buildPodiums(contest([50, 20, 10]), ME, { attended: 0 });
  assert.equal(podium.gold, 1);
  assert.equal(podium.silver, 0);
  assert.equal(podium.recent[0]?.place, 1);
  assert.equal(podium.recent[0]?.metric, "skill:mining");
});

test("places below the podium are not recorded", () => {
  const podium = buildPodiums(contest([1, 50, 40, 30]), ME, { attended: 0 });
  assert.equal(podium.gold + podium.silver + podium.bronze, 0);
  assert.deepEqual(podium.recent, []);
});

test("ties share a place and consume the ones after", () => {
  // Two entrants tie for first; the member is one of them, so gold not silver.
  const podium = buildPodiums(contest([50, 50, 10]), ME, { attended: 0 });
  assert.equal(podium.gold, 1);
  assert.equal(podium.silver, 0);
});

test("a tie for first leaves nobody in second", () => {
  const rows = contest([10, 50, 50], { metric: "networth" });
  const podium = buildPodiums(rows, ME, { attended: 0 });
  // The caller gained least of three, so third — not second.
  assert.equal(podium.bronze, 1);
  assert.equal(podium.silver, 0);
});

// ── what does not count ──

test("an event still running puts nobody on a podium", () => {
  const rows = contest([50, 10]).map((r) => ({ ...r, eventStatus: "ACTIVE" }));
  assert.deepEqual(buildPodiums(rows, ME, { attended: 0 }).recent, []);
});

test("winning against nobody is not a result", () => {
  const podium = buildPodiums([row({ delta: 999 })], ME, { attended: 0 });
  assert.equal(podium.gold, 0);
});

test("a single entrant is judged after zeroes are dropped, not before", () => {
  // Three rows, but only the member actually gained anything.
  const rows = contest([40, 0, 0]);
  assert.equal(buildPodiums(rows, ME, { attended: 0 }).gold, 0);
});

test("non-positive and non-finite deltas are unranked", () => {
  const rows = contest([-5, 0, Number.NaN, 12]);
  const podium = buildPodiums(rows, ME, { attended: 0 });
  assert.equal(podium.gold + podium.silver + podium.bronze, 0);
});

test("each metric of an event is its own contest", () => {
  const rows = [
    ...contest([50, 10], { metric: "skill:mining" }),
    ...contest([1, 900], { metric: "networth" }),
  ];
  const podium = buildPodiums(rows, ME, { attended: 0 });
  assert.equal(podium.gold, 1);
  assert.equal(podium.silver, 1);
});

// ── ordering and shape ──

test("recent placings are newest first, undated last", () => {
  const rows = [
    ...contest([50, 1], { eventId: "a", eventTitle: "Older", endsAt: "2026-01-01T00:00:00.000Z" }),
    ...contest([50, 1], { eventId: "b", eventTitle: "Newer", endsAt: "2026-07-01T00:00:00.000Z" }),
    ...contest([50, 1], { eventId: "c", eventTitle: "Undated", endsAt: null }),
  ];
  const podium = buildPodiums(rows, ME, { attended: 0, recentLimit: 5 });
  assert.deepEqual(
    podium.recent.map((p) => p.eventTitle),
    ["Newer", "Older", "Undated"],
  );
});

test("recent is capped but the medal tally is not", () => {
  const rows = [1, 2, 3, 4, 5].flatMap((n) =>
    contest([50, 1], { eventId: `e${String(n)}`, eventTitle: `Event ${String(n)}` }),
  );
  const podium = buildPodiums(rows, ME, { attended: 0, recentLimit: 2 });
  assert.equal(podium.gold, 5);
  assert.equal(podium.recent.length, 2);
});

test("attendance is carried through untouched", () => {
  assert.equal(buildPodiums([], ME, { attended: 14 }).attended, 14);
});

// ── the port ──

test("memberPodiumSource joins scores to attendance", async () => {
  const repo: PodiumRepository = {
    async scoresForMemberEvents() {
      return contest([50, 10]);
    },
    async countAttendance() {
      return 7;
    },
  };
  const result = await memberPodiumSource({ repo }).forMember("g1", ME);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.gold, 1);
  assert.equal(result.value.attended, 7);
});

test("a failed attendance count does not take the placings down with it", async () => {
  const repo: PodiumRepository = {
    async scoresForMemberEvents() {
      return contest([50, 10]);
    },
    async countAttendance() {
      throw new Error("db down");
    },
  };
  const result = await memberPodiumSource({ repo }).forMember("g1", ME);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.gold, 1);
  assert.equal(result.value.attended, 0);
});

test("the event limit reaches the repository", async () => {
  let seen = 0;
  const repo: PodiumRepository = {
    async scoresForMemberEvents(_g, _d, limit) {
      seen = limit;
      return [];
    },
    async countAttendance() {
      return 0;
    },
  };
  await memberPodiumSource({ repo, eventLimit: 5 }).forMember("g1", ME);
  assert.equal(seen, 5);
});
