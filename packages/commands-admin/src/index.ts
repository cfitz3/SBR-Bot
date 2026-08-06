/**
 * @sbr/commands-admin — staff command layer over the shared moderation core.
 */
export { AdminDispatcher, type AdminDispatcherDeps } from "./dispatcher.js";
export { buildAdminRegistry } from "./handlers.js";
export { parseDurationSeconds, renderModError } from "./util.js";
export type {
  AdminContext,
  AdminReply,
  AdminCommandSpec,
  AdminHandler,
  AdminHandlerDeps,
  RoleResolver,
} from "./types.js";
