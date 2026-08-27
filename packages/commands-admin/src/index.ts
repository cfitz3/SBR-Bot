/**
 * @sbr/commands-admin — staff command layer over the shared moderation core.
 */
export { AdminDispatcher, type AdminDispatcherDeps } from "./dispatcher.js";
export { buildAdminRegistry } from "./handlers.js";
export { parseDurationSeconds, renderModError } from "./util.js";
export {
  paginate,
  relativeTs,
  renderApplicationEmbed,
  renderApplicationListEmbed,
  renderAuditPages,
  renderEffectError,
  renderEnforcement,
  renderFilterTestEmbed,
  renderInfractionPages,
  renderSafetyError,
  renderSafetyStatusEmbed,
  renderWordlistEmbed,
} from "./render.js";
export {
  ROLEMENU_NAMESPACE,
  STICKY_NAMESPACE,
  TICKET_NAMESPACE,
  TICKET_REASON_MAX,
  parseRoleMenuId,
  parseStickyId,
  parseTicketId,
  renderNoteEmbed,
  renderRoleMenuControls,
  renderRoleMenuEmbed,
  renderStaffTicketEmbed,
  renderStickyControls,
  renderStickyEmbed,
  renderTicketControls,
  renderTicketQueueEmbed,
  roleMenuId,
  stickyId,
  ticketId,
  trimTicketReason,
} from "./utilities.js";
export type {
  RoleMenuAction,
  RoleMenuPrompt,
  StickyAction,
  StickyPrompt,
  TicketAction,
  TicketPrompt,
} from "./utilities.js";
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
