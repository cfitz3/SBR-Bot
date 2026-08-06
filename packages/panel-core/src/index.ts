/**
 * @sbr/panel-core — web panel server core: two-gate access control + guild-scoped
 * page-data resolvers. The Next.js routes render these view models.
 */
export {
  authorize,
  PAGE_TIERS,
  type PanelSession,
  type PanelPage,
  type AccessDecision,
  type DenyReason,
  type RoleResolver,
} from "./access.js";
export {
  PanelService,
  type PanelServiceDeps,
  type OverviewVM,
  type ModerationVM,
  type PageResult,
} from "./service.js";
