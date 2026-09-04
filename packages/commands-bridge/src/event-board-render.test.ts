/**
 * The event card: one message per event, at every stage of its life.
 *
 * Two things are being held here. The first is per-metric-family formatting —
 * the original renderer had one formatter written for the two big metrics, so
 * widening the catalog to eighteen made "+12.5k skill average" reachable. The
 * second is the shape of the card itself: which sections exist when, and that
 * none of the counts leak back into a field name, which is where they were
 * before and where they read as headings that change under the reader.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { formatMetricDelta, renderEventCard, type EventCardView } from "./index.js";

function view(over: Partial<EventCardView> = {}): EventCardView {
  return {
    eventId: "e1",
    title: "Dungeon night",
    status: "LIVE",
    startsAt: "2026-08-26T20:00:00.000Z",
    endsAt: "2026-08-26T23:00:00.000Z",
    metric: "catacombsLevel",
    standings: [{ discordId: "u1", delta: 1.5 }],
    participantCount: 4,
    updatedAt: "2026-08-26T21:00:00.000Z",
    ...over,
  };
}

function fields(v: EventCardView): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of renderEventCard(v).fields ?? []) out[f.name] = f.value;
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

test("the card names what it scores, and says so plainly when it scores nothing", () => {
  // In the opening lines rather than in a field: what an event ranks people on
  // is the reason to enter it, so it reads before the details do.
  assert.match(renderEventCard(view()).description ?? "", /Scored on \*\*catacombs level\*\*/);
  assert.match(renderEventCard(view({ metric: null })).description ?? "", /Turnout only/);
  assert.ok(!("Scoring" in fields(view())), "and not repeated as a field below");
});

/**
 * The signup message and the leaderboard are the same message. Which of the two
 * a reader is looking at is decided entirely by the event's status.
 */
test("a scheduled event shows its roster and no standings", () => {
  const f = fields(
    view({
      status: "SCHEDULED",
      going: [{ discordId: "u1" }, { discordId: "u2" }],
      maybe: [{ discordId: "u3" }],
    }),
  );
  assert.match(f["Who's coming"] ?? "", /Going \(2\)/);
  assert.match(f["Who's coming"] ?? "", /Maybe \(1\)/);
  assert.ok(!("Standings" in f));
});

test("a live event shows standings and drops the roster", () => {
  const f = fields(view({ going: [{ discordId: "u1" }] }));
  assert.ok("Standings" in f);
  assert.ok(!("Who's coming" in f));
});

test("nobody signed up yet is a sentence, not an empty field Discord would reject", () => {
  const f = fields(view({ status: "SCHEDULED" }));
  assert.equal(f["Who's coming"], "Nobody yet.");
});

test("no participants ranked reads as a first poll, not as an error", () => {
  const f = fields(view({ standings: [] }));
  assert.match(f["Standings"] ?? "", /baseline/);
});

test("an all-zero table says everyone is level rather than printing a column of +0", () => {
  const f = fields(
    view({
      metric: "skillAverage",
      standings: [
        { discordId: "u1", delta: 0 },
        { discordId: "u2", delta: 0 },
      ],
    }),
  );
  assert.match(f["Standings"] ?? "", /Nobody has gained any skill average yet/);
  assert.doesNotMatch(f["Standings"] ?? "", /\+0/);
});

/**
 * The counts used to be in the field names — "Top 4 · catacombs level", "Not
 * scored — no linked account (1)". Data in a heading is the one embed rule that
 * a renderer breaks without noticing, so it is asserted rather than reviewed.
 */
test("no field name carries a number", () => {
  const embed = renderEventCard(
    view({
      unlinked: [{ discordId: "u9" }, { discordId: "u8" }],
      standings: Array.from({ length: 4 }, (_, i) => ({ discordId: `u${i}`, delta: 10 - i })),
    }),
  );
  for (const f of embed.fields ?? []) assert.doesNotMatch(f.name, /\d/, `field name "${f.name}" carries data`);
});

test("the unlinked are counted inside the value and pointed at the fix", () => {
  const f = fields(view({ unlinked: [{ discordId: "u9" }] }));
  assert.match(f["Not scored"] ?? "", /\*\*1\*\*/);
  assert.match(f["Not scored"] ?? "", /\/link/);
  assert.match(f["Not scored"] ?? "", /<@u9>/);
});

test("the small facts are one field rather than five", () => {
  const f = fields(view({ prize: "500k coins", hostDiscordId: "u7", capacity: 20 }));
  const details = f["Details"] ?? "";
  assert.match(details, /\*\*Prize\*\* 500k coins/);
  assert.match(details, /\*\*Host\*\* <@u7>/);
  assert.match(details, /\*\*Signed up\*\* 4\/20/);
  assert.ok(!("Prize" in f), "the prize is a line, not a field of its own");
});

test("an uncapped event prints a count rather than a fraction of nothing", () => {
  assert.match(fields(view())["Details"] ?? "", /\*\*Signed up\*\* 4$/m);
});

test("a finished event says when it ended instead of counting down to it", () => {
  const details = fields(view({ status: "COMPLETED" }))["Details"] ?? "";
  assert.match(details, /\*\*Ended\*\*/);
  assert.doesNotMatch(details, /\*\*Ends\*\*/);
});

test("the podium is medals and the rest are numerals", () => {
  const standings = Array.from({ length: 4 }, (_, i) => ({ discordId: `u${i}`, delta: 10 - i }));
  const table = fields(view({ standings }))["Standings"] ?? "";
  assert.match(table, /🥇 <@u0>/);
  assert.match(table, /🥉 <@u2>/);
  assert.match(table, /\*\*4\.\*\* <@u3>/);
});

/**
 * The organiser's own words are the reason anyone signs up. They go in the
 * headline under the status line rather than into a field, which is where the
 * card layer puts a description and where a reader looks first.
 */
test("the status leads the headline and the organiser's description follows it", () => {
  const embed = renderEventCard(view({ status: "SCHEDULED", description: "Bring pots." }));
  assert.match(embed.description ?? "", /^Signups are open/);
  assert.match(embed.description ?? "", /Bring pots\.$/);
});

test("the card carries a native timestamp and a static footer", () => {
  const embed = renderEventCard(view());
  assert.equal(embed.timestamp, "2026-08-26T21:00:00.000Z");
  assert.equal(embed.footer, "id e1");
});
