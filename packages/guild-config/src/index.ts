/**
 * @sbr/guild-config — per-guild channels, feature flags, and the bridge kill
 * switch, over a repository port implemented by @sbr/db.
 */
export { GuildConfigServiceImpl, type GuildConfigServiceDeps } from "./service.js";
export type { ConfigBroadcaster, GuildConfigRepository, GuildConfigRow } from "./ports.js";
export {
  DEFAULT_STICKIES,
  MAX_STICKIES,
  MAX_STICKY_CONTENT,
  STICKY_SETTING_KEY,
  findSticky,
  parseStickies,
  removeSticky,
  upsertSticky,
  validateStickies,
  type StickyDoc,
  type StickyMessage,
} from "./sticky.js";
export {
  COOLDOWN_SETTING_KEY,
  MAX_COOLDOWN_SECONDS,
  DEFAULT_COOLDOWNS,
  parseCooldowns,
  resolveCommandCooldownMs,
  type CooldownPolicy,
} from "./cooldowns.js";
export {
  CAPABILITIES,
  DEFAULT_CAPABILITY_FLOOR,
  DEFAULT_ROLE_POLICY,
  ROLES,
  ROLE_POLICY_SETTING_KEY,
  capabilityFloor,
  commandFloor,
  meetsFloor,
  normalizeRank,
  parseRoleBindings,
  parseRolePolicy,
  resolveMemberRole,
  validateRolePolicy,
  type MemberRoleFacts,
  type RoleBindings,
  type RolePolicy,
} from "./roles.js";
export {
  DEFAULT_PROGRESSION_METRICS,
  DEFAULT_PROGRESSION_POLICY,
  MAX_OFFERED_METRICS,
  PROGRESSION_SETTING_KEY,
  parseProgressionPolicy,
  validateProgressionPolicy,
  type ProgressionPolicy,
} from "./progression.js";
