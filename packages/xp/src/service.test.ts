import test from "node:test";
import assert from "node:assert/strict";
import { XpService } from "./service.js";
import type { ActivityRow, ActivitySink, BalanceRow, LedgerRow, LevelClimb, XpRepository } from "./ports.js";
import type { ActivityCounters, XpAward, XpSource, XpSourcePolicy } from "./types.js";
import { NO_ACTIVITY } from "./types.js";

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
};

function rule(source: XpSource, over: Partial<XpSourcePolicy> = {}): XpSourcePolicy {
  return { source, enabled: true, weight: 1, dailyCap: null, cooldownSec: 0, minLength: 0, ...over };
}

interface Fakes {
  readonly bumps: { discordId: string; day: string; field: keyof ActivityCounters; by: number }[];
  readonly recorded: XpAward[];
  readonly saved: BalanceRow[][];
  readonly climbs: LevelClimb[];
  ledger: LedgerRow[];
}

function makeService(over: {
  policy?: readonly XpSourcePolicy[];
  activity?: readonly ActivityRow[];
  gexp?: readonly { discordId: string; gexp: number }[];
  tenure?: readonly { discordId: string; days: number }[];
  events?: readonly { discordId: string; count: number }[];
  ledger?: LedgerRow[];
  levels?: readonly { discordId: string; level: number }[];
  allowCooldown?: boolean;
  logger?: unknown;
  brokenSink?: boolean;
  now?: () => Date;
} = {}): { svc: XpService; fakes: Fakes } {
  const fakes: Fakes = { bumps: [], recorded: [], saved: [], climbs: [], ledger: over.ledger ?? [] };

  const repo: XpRepository = {
    async policy() {
      return over.policy ?? [];
    },
    async setSourcePolicy(_g, p) {
      return p;
    },
    async levels() {
      return over.levels ?? [];
    },
    async recordLevelUps(_g, climbs) {
      fakes.climbs.push(...climbs);
    },
    async activityForDay() {
      return over.activity ?? [];
    },
    async gexpForDay() {
      return over.gexp ?? [];
    },
    async tenureForDay() {
      return over.tenure ?? [];
    },
    async eventsForDay() {
      return over.events ?? [];
    },
    async recordAwards(_g, awards) {
      fakes.recorded.push(...awards);
      // Mirror the upsert-on-dedupeKey contract so a replay converges here too.
      for (const a of awards) {
        const i = fakes.ledger.findIndex(
          (r) => a.dedupeKey !== null && r.discordId === a.discordId && r.source === a.source && r.day === a.day,
        );
        const row: LedgerRow = {
          discordId: a.discordId,
          source: a.source,
          amount: a.amount,
          rawValue: a.rawValue,
          day: a.day,
          createdAt: new Date("2026-08-09T00:00:00Z"),
        };
        if (i >= 0) fakes.ledger[i] = row;
        else fakes.ledger.push(row);
      }
    },
    async ledger() {
      return fakes.ledger;
    },
    async saveBalances(_g, balances) {
      fakes.saved.push([...balances]);
    },
    async balance(_g, discordId) {
      const latest = fakes.saved[fakes.saved.length - 1] ?? [];
      return latest.find((b) => b.discordId === discordId) ?? null;
    },
    async rank() {
      return 1;
    },
    async top(_g, limit) {
      const latest = fakes.saved[fakes.saved.length - 1] ?? [];
      return [...latest].sort((a, b) => b.totalXp - a.totalXp).slice(0, limit);
    },
  };

  const activity: ActivitySink = {
    async bump(_g, discordId, day, field, by) {
      if (over.brokenSink === true) throw new Error("redis down");
      fakes.bumps.push({ discordId, day, field, by });
    },
  };

  const svc = new XpService({
    repo,
    activity,
    cooldowns: { async consume() { return { allowed: over.allowCooldown ?? true }; } },
    logger: (over.logger ?? logger) as never,
    now: over.now ?? (() => new Date("2026-08-09T12:00:00Z")),
  });
  return { svc, fakes };
}

// ───────────────────────────── the hot path ─────────────────────────────

test("a countable message bumps the counter, not the ledger", () => {
  return (async () => {
    const { svc, fakes } = makeService({ policy: [rule("DISCORD_MESSAGE", { minLength: 4 })] });
    assert.equal(await svc.recordMessage("g1", "u1", "DISCORD_MESSAGE", "hello there"), true);
    assert.deepEqual(fakes.bumps, [{ discordId: "u1", day: "2026-08-09", field: "discordMessages", by: 1 }]);
    assert.deepEqual(fakes.recorded, []);
  })();
});

