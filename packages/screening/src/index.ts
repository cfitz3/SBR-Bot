/**
 * @sbr/screening — join-request screening: what we can find out about an
 * applicant, what the guild's policy makes of it, and how that reads to a human.
 */
export {
  DEFAULT_SCREEN_BUDGET_MS,
  ScreeningService,
  type ScreeningServiceDeps,
  type ScreenRequest,
  type ScreenResult,
} from "./service.js";
export { JOIN_WINDOW_MS, formatRemaining, remainingWindowMs, windowClosed } from "./window.js";
export { evaluate, parsePolicy, serializePolicy, riskWeight, type PolicyInput, type PolicyDecision } from "./policy.js";
export { chatLine, formatCoins, reasonLines, reasonSentence } from "./report.js";
export {
  needsStaffDecision,
  renderJoinNoticeEmbed,
  type JoinNoticeKind,
  type JoinNoticeView,
} from "./card.js";
export {
  JoinQueueService,
  type AdmitResult,
  type GuildCommandSender,
  type JoinAction,
  type JoinActionFailure,
  type JoinActionResult,
  type JoinPlayerLookup,
  type JoinQueueDeps,
} from "./queue.js";
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
