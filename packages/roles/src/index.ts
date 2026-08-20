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
  DEFAULT_ROLE_MENUS,
  MAX_MENUS,
  MAX_MENU_BODY,
  MAX_MENU_OPTIONS,
  MAX_MENU_TITLE,
  MAX_OPTION_DESCRIPTION,
  MAX_OPTION_LABEL,
  MAX_ROLE_MENU_KEY,
  ROLE_MENUS_SETTING_KEY,
  ROLE_MENU_KEY_SHAPE,
  decideMenuPress,
  findRoleMenu,
  parseRoleMenus,
  validateRoleMenus,
  type RoleMenu,
  type RoleMenuDoc,
  type RoleMenuOption,
  type RoleMenuPress,
} from "./menus.js";
export {
  diffGrants,
  resolveDesiredRoles,
  type GrantRow,
  type RoleDiff,
  type RoleMemberFacts,
  type RuleOutcome,
} from "./resolve.js";
export {
  previewRoleChanges,
  type PreviewMember,
  type RolePreview,
  type RulePreview,
} from "./preview.js";
export type { GrantRecord, RoleGrantRepository } from "./ports.js";
export * from "./welcome.js";
