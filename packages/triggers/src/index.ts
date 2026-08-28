/**
 * @sbr/triggers — what a guild has asked the bot to watch for, and what to do.
 *
 * Offline by construction: the policy is parsed from a stored blob and the
 * matcher takes plain events, so the decision to repost somebody's message into
 * a public channel is testable without a gateway, a database or a key.
 */
export {
  DEFAULT_TRIGGERS,
  MAX_PATTERN_LENGTH,
  MAX_REACTION_THRESHOLD,
  MAX_REPLY_LENGTH,
  MAX_TRIGGER_RULES,
  MIN_REACTION_THRESHOLD,
  RULE_ID,
  TRIGGERS_SETTING_KEY,
  normalizeEmoji,
  parseTriggers,
  validateTriggers,
} from "./policy.js";
export {
  firedByMessage,
  firedByReaction,
  firingKey,
  type MessageEvent,
  type ReactionEvent,
} from "./match.js";
export { renderTriggerPostEmbed, type TriggerPostView } from "./render.js";
