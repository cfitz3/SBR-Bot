/**
 * How an event board reads, per metric family.
 *
 * The original renderer had one formatter and six metrics, and the formatter
 * was written for the two big ones — so widening the catalog to eighteen made
 * "+12.5k skill average" reachable. These tests are per family rather than per
 * metric, because the family is what decides the shape.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { formatMetricDelta, renderEventBoardEmbed, type EventBoardView } from "./index.js";

function view(over: Partial<EventBoardView> = {}): EventBoardView {
  return {
    eventId: "e1",
    title: "Dungeon night",
    status: "LIVE",
    startsAt: "2026-08-26T20:00:00.000Z",
    endsAt: "2026-08-26T23:00:00.000Z",
    metrics: [{ metric: "catacombsLevel", standings: [{ discordId: "u1", delta: 1.5 }] }],
    participantCount: 4,
    updatedAt: "2026-08-26T21:00:00.000Z",
    ...over,
  };
}

function fields(v: EventBoardView): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of renderEventBoardEmbed(v).fields ?? []) out[f.name] = f.value;
  return out;
}

test("XP and coin gains are abbreviated, because they arrive in the millions", () => {
  assert.equal(formatMetricDelta("slayerEnderman", 1_842_000), "+1.84m");
  assert.equal(formatMetricDelta("slayerXp", 12_500), "+12.5k");
  assert.equal(formatMetricDelta("networth", 2_400_000_000), "+2.4b");
});

test("levels are read literally, never abbreviated", () => {
  // The bug this covers: a shared formatter abbreviated at 10,000, which is
  // right for slayer XP and absurd for a level.
  assert.equal(formatMetricDelta("catacombsLevel", 4.82), "+4.82");
  assert.equal(formatMetricDelta("skillAverage", 0.75), "+0.75");
  assert.equal(formatMetricDelta("classHealer", 12), "+12");
  assert.equal(formatMetricDelta("skyblockLevel", 3), "+3");
});

test("weight is grouped rather than abbreviated", () => {
  assert.equal(formatMetricDelta("senitherWeight", 1234.5), "+1,234.5");
});

test("a bestiary milestone is a whole count of brackets crossed", () => {
  assert.equal(formatMetricDelta("bestiaryMilestone", 2.4), "+2");
});

test("a loss keeps its sign, and an unreadable number says so", () => {
  assert.equal(formatMetricDelta("networth", -5_000_000), "-5m");
  assert.equal(formatMetricDelta("catacombsLevel", Number.NaN), "—");
});

test("every tracked metric gets a table, and the board says what it is scoring", () => {
  const f = fields(
    view({
      metrics: [
        { metric: "catacombsLevel", standings: [{ discordId: "u1", delta: 2 }] },
        { metric: "slayerBlaze", standings: [{ discordId: "u2", delta: 300_000 }] },
      ],
    }),
  );
  assert.equal(f["Scoring"], "catacombs level · Inferno XP");
  assert.match(f["Top 1 · catacombs level"] ?? "", /\+2$/);
  assert.match(f["Top 1 · Inferno XP"] ?? "", /\+300k$/);
});

test("no participants ranked reads as a first poll, not as an error", () => {
  const f = fields(view({ metrics: [{ metric: "catacombsLevel", standings: [] }] }));
  assert.match(f["Standings · catacombs level"] ?? "", /baseline/);
});

test("an all-zero table says everyone is level rather than printing a column of +0", () => {
  const f = fields(
    view({
      metrics: [
        {
          metric: "skillAverage",
          standings: [
            { discordId: "u1", delta: 0 },
            { discordId: "u2", delta: 0 },
          ],
        },
      ],
    }),
  );
  assert.match(f["Top 2 · skill average"] ?? "", /Nobody has gained any skill average yet/);
  assert.doesNotMatch(f["Top 2 · skill average"] ?? "", /\+0/);
});

test("the prize, the end time and the unlinked are all on the board", () => {
  const f = fields(view({ prize: "500k coins", unlinked: [{ discordId: "u9" }] }));
  assert.equal(f["Prize"], "500k coins");
  assert.ok("Ends" in f);
  assert.match(f["Not scored — no linked account (1)"] ?? "", /<@u9>/);
});

test("a finished board drops the countdown rather than showing a negative one", () => {
  const f = fields(view({ status: "COMPLETED" }));
  assert.ok(!("Ends" in f));
});

test("an event tracking nothing renders without a standings section", () => {
  const f = fields(view({ metrics: [] }));
  assert.ok(!("Scoring" in f));
  assert.ok(Object.keys(f).includes("Participants"));
});

test("the podium is medals and the rest are numerals", () => {
  const standings = Array.from({ length: 4 }, (_, i) => ({ discordId: `u${i}`, delta: 10 - i }));
  const f = fields(view({ metrics: [{ metric: "catacombsLevel", standings }] }));
  const table = f["Top 4 · catacombs level"] ?? "";
  assert.match(table, /🥇 <@u0>/);
  assert.match(table, /🥉 <@u2>/);
  assert.match(table, /\*\*4\.\*\* <@u3>/);
});
