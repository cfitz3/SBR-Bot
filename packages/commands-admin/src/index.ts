/**
 * @sbr/commands-admin — staff command layer over the shared moderation core.
 */
export { AdminDispatcher, type AdminDispatcherDeps } from "./dispatcher.js";
export { buildAdminRegistry } from "./handlers.js";
export { parseDurationSeconds, renderModError } from "./util.js";
export {
  LOCKDOWN_NAMESPACE,
  LOCKDOWN_REASON_MAX,
  lockdownId,
  paginate,
  parseLockdownId,
  relativeTs,
  renderApplicationEmbed,
  renderApplicationListEmbed,
  renderAuditPages,
  renderEffectError,
  renderEnforcement,
  renderFilterTestEmbed,
  renderInfractionPages,
  renderLockdownControls,
  renderLockdownEmbed,
  renderSafetyError,
  renderSafetyStatusEmbed,
  renderWordlistEmbed,
  trimLockdownReason,
} from "./render.js";
export type { LockdownAction, LockdownArgs, LockdownPrompt } from "./render.js";
export type {
  AdminAutocompleteContext,
  AdminAutocompleteHandler,
  AdminContext,
  AdminReply,
  AdminCommandSpec,
  AdminHandler,
  AdminHandlerDeps,
  AdminOptionSpec,
  Choice,
  RoleMenuBridge,
  RoleMenuSummary,
  RoleResolver,
  StickyBridge,
  StickySummary,
  TicketBridge,
} from "./types.js";
