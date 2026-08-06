/**
 * @sbr/moderation — shared moderation core (rank checks, cross-surface mute,
 * infraction + action audit, enforcement mirror).
 */
export { ModerationServiceImpl, type ModerationServiceDeps } from "./service.js";
export { rankOf, isPunitive, needsBotPermission } from "./rank.js";
export type {
  ModerationRepository,
  RankResolver,
  EnforcementMirror,
  BotCapabilities,
  NewActionRecord,
} from "./ports.js";
