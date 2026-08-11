/**
 * @sbr/panel-core — web panel server core: two-gate access control + guild-scoped
 * page-data resolvers. `apps/web-panel` serves these view models as JSON and its
 * browser client renders them; the types are shared by both halves.
 */
export {
  authorize,
  authorizeRole,
  PAGE_TIERS,
  type PanelSession,
  type PanelPage,
  type AccessDecision,
  type DenyReason,
  type RoleResolver,
} from "./access.js";
export {
  PanelService,
  STALE_AFTER_MS,
  EXPECTED_SERVICES,
  HEARTBEAT_STALE_MS,
  type ServiceHealthVM,
  type ServiceInstanceVM,
  type PanelServiceDeps,
  type PageResult,
  type OverviewVM,
  type ModerationVM,
  type SelectorVM,
  type AnalyticsVM,
  type RecruitmentVM,
  type EventsVM,
  type EventAttendance,
  type EventRsvp,
  type MembersVM,
  type SettingsVM,
  type MappingVM,
  type MilestonesVM,
  type TicketsVM,
  type XpVM,
  XP_SOURCE_ORDER,
  type HealthVM,
  type FreshnessVM,
} from "./service.js";
export {
  PanelMutations,
  MUTATION_TIERS,
  MUTATION_NAMES,
  MUTATION_COOLDOWN_MS,
  type MutationName,
  type MutationResult,
  type MutationError,
  type MutationErrorKind,
  type MutationLimiter,
  type PanelMutationsDeps,
  type ConfigAuditEntry,
  type ConfigAuditSink,
} from "./mutations.js";
export {
  bucketRange,
  dimValue,
  shapeAnalytics,
  MAX_BUCKETS,
  type ChartSeries,
  type MetricChart,
  type ShapeOptions,
} from "./series.js";
export { commandStatsToCsv, csvCell, rollupsToCsv, toCsv } from "./csv.js";
export type {
  PanelReads,
  GuildCard,
  OverviewCounts,
  Freshness,
  LinkedMember,
  RollupPoint,
  RollupPeriod,
  CommandUsageStat,
  PanelEvent,
  PanelTicket,
  PanelApplication,
  JobHealth,
  HeartbeatReader,
  ServiceHeartbeat,
} from "./reads.js";
