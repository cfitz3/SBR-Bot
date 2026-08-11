import test from "node:test";
import assert from "node:assert/strict";
import { awardsFor, countsAsMessage, dedupeKey, totalsBySource, weighted } from "./policy.js";
import { NO_ACTIVITY, disabledPolicy, type XpPolicy, type XpSourcePolicy } from "./types.js";

function rule(over: Partial<XpSourcePolicy> = {}): XpSourcePolicy {
  return {
    source: "DISCORD_MESSAGE",
    enabled: true,
    weight: 1,
    dailyCap: null,
    cooldownSec: 0,
    minLength: 0,
    ...over,
  };
}

// ───────────────────────────── message gating ─────────────────────────────

test("a message under the minimum length does not count", () => {
  assert.equal(countsAsMessage("gg", rule({ minLength: 4 })).counts, false);
  assert.equal(countsAsMessage("good game", rule({ minLength: 4 })).counts, true);
});

test("padding with whitespace does not clear the length bar", () => {
  assert.equal(countsAsMessage("hi        ", rule({ minLength: 4 })).counts, false);
});

test("an empty message never counts, even with no minimum", () => {
  assert.equal(countsAsMessage("   ", rule({ minLength: 0 })).counts, false);
});

test("a disabled source counts nothing", () => {
  assert.equal(countsAsMessage("a real message", rule({ enabled: false })).counts, false);
});

test("the cooldown comes back with the verdict so the caller reads config once", () => {
  assert.equal(countsAsMessage("hello there", rule({ cooldownSec: 30 })).cooldownSec, 30);
});

// ───────────────────────────── weighting ─────────────────────────────

test("a fractional weight rounds down", () => {
  // 2,400 GEXP × 0.05 = 120 exactly; 2,419 × 0.05 = 120.95, and the extra 0.95
  // must not become a whole XP.
  assert.equal(weighted(2419, rule({ weight: 0.05 })), 120);
});

test("the daily cap is the ceiling, not a scale", () => {
  assert.equal(weighted(500, rule({ dailyCap: 60 })), 60);
  assert.equal(weighted(12, rule({ dailyCap: 60 })), 12);
});

test("a disabled source is worth nothing regardless of raw value", () => {
  assert.equal(weighted(10_000, disabledPolicy("GEXP")), 0);
});

// ───────────────────────────── the day's awards ─────────────────────────────

const policy: XpPolicy = {
  GEXP: rule({ source: "GEXP", weight: 0.05 }),
  DISCORD_MESSAGE: rule({ source: "DISCORD_MESSAGE", dailyCap: 60 }),
  GUILD_CHAT_MESSAGE: rule({ source: "GUILD_CHAT_MESSAGE", dailyCap: 40 }),
  COMMAND_USAGE: rule({ source: "COMMAND_USAGE", dailyCap: 10 }),
  TENURE: rule({ source: "TENURE", weight: 10 }),
  EVENT: rule({ source: "EVENT", weight: 50 }),
};

test("each counter becomes its own award", () => {
  const awards = awardsFor(
    {
      discordId: "u1",
      day: "2026-08-09",
      counters: { ...NO_ACTIVITY, discordMessages: 12, guildChatMessages: 3, commandsUsed: 2 },
      gexp: 2400,
    },
    policy,
  );
  const by = Object.fromEntries(awards.map((a) => [a.source, a.amount]));
  assert.deepEqual(by, { DISCORD_MESSAGE: 12, GUILD_CHAT_MESSAGE: 3, COMMAND_USAGE: 2, GEXP: 120 });
});

test("a source that earned nothing produces no row at all", () => {
  const awards = awardsFor({ discordId: "u1", day: "2026-08-09", counters: NO_ACTIVITY }, policy);
  assert.deepEqual(awards, []);
});

test("an unconfigured source earns nothing even when the counter moved", () => {
  const awards = awardsFor(
    { discordId: "u1", day: "2026-08-09", counters: { ...NO_ACTIVITY, discordMessages: 40 } },
    { GEXP: policy.GEXP! },
  );
  assert.deepEqual(awards, []);
});

test("caps bind per source, not across the day", () => {
  const awards = awardsFor(
    {
      discordId: "u1",
      day: "2026-08-09",
      counters: { ...NO_ACTIVITY, discordMessages: 500, guildChatMessages: 500 },
    },
    policy,
  );
  const by = Object.fromEntries(awards.map((a) => [a.source, a.amount]));
  assert.equal(by["DISCORD_MESSAGE"], 60);
  assert.equal(by["GUILD_CHAT_MESSAGE"], 40);
});

test("tenure pays one day at a time, however long the member has been here", () => {
  // The running total belongs on the balance. Awarding it whole every night
  // would pay a year-old member 365 days of tenure every single night.
  const awards = awardsFor(
    { discordId: "u1", day: "2026-08-09", counters: NO_ACTIVITY, tenureDays: 400 },
    policy,
  );
  assert.equal(awards.length, 1);
  assert.equal(awards[0]?.source, "TENURE");
  assert.equal(awards[0]?.amount, 10);
  assert.equal(awards[0]?.rawValue, 1);
});

test("every derived award carries a key that is stable across runs", () => {
  const once = awardsFor({ discordId: "u1", day: "2026-08-09", counters: NO_ACTIVITY, gexp: 100 }, policy);
  const twice = awardsFor({ discordId: "u1", day: "2026-08-09", counters: NO_ACTIVITY, gexp: 100 }, policy);
  assert.equal(once[0]?.dedupeKey, twice[0]?.dedupeKey);
  assert.equal(once[0]?.dedupeKey, dedupeKey("GEXP", "u1", "2026-08-09"));
});

test("an award records what it was computed from, not just the result", () => {
  const awards = awardsFor({ discordId: "u1", day: "2026-08-09", counters: NO_ACTIVITY, gexp: 2400 }, policy);
  assert.equal(awards[0]?.rawValue, 2400);
  assert.equal(awards[0]?.amount, 120);
});

// ───────────────────────────── totals ─────────────────────────────

test("totals sum per source and keep deductions signed", () => {
  const totals = totalsBySource([
    { source: "GEXP", amount: 120 },
    { source: "GEXP", amount: 80 },
    { source: "MANUAL", amount: -50 },
  ]);
  assert.deepEqual(totals, { GEXP: 200, MANUAL: -50 });
});
