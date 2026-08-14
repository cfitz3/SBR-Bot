/**
 * The screening policy. What is pinned here is mostly what the policy must
 * *not* do: pass someone it could not check, refuse someone whose stats it
 * could not read, or let arithmetic override a rule.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, parsePolicy, serializePolicy } from "./policy.js";
import {
  DEFAULT_POLICY,
  NO_HISTORY,
  UNREADABLE_STATS,
  type ApplicantStats,
  type ScammerFinding,
  type ScreeningPolicy,
} from "./types.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const DAY = 24 * 60 * 60_000;

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY);
}

/** A healthy, readable applicant who clears everything by default. */
const GOOD: ApplicantStats = {
  profileName: "Mango",
  skyblockLevel: 240,
  skillAverage: 42.5,
  catacombsLevel: 34,
  senitherWeight: 9200,
  networth: 4_500_000_000n,
  firstLoginAt: daysAgo(900),
  lastLoginAt: daysAgo(1),
  currentGuild: null,
  apiDisabled: false,
  unreadable: false,
  extra: {},
};

const CLEAR: ScammerFinding = { status: "CLEAR" };

function policy(over: Partial<ScreeningPolicy> = {}): ScreeningPolicy {
  return { ...DEFAULT_POLICY, ...over };
}

function run(over: {
  policy?: Partial<ScreeningPolicy>;
  scammer?: ScammerFinding;
  stats?: Partial<ApplicantStats>;
  history?: Partial<typeof NO_HISTORY>;
} = {}) {
  return evaluate({
    policy: policy(over.policy),
    scammer: over.scammer ?? CLEAR,
    stats: { ...GOOD, ...over.stats },
    history: { ...NO_HISTORY, ...over.history },
  });
}

// ── the happy path ──

test("a clean, qualified applicant is accepted", () => {
  const d = run();
  assert.equal(d.verdict, "ACCEPT");
  assert.equal(d.riskScore, 0);
  assert.deepEqual(d.reasons, ["MEETS_REQUIREMENTS"]);
});

// ── the scammer list ──

test("a listed scammer is denied", () => {
  const d = run({ scammer: { status: "FLAGGED", reason: "IRL trading", source: "UUID" } });
  assert.equal(d.verdict, "DENY");
  assert.ok(d.reasons.includes("SCAMMER_FLAGGED"));
  assert.equal(d.riskScore, 100);
});

test("a guild that would rather judge for itself gets a review, not a denial", () => {
  const d = run({
    policy: { denyOnScammer: false },
    scammer: { status: "FLAGGED", reason: null, source: "DISCORD" },
  });
  assert.equal(d.verdict, "REVIEW");
});

test("an unreachable scammer list holds the request — it never reads as clear", () => {
  const d = run({ scammer: { status: "UNKNOWN", detail: "rate limited" } });
  assert.equal(d.verdict, "REVIEW");
  assert.ok(d.reasons.includes("SCAMMER_UNKNOWN"));
});

test("a guild may opt out of holding on an unreachable list, and then it accepts", () => {
  // Recorded as a reason either way, so the row still says we did not check.
  const d = run({ policy: { reviewOnScammerUnknown: false }, scammer: { status: "UNKNOWN", detail: null } });
  assert.equal(d.verdict, "ACCEPT");
  assert.ok(d.reasons.includes("SCAMMER_UNKNOWN"));
});

// ── history ──

test("a previous expulsion is denied by default", () => {
  const d = run({ history: { priorExpulsion: true, expulsionReason: "kicked for scamming" } });
  assert.equal(d.verdict, "DENY");
});

test("a previous denial holds rather than refusing outright — people improve", () => {
  const d = run({ history: { priorDenial: true } });
  assert.equal(d.verdict, "REVIEW");
});

test("hammering the join button is a hold once it passes the guild's limit", () => {
  assert.equal(run({ history: { recentAttempts: 2 } }).verdict, "ACCEPT");
  const d = run({ history: { recentAttempts: 3 } });
  assert.equal(d.verdict, "REVIEW");
  assert.ok(d.reasons.includes("REPEAT_ATTEMPTS"));
});