test("a too-short message is not counted", async () => {
  const { svc, fakes } = makeService({ policy: [rule("DISCORD_MESSAGE", { minLength: 8 })] });
  assert.equal(await svc.recordMessage("g1", "u1", "DISCORD_MESSAGE", "gg"), false);
  assert.deepEqual(fakes.bumps, []);
});

test("an unconfigured guild still counts the message, and still earns nothing", async () => {
  // These counters are the Analytics page's "messages", not only XP's input.
  // Refusing to count them until someone opts into XP made every fresh install
  // read as a server where nobody had ever spoken.
  //
  // The farming defence is unaffected because it lives at the award end: an
  // unconfigured source is disabled and weightless, so the counter this writes
  // is worth zero XP ("an unconfigured source earns nothing even when the
  // counter moved", policy.test.ts).
  const { svc, fakes } = makeService({ policy: [] });
  assert.equal(await svc.recordMessage("g1", "u1", "DISCORD_MESSAGE", "a real message"), true);
  assert.deepEqual(fakes.bumps, [{ discordId: "u1", day: "2026-08-09", field: "discordMessages", by: 1 }]);
  assert.deepEqual(fakes.recorded, [], "counting is not awarding");
});

test("an explicitly disabled source is not counted", async () => {
  // A guild that turned the source off made a decision; unconfigured is the
  // absence of one, and only the absence defaults to counting.
  const { svc, fakes } = makeService({ policy: [rule("DISCORD_MESSAGE", { enabled: false })] });
  assert.equal(await svc.recordMessage("g1", "u1", "DISCORD_MESSAGE", "a real message"), false);
  assert.deepEqual(fakes.bumps, []);
});

test("an empty message is never counted, configured or not", async () => {
  const { svc, fakes } = makeService({ policy: [] });
  assert.equal(await svc.recordMessage("g1", "u1", "DISCORD_MESSAGE", "   "), false);
  assert.deepEqual(fakes.bumps, []);
});

test("a message inside the cooldown is dropped", async () => {
  const { svc, fakes } = makeService({
    policy: [rule("DISCORD_MESSAGE", { cooldownSec: 30 })],
    allowCooldown: false,
  });
  assert.equal(await svc.recordMessage("g1", "u1", "DISCORD_MESSAGE", "a real message"), false);
  assert.deepEqual(fakes.bumps, []);
});

test("guild chat lands in its own counter", async () => {
  const { svc, fakes } = makeService({ policy: [rule("GUILD_CHAT_MESSAGE")] });
  await svc.recordMessage("g1", "u1", "GUILD_CHAT_MESSAGE", "anyone for f7");
  assert.equal(fakes.bumps[0]?.field, "guildChatMessages");
});

test("a broken counter costs XP, not the message", async () => {
  // A member's message must not fail because the bookkeeping did, so the hot
  // path swallows and logs rather than propagating.
  const warnings: string[] = [];
  const { svc } = makeService({
    policy: [rule("DISCORD_MESSAGE")],
    logger: { ...logger, warn: (m: string) => void warnings.push(m) },
    brokenSink: true,
  });
  assert.equal(await svc.recordMessage("g1", "u1", "DISCORD_MESSAGE", "hello"), false);
  assert.equal(warnings.length, 1);
});

// ───────────────────────────── aggregation ─────────────────────────────

const fullPolicy = [
  rule("GEXP", { weight: 0.05 }),
  rule("DISCORD_MESSAGE", { dailyCap: 60 }),
  rule("TENURE", { weight: 10 }),
];

test("aggregation derives a day from counters and rebuilds balances", async () => {
  const { svc, fakes } = makeService({
    policy: fullPolicy,
    activity: [{ discordId: "u1", day: "2026-08-09", counters: { ...NO_ACTIVITY, discordMessages: 12 } }],
    gexp: [{ discordId: "u1", gexp: 2400 }],
    tenure: [{ discordId: "u1", days: 40 }],
  });

  const summary = await svc.aggregate("g1", "2026-08-09");
  assert.equal(summary.membersConsidered, 1);
  assert.equal(summary.awardsWritten, 3);
  assert.equal(summary.balancesRebuilt, 1);

  const balance = fakes.saved.at(-1)?.[0];
  assert.equal(balance?.totalXp, 12 + 120 + 10);
  assert.equal(balance?.tenureDays, 40);
  assert.deepEqual(balance?.bySource, { DISCORD_MESSAGE: 12, GEXP: 120, TENURE: 10 });
});

