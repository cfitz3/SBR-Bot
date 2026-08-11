/**
 * @sbr/moderation — shared moderation core (rank checks, cross-surface mute,
 * infraction + action audit, enforcement mirror).
 */
export { ModerationServiceImpl, type ModerationServiceDeps } from "./service.js";
export { rankOf, isPunitive, needsBotPermission } from "./rank.js";
export {
  countWarnsInWindow,
  describeRung,
  escalationReason,
  isEscalation,
  parsePolicy as parseEscalationPolicy,
  resolveLadder,
  rungFor,
  DEFAULT_ESCALATION_WINDOW_DAYS,
  DEFAULT_LADDER,
  DEFAULT_POLICY as DEFAULT_ESCALATION_POLICY,
  ESCALATION_SETTING_KEY,
  type EscalationAction,
  type EscalationPolicy,
  type EscalationRung,
} from "./escalation.js";
export {
  describeState,
  expiredButFlaggedActive,
  holdsEnforcement,
  inForce,
  isInForce,
  punishmentState,
  type PunishmentState,
} from "./expiry.js";
export { memberRecordSource, type MemberRecordSourceDeps } from "./record.js";
export { SafetyServiceImpl, type SafetyServiceDeps } from "./safety.js";
export {
  compileRule,
  evaluateText,
  validatePattern,
  WordlistServiceImpl,
  type Matcher,
  type WordlistServiceDeps,
} from "./wordlist.js";
export type {
  ModerationRepository,
  RankResolver,
  EnforcementMirror,
  EscalationPolicySource,
  BotCapabilities,
  NewActionRecord,
  NewWordlistRecord,
  SafetyStateStore,
  WordlistRepository,
} from "./ports.js";
