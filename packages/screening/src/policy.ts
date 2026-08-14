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
 *   2. **Holds** are reason-driven too. Anything we could not find out holds the
 *      request for a human.
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

/** Risk contributed by each reason. Bounded to 0–100 after summing. */
const WEIGHTS: Readonly<Record<ScreeningReason, number>> = {
  SCAMMER_FLAGGED: 100,
  SCAMMER_UNKNOWN: 25,
  PRIOR_EXPULSION: 100,
  PRIOR_DENIAL: 40,
  REPEAT_ATTEMPTS: 20,
  STATS_UNREADABLE: 35,
  API_DISABLED: 20,
  MEETS_REQUIREMENTS: 0,
};

export interface PolicyInput {
  readonly policy: ScreeningPolicy;
  readonly scammer: ScammerFinding;
  readonly stats: ApplicantStats;
  readonly history?: ApplicantHistory;
}

// The clock used to be injected here, for the account-age and inactivity rules.
// Neither survives, and nothing else the policy decides depends on the time.


export interface PolicyDecision {
  readonly verdict: ScreeningVerdict;
  readonly riskScore: number;
  readonly reasons: readonly ScreeningReason[];
}

export function evaluate(input: PolicyInput): PolicyDecision {
  const { policy, scammer, stats } = input;
  const history = input.history ?? NO_HISTORY;

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

  // Account age, inactivity and the five stat bars used to hold a request here.
  // They are gone: the scam check is the only entry requirement, and screening's
  // job is now to *report* the account rather than to grade it. `stats` is still
  // read in full and still recorded, which is what the staff card renders.

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
    repeatWindowDays: positiveInt(r["repeatWindowDays"], d.repeatWindowDays),
    maxAttemptsInWindow: positiveInt(r["maxAttemptsInWindow"], d.maxAttemptsInWindow),
    reviewAtRisk: positiveInt(r["reviewAtRisk"], d.reviewAtRisk),
  };
}

/**
 * The inverse, for the panel's read of the current policy.
 *
 * A copy rather than the value itself, and a function rather than a cast: the
 * two types are the same shape today only because the coin threshold is gone,
 * and the seam is where the next JSON-hostile field would be handled.
 */
export function serializePolicy(policy: ScreeningPolicy): ScreeningPolicyView {
  return { ...policy };
}
