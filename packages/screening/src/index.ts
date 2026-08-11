/**
 * @sbr/screening — join-request screening: what we can find out about an
 * applicant, what the guild's policy makes of it, and how that reads to a human.
 */
export { ScreeningService, type ScreeningServiceDeps, type ScreenRequest, type ScreenResult } from "./service.js";
export { evaluate, parsePolicy, serializePolicy, riskWeight, type PolicyInput, type PolicyDecision } from "./policy.js";
export { chatLine, formatCoins, reasonLines, reasonSentence, staffReport, statLine } from "./report.js";
export type {
  ApplicantHistorySource,
  ApplicantLinkSource,
  ApplicantStatsSource,
  ScammerLookup,
  ScreeningPolicySource,
  ScreeningRecord,
  ScreeningRepository,
} from "./ports.js";
export {
  DEFAULT_POLICY,
  NO_HISTORY,
  SCREENING_POLICY_KEY,
  UNREADABLE_STATS,
  type ApplicantHistory,
  type ApplicantStats,
  type ScammerFinding,
  type Screening,
  type ScreeningOutcome,
  type ScreeningPolicy,
  type ScreeningPolicyView,
  type ScreeningReason,
  type ScreeningVerdict,
} from "./types.js";
