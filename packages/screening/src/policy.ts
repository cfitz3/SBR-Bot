/**
 * The screening policy: a pure function from "what we found out" to a verdict.
 *
 * Kept free of I/O so the rules can be argued with in tests rather than in
 * production. Everything the policy needs arrives as data; everything it
 * decides leaves as data.
 *
 * The shape of the decision is deliberately simple, because a scoring model
 * nobody can predict is a model staff stop trusting after the first surprise:
 *
 *   1. **Hard refusals** are reason-driven, not score-driven. A listed scammer
 *      is refused because they are listed, at any score.
 *   2. **Holds** are reason-driven too. Anything we could not find out, or any
 *      bar the applicant missed, holds the request for a human.
 *   3. **The score** exists to rank the staff queue and to escalate a request
 *      that collected several small concerns into a REVIEW. It never turns a
 *      REVIEW into an ACCEPT.
 *
 * So the score is an ordering device, and the reasons are the decision. If you
 * ever find yourself tuning weights to change an outcome, change the rule.
 */
import {
  DEFAULT_POLICY,
  NO_HISTORY,
  type ApplicantHistory,
  type ApplicantStats,
  type ScammerFinding,
  type ScreeningPolicy,
  type ScreeningPolicyView,
  type ScreeningReason,
  type ScreeningVerdict,
} from "./types.js";

const DAY_MS = 24 * 60 * 60_000;

/** Risk contributed by each reason. Bounded to 0–100 after summing. */
const WEIGHTS: Readonly<Record<ScreeningReason, number>> = {
  SCAMMER_FLAGGED: 100,
  SCAMMER_UNKNOWN: 25,
  PRIOR_EXPULSION: 100,
  PRIOR_DENIAL: 40,
  REPEAT_ATTEMPTS: 20,
  NEW_ACCOUNT: 30,
  INACTIVE: 15,
  STATS_UNREADABLE: 35,
  API_DISABLED: 20,
  BELOW_SKYBLOCK_LEVEL: 20,
  BELOW_SKILL_AVERAGE: 20,
  BELOW_CATACOMBS: 20,
  BELOW_WEIGHT: 20,
  BELOW_NETWORTH: 20,
  MEETS_REQUIREMENTS: 0,
};

export interface PolicyInput {
  readonly policy: ScreeningPolicy;
  readonly scammer: ScammerFinding;
  readonly stats: ApplicantStats;
  readonly history?: ApplicantHistory;
  /** Injected so tests are not at the mercy of the clock. */
  readonly now?: Date;
}

export interface PolicyDecision {
  readonly verdict: ScreeningVerdict;
  readonly riskScore: number;
  readonly reasons: readonly ScreeningReason[];
}

/**
 * A missing stat is not a failed bar.
 *
 * When a guild requires catacombs 20 and the applicant's dungeon API is off, we
 * do not know that they failed — we know we cannot tell. That is
 * `STATS_UNREADABLE`/`API_DISABLED` (a hold), not `BELOW_CATACOMBS` (a bar they
 * missed). Conflating the two would let a guild's requirements read as
 * accusations against people whose only offence is a privacy setting.
 */
function below(value: number | null, min: number | null): boolean {
  return min !== null && value !== null && value < min;
}