test("a member with GEXP but no messages still earns", async () => {
  const { svc, fakes } = makeService({ policy: fullPolicy, gexp: [{ discordId: "u2", gexp: 1000 }] });
  await svc.aggregate("g1", "2026-08-09");
  assert.equal(fakes.saved.at(-1)?.[0]?.discordId, "u2");
  assert.equal(fakes.saved.at(-1)?.[0]?.totalXp, 50);
});

test("re-running a day converges instead of double-crediting", async () => {
  // The reason derived awards carry a dedupe key at all: today's counters keep
  // climbing, so the job runs over a day that is not finished yet.
  const { svc, fakes } = makeService({ policy: fullPolicy, gexp: [{ discordId: "u1", gexp: 2400 }] });
  await svc.aggregate("g1", "2026-08-09");
  await svc.aggregate("g1", "2026-08-09");
  assert.equal(fakes.ledger.length, 1);
  assert.equal(fakes.saved.at(-1)?.[0]?.totalXp, 120);
});

test("nobody active means no awards and no balances", async () => {
  const { svc, fakes } = makeService({ policy: fullPolicy });
  const summary = await svc.aggregate("g1", "2026-08-09");
  assert.equal(summary.awardsWritten, 0);
  assert.deepEqual(fakes.recorded, []);
});

// ───────────────────────────── adjustments ─────────────────────────────

test("a manual adjustment is reasoned, attributed and never deduped", async () => {
  const { svc, fakes } = makeService({ policy: [rule("MANUAL")] });
  await svc.adjust("g1", "u1", 250, "event host", "staff1");
  const award = fakes.recorded[0];
  assert.equal(award?.source, "MANUAL");
  assert.equal(award?.amount, 250);
  assert.equal(award?.dedupeKey, null);
  assert.deepEqual(award?.meta, { reason: "event host", by: "staff1" });
});

test("two identical adjustments are two decisions, not a replay", async () => {
  const { svc, fakes } = makeService({ policy: [rule("MANUAL")] });
  await svc.adjust("g1", "u1", 100, "same reason", "staff1");
  await svc.adjust("g1", "u1", 100, "same reason", "staff1");
  assert.equal(fakes.ledger.length, 2);
  assert.equal(fakes.saved.at(-1)?.[0]?.totalXp, 200);
});

test("a deduction can empty a balance but never invert it", async () => {
  const { svc, fakes } = makeService({ policy: [rule("MANUAL")] });
  await svc.adjust("g1", "u1", 100, "award", "staff1");
  await svc.adjust("g1", "u1", -500, "reversed", "staff1");
  assert.equal(fakes.saved.at(-1)?.[0]?.totalXp, 0);
  assert.equal(fakes.saved.at(-1)?.[0]?.level, 0);
});

test("an adjustment rebuilds immediately, because staff will look at the result", async () => {
  const { svc } = makeService({ policy: [rule("MANUAL")] });
  const standing = await svc.adjust("g1", "u1", 300, "why", "staff1");
  assert.equal(standing?.totalXp, 300);
  assert.equal(standing?.level, 2);
});

// ───────────────────────────── reads ─────────────────────────────

test("standing carries the level progress the embed draws", async () => {
  const { svc } = makeService({ policy: [rule("MANUAL")] });
  await svc.adjust("g1", "u1", 350, "seed", "staff1");
  const standing = await svc.standing("g1", "u1");
  assert.equal(standing?.level, 2);
  assert.equal(standing?.intoLevel, 50);
  assert.equal(standing?.levelSpan, 300);
  assert.equal(standing?.rank, 1);
});

test("a member who has never earned has no standing rather than a zeroed one", async () => {
  const { svc } = makeService();
  assert.equal(await svc.standing("g1", "nobody"), null);
});

test("the leaderboard ranks by total, densely, from 1", async () => {
  const { svc, fakes } = makeService({ policy: [rule("MANUAL")] });
  await svc.adjust("g1", "u1", 100, "a", "s");
  await svc.adjust("g1", "u2", 500, "b", "s");
  assert.ok(fakes.saved.length > 0);
  const board = await svc.leaderboard("g1", 10);
  assert.deepEqual(board.map((s) => [s.discordId, s.rank]), [
    ["u2", 1],
    ["u1", 2],
  ]);
});
