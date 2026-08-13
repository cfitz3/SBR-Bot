/**
 * @sbr/moderation — shared moderation core (rank checks, cross-surface mute,
 * infraction + action audit, enforcement mirror).
 */
export { ModerationServiceImpl, type ModerationServiceDeps } from "./service.js";
export { rankOf, isPunitive, needsBotPermission } from "./rank.js";
export {
  counterRequestsFor,
  evaluateAutomod,
  parseAutomod,
  parseRule as parseAutomodRule,
  parseTrigger as parseAutomodTrigger,
  ALLOW_DECISION as AUTOMOD_ALLOW,
  AUTOMOD_ACTION_TYPES,
  AUTOMOD_SETTING_KEY,
  AUTOMOD_TRIGGER_KINDS,
  DEFAULT_AUTOMOD,
  type AutomodAction,
  type AutomodActionType,
  type AutomodContext,
  type AutomodCounterRequest,
  type AutomodCounters,
  type AutomodDecision,
  type AutomodExemption,
  type AutomodMatch,
  type AutomodPolicy,
  type AutomodRule,
  type AutomodTrigger,
  type AutomodTriggerKind,
} from "./automod.js";
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
export {
  DEFAULT_RELAY_SYNC,
  formatGameDuration,
  parseRelaySync,
  resolveGameCommand,
  resolveRows as resolveRelaySyncRows,
  MAX_GAME_MUTE_SECONDS,
  RELAY_DISCORD_ACTIONS,
  RELAY_GAME_ACTIONS,
  RELAY_SYNC_SETTING_KEY,
  type RelayCommandInput,
  type RelayDiscordAction,
  type RelayDurationMode,
  type RelayGameAction,
  type RelaySyncPolicy,
  type RelaySyncRow,
} from "./relay-sync.js";
export {
  AutomodRunner,
  AUTOMOD_ACTOR,
  type AutomodEnforcer,
  type AutomodInput,
  type AutomodOutcome,
  type AutomodRunnerDeps,
  type AutomodSubject,
} from "./automod-runner.js";
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
  AutomodCounterStore,
  AutomodPolicySource,
  ModerationRepository,
  RankResolver,
  EnforcementMirror,
  EscalationPolicySource,
  GameCommandBus,
  IgnResolver,
  RelaySyncSource,
  BotCapabilities,
  NewActionRecord,
  NewWordlistRecord,
  SafetyStateStore,
  WordlistRepository,
} from "./ports.js";
export type { ModerationMetrics } from "./metrics.js";