export function evaluate(input: PolicyInput): PolicyDecision {
  const { policy, scammer, stats } = input;
  const history = input.history ?? NO_HISTORY;
  const now = input.now ?? new Date();

  const reasons: ScreeningReason[] = [];
  let deny = false;
  let hold = false;

  // ── the scammer list ──
  if (scammer.status === "FLAGGED") {
    reasons.push("SCAMMER_FLAGGED");
    if (policy.denyOnScammer) deny = true;
    else hold = true;
  } else if (scammer.status === "UNKNOWN") {
    reasons.push("SCAMMER_UNKNOWN");
    if (policy.reviewOnScammerUnknown) hold = true;
  }

  // ── history with this guild ──
  if (history.priorExpulsion) {
    reasons.push("PRIOR_EXPULSION");
    if (policy.denyOnPriorExpulsion) deny = true;
    else hold = true;
  }
  if (history.priorDenial) {
    reasons.push("PRIOR_DENIAL");
    hold = true;
  }
  if (history.recentAttempts >= policy.maxAttemptsInWindow) {
    reasons.push("REPEAT_ATTEMPTS");
    hold = true;
  }

  // ── the account ──
  if (stats.unreadable) {
    reasons.push("STATS_UNREADABLE");
    if (policy.reviewOnUnreadable) hold = true;
  } else if (stats.apiDisabled) {
    reasons.push("API_DISABLED");
    if (policy.reviewOnUnreadable) hold = true;
  }

  if (policy.minAccountAgeDays !== null && stats.firstLoginAt) {
    const ageDays = (now.getTime() - stats.firstLoginAt.getTime()) / DAY_MS;
    if (ageDays < policy.minAccountAgeDays) {
      reasons.push("NEW_ACCOUNT");
      hold = true;
    }
  }

  if (policy.maxInactiveDays !== null && stats.lastLoginAt) {
    const idleDays = (now.getTime() - stats.lastLoginAt.getTime()) / DAY_MS;
    if (idleDays > policy.maxInactiveDays) {
      reasons.push("INACTIVE");
      hold = true;
    }
  }

  // ── requirement bars ──
  if (below(stats.skyblockLevel, policy.minSkyblockLevel)) reasons.push("BELOW_SKYBLOCK_LEVEL");
  if (below(stats.skillAverage, policy.minSkillAverage)) reasons.push("BELOW_SKILL_AVERAGE");
  if (below(stats.catacombsLevel, policy.minCatacombs)) reasons.push("BELOW_CATACOMBS");
  if (below(stats.senitherWeight, policy.minSenitherWeight)) reasons.push("BELOW_WEIGHT");
  if (policy.minNetworth !== null && stats.networth !== null && stats.networth < policy.minNetworth) {
    reasons.push("BELOW_NETWORTH");
  }
  const missedBar = reasons.some((r) => r.startsWith("BELOW_"));
  if (missedBar) hold = true;

  const riskScore = Math.min(
    100,
    reasons.reduce((sum, r) => sum + WEIGHTS[r], 0),
  );

  if (reasons.length === 0) reasons.push("MEETS_REQUIREMENTS");

  // The score only ever escalates. An ACCEPT that has quietly accumulated
  // several minor concerns is worth a glance; a REVIEW never falls back to
  // ACCEPT because its arithmetic came out low.
  const verdict: ScreeningVerdict = deny
    ? "DENY"
    : hold || riskScore >= policy.reviewAtRisk
      ? "REVIEW"
      : "ACCEPT";

  return { verdict, riskScore, reasons };
}

/** Weight of a single reason. Exported for the staff report's ordering. */
export function riskWeight(reason: ScreeningReason): number {
  return WEIGHTS[reason];
}

// ── policy parsing ──

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function positiveInt(v: unknown, fallback: number): number {
  const n = num(v);
  return n !== null && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Coins, from settings JSON. Accepted as a number or a string because JSON has
 * no bigint and 10 billion coins is past the point where a double stops being
 * exact — a guild typing `"10000000000"` deserves to get that number back.
 */
function coins(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return BigInt(Math.floor(v));
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return BigInt(v.trim());
  return null;
}

/**
 * Read a stored policy, filling anything absent or malformed from the defaults.
 *
 * Tolerant by design: this value is edited through the panel and could be years
 * older than the code reading it. A policy that throws on an unknown key would
 * take screening offline the first time a field is renamed; one that falls back
 * per-field degrades to the safe default instead.
 */
export function parsePolicy(raw: unknown): ScreeningPolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_POLICY;
  const r = raw as Record<string, unknown>;
  const d = DEFAULT_POLICY;
  return {
    enabled: bool(r["enabled"], d.enabled),
    autoAccept: bool(r["autoAccept"], d.autoAccept),
    denyOnScammer: bool(r["denyOnScammer"], d.denyOnScammer),
    reviewOnScammerUnknown: bool(r["reviewOnScammerUnknown"], d.reviewOnScammerUnknown),
    denyOnPriorExpulsion: bool(r["denyOnPriorExpulsion"], d.denyOnPriorExpulsion),
    reviewOnUnreadable: bool(r["reviewOnUnreadable"], d.reviewOnUnreadable),
    minSkyblockLevel: num(r["minSkyblockLevel"]),
    minSkillAverage: num(r["minSkillAverage"]),
    minCatacombs: num(r["minCatacombs"]),
    minSenitherWeight: num(r["minSenitherWeight"]),
    minNetworth: coins(r["minNetworth"]),
    minAccountAgeDays: num(r["minAccountAgeDays"]),
    maxInactiveDays: num(r["maxInactiveDays"]),
    repeatWindowDays: positiveInt(r["repeatWindowDays"], d.repeatWindowDays),
    maxAttemptsInWindow: positiveInt(r["maxAttemptsInWindow"], d.maxAttemptsInWindow),
    reviewAtRisk: positiveInt(r["reviewAtRisk"], d.reviewAtRisk),
  };
}

/** The inverse, for the panel's read of the current policy. */
export function serializePolicy(policy: ScreeningPolicy): ScreeningPolicyView {
  return {
    ...policy,
    minNetworth: policy.minNetworth === null ? null : policy.minNetworth.toString(),
  };
}
