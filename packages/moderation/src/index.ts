/**
 * @sbr/moderation — shared moderation core (rank checks, cross-surface mute,
 * infraction + action audit, enforcement mirror).
 */
export { ModerationServiceImpl, type ModerationServiceDeps } from "./service.js";
export { rankOf, isPunitive, needsBotPermission } from "./rank.js";
export {
  describeState,
  expiredButFlaggedActive,
  holdsEnforcement,
  inForce,
  isInForce,
  punishmentState,
  type PunishmentState,
} from "./expiry.js";
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
  BotCapabilities,
  NewActionRecord,
  NewWordlistRecord,
  SafetyStateStore,
  WordlistRepository,
} from "./ports.js";
