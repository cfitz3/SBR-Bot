/**
 * @sbr/db — Prisma schema, client, and (future) typed repositories.
 * The single choke point for database access across the platform.
 */
export { prisma, connectDb, disconnectDb } from "./client.js";
export {
  pingDb,
  assertDatabaseReady,
  DatabaseNotReadyError,
  type DbPingResult,
  type DbReadyFailure,
} from "./health.js";

// Typed repositories — the only sanctioned data-access surface for domain packages.
export { identityRepository } from "./repositories/identity.js";
export {
  bridgePermissionRepository,
  type BridgePermissionRow,
  type PermSubjectKind,
} from "./repositories/bridge-permissions.js";
export { moderationRepository } from "./repositories/moderation.js";
export {
  communityMetricsRepository,
  communityRepository,
  podiumRepository,
} from "./repositories/community.js";
export { progressionRepository } from "./repositories/progression.js";
export { goalRepository } from "./repositories/goals.js";
export {
  rankResolver,
  staffGuildFinder,
  rolePolicyReader,
  guildRepository,
  workerJobLogSink,
  type WorkerJobLogEntry,
} from "./repositories/misc.js";
export {
  analyticsJobRepository,
  eventJobRepository,
  maintenanceJobRepository,
  snapshotJobRepository,
  type AnalyticsEventRow,
  type MetricRollupRow,
} from "./repositories/jobs.js";
export {
  panelRepository,
  type GuildCardRow,
  type OverviewCountsRow,
  type LinkedMemberRow,
  type RollupPoint,
  type CommandUsageRow,
  type EventRow,
  type JobHealthRow,
} from "./repositories/panel.js";
export { guildScanRepository, type CachedGuildMemberRow } from "./repositories/guild-scan.js";
export { discordSyncRepository } from "./repositories/discord-sync.js";
export {
  screeningRepository,
  screeningHistorySource,
  screeningPolicySource,
  SCREENING_POLICY_KEY,
} from "./repositories/screening.js";
export {
  permRepository,
  guildMemberDirectory,
  memberProgressSource,
  linkDirectory,
} from "./repositories/perms.js";
export { reminderRepository } from "./repositories/reminders.js";
export { xpRepository, activitySink, xpLevelUpAnnouncementRepository } from "./repositories/xp.js";
export { leaderboardSource } from "./repositories/leaderboards.js";
export { milestoneDefinitionRepository, milestoneAnnouncementRepository } from "./repositories/milestones.js";
export { roleGrantRepository } from "./repositories/role-grants.js";
export { roleSyncRepository, memberRoleDirtyMarker } from "./repositories/role-sync.js";
export { ticketConfigRepository } from "./repositories/ticket-config.js";
export {
  ticketRepository,
  type TicketInsert,
  type TicketMessageInsert,
} from "./repositories/tickets.js";
export {
  wordlistRepository,
  guildConfigRepository,
  type GuildConfigRow,
  type WordlistEntryRow,
  type WordMatchType,
  type WordAction,
} from "./repositories/bridge.js";

// Re-export the generated Prisma types & enums so domain packages can consume
// them without depending on @prisma/client directly.
export { Prisma, PrismaClient } from "@prisma/client";
export type {
  DiscordUser,
  MinecraftAccount,
  LinkedAccount,
  Guild,
  GuildMember,
  GuildConfig,
  ProfileSnapshot,
  Milestone,
  Infraction,
  ModerationAction,
} from "@prisma/client";