// ── the account ──

test("an unreadable account is held, not accepted", () => {
  const d = evaluate({ policy: policy(), scammer: CLEAR, stats: UNREADABLE_STATS });
  assert.equal(d.verdict, "REVIEW");
  assert.ok(d.reasons.includes("STATS_UNREADABLE"));
});

test("a partly-hidden API is its own, milder reason", () => {
  const d = run({ stats: { apiDisabled: true } });
  assert.equal(d.verdict, "REVIEW");
  assert.ok(d.reasons.includes("API_DISABLED"));
  assert.ok(!d.reasons.includes("STATS_UNREADABLE"));
});

// ── no stat is a gate any more ──

test("a beginner account with the worst stats in the game is still accepted", () => {
  // The whole of the old requirement ladder in one case. A fresh, dormant,
  // near-empty account clears screening now, because the scam check is the only
  // entry requirement and none of these numbers decides anything.
  const d = run({
    stats: {
      skyblockLevel: 4,
      skillAverage: 1,
      catacombsLevel: 0,
      senitherWeight: 3,
      networth: 0n,
      firstLoginAt: daysAgo(1),
      lastLoginAt: daysAgo(400),
    },
  });
  assert.equal(d.verdict, "ACCEPT");
  assert.deepEqual(d.reasons, ["MEETS_REQUIREMENTS"]);
});

test("the stats are still read, so staff can see what they are looking at", () => {
  // Screening reports rather than grades: an unreadable account still holds,
  // because "we could not check" is a different answer from "they are small".
  const d = evaluate({ policy: policy(), scammer: CLEAR, stats: UNREADABLE_STATS });
  assert.ok(d.reasons.includes("STATS_UNREADABLE"));
});

// ── scoring ──

test("the score escalates an otherwise-passing request but never rescues a failing one", () => {
  const lenient = policy({ reviewOnScammerUnknown: false, reviewAtRisk: 20 });
  const d = evaluate({ policy: lenient, scammer: { status: "UNKNOWN", detail: null }, stats: GOOD });
  assert.equal(d.verdict, "REVIEW"); // 25 ≥ 20, though no rule held it

  // And a rule-driven hold stands even when the score is trivially low.
  const strict = policy({ reviewAtRisk: 100 });
  assert.equal(
    evaluate({ policy: strict, scammer: CLEAR, stats: GOOD, history: { ...NO_HISTORY, priorDenial: true } }).verdict,
    "REVIEW",
  );
});

test("risk is capped at 100 however many reasons pile up", () => {
  const d = run({
    scammer: { status: "FLAGGED", reason: null, source: "UUID" },
    history: { priorExpulsion: true, priorDenial: true, recentAttempts: 9 },
    stats: { unreadable: true },
  });
  assert.equal(d.riskScore, 100);
});

// ── parsing ──

test("a missing or malformed policy falls back to the defaults", () => {
  for (const junk of [null, undefined, "nope", 42, [], { reviewAtRisk: "twelve" }]) {
    const p = parsePolicy(junk);
    assert.equal(p.repeatWindowDays, DEFAULT_POLICY.repeatWindowDays);
    assert.equal(p.reviewAtRisk, DEFAULT_POLICY.reviewAtRisk);
  }
});

test("the defaults record and report but admit nobody on their own", () => {
  assert.equal(DEFAULT_POLICY.autoAccept, false);
});

test("a stored policy still carrying the retired stat bars is read without them", () => {
  // Every guild that configured a threshold before they were removed still has
  // one in its settings row. Parsing must drop it, not choke on it.
  const p = parsePolicy({ enabled: false, minCatacombs: 40, minNetworth: "10000000000", somethingWeRenamed: true });
  assert.equal(p.enabled, false);
  assert.equal("minCatacombs" in p, false);
  assert.equal("minNetworth" in p, false);
});

test("serializing is JSON-safe", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(serializePolicy(DEFAULT_POLICY))), { ...DEFAULT_POLICY });
});
