import assert from "node:assert/strict";
import test from "node:test";
import { countPodiumsIn, type ScoreRow } from "./podium.js";

function row(over: Partial<ScoreRow> = {}): ScoreRow {
  return { eventId: "e1", metric: "skillAverage", discordId: "u1", delta: 10, ...over };
}

test("a clear win is one podium", () => {
  const rows = [row({ discordId: "u1", delta: 30 }), row({ discordId: "u2", delta: 20 })];
  assert.equal(countPodiumsIn(rows, "u1"), 1);
});

test("fourth place is not a podium", () => {
  const rows = [
    row({ discordId: "a", delta: 40 }),
    row({ discordId: "b", delta: 30 }),
    row({ discordId: "c", delta: 20 }),
    row({ discordId: "u1", delta: 10 }),
  ];
  assert.equal(countPodiumsIn(rows, "u1"), 0);
});

test("a tie shares the place and consumes the ones after it", () => {
  // 40, 30, 30, 20 places as 1, 2, 2, 4 — so the 20 is off the podium even
  // though it is the third-best number on the board.
  const rows = [
    row({ discordId: "a", delta: 40 }),
    row({ discordId: "b", delta: 30 }),
    row({ discordId: "c", delta: 30 }),
    row({ discordId: "u1", delta: 20 }),
  ];
  assert.equal(countPodiumsIn(rows, "u1"), 0);
  assert.equal(countPodiumsIn(rows, "c"), 1);
});

test("a three-way tie for first is three podiums, not one", () => {
  const rows = [
    row({ discordId: "a", delta: 40 }),
    row({ discordId: "b", delta: 40 }),
    row({ discordId: "u1", delta: 40 }),
  ];
  assert.equal(countPodiumsIn(rows, "u1"), 1);
});

test("gaining nothing is unranked, however few people turned up", () => {
  const rows = [row({ discordId: "u1", delta: 0 }), row({ discordId: "u2", delta: -5 })];
  assert.equal(countPodiumsIn(rows, "u1"), 0);
  assert.equal(countPodiumsIn(rows, "u2"), 0);
});

test("a two-metric event has two podiums to win", () => {
  const rows = [
    row({ eventId: "e1", metric: "skillAverage", discordId: "u1", delta: 30 }),
    row({ eventId: "e1", metric: "skillAverage", discordId: "u2", delta: 10 }),
    row({ eventId: "e1", metric: "slayerXp", discordId: "u1", delta: 30 }),
    row({ eventId: "e1", metric: "slayerXp", discordId: "u2", delta: 10 }),
  ];
  assert.equal(countPodiumsIn(rows, "u1"), 2);
});

test("boards are per event, so the same metric in two events counts twice", () => {
  const rows = [
    row({ eventId: "e1", discordId: "u1", delta: 30 }),
    row({ eventId: "e1", discordId: "u2", delta: 10 }),
    row({ eventId: "e2", discordId: "u1", delta: 5 }),
    row({ eventId: "e2", discordId: "u2", delta: 1 }),
  ];
  assert.equal(countPodiumsIn(rows, "u1"), 2);
});

test("somebody with no scores at all holds nothing", () => {
  assert.equal(countPodiumsIn([], "u1"), 0);
  assert.equal(countPodiumsIn([row({ discordId: "other" })], "u1"), 0);
});
