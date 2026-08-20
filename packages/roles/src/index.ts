/**
 * @sbr/roles — the rules behind automatic Discord roles.
 *
 * Pure by construction: this package decides *what* should happen. The admin
 * bot's effector decides whether it is allowed to, and does it.
 */
export {
  AUTO_ROLES_SETTING_KEY,
  AUTO_ROLE_TRIGGERS,
  DEFAULT_AUTO_ROLES,
  MAX_RULES,
  normalizeRank,
  parseAutoRoles,
  validateAutoRoles,
  type AutoRolePolicy,
  type AutoRoleRule,
  type AutoRoleTrigger,
  type AutoRoleTriggerKind,
} from "./policy.js";
export {
  diffGrants,
  resolveDesiredRoles,
  type GrantRow,
  type RoleDiff,
  type RoleMemberFacts,
  type RuleOutcome,
} from "./resolve.js";
export type { GrantRecord, RoleGrantRepository } from "./ports.js";
export * from "./welcome.js";
