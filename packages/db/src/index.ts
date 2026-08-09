/**
 * @sbr/db — Prisma schema, client, and (future) typed repositories.
 * The single choke point for database access across the platform.
 */
export { prisma, connectDb, disconnectDb } from "./client.js";
export { pingDb, type DbPingResult } from "./health.js";

// Typed repositories — the only sanctioned data-access surface for domain packages.
export { identityRepository } from "./repositories/identity.js";
export { moderationRepository } from "./repositories/moderation.js";
export { communityRepository } from "./repositories/community.js";
export { progressionRepository } from "./repositories/progression.js";
export { rankResolver, guildRepository, workerJobLogSink, type WorkerJobLogEntry } from "./repositories/misc.js";
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
  type FreshnessRow,
  type LinkedMemberRow,
  type RollupPoint,
  type CommandUsageRow,
  type EventRow,
  type TicketRow,
  type ApplicationRow,
  type JobHealthRow,
} from "./repositories/panel.js";
export { guildScanRepository, type CachedGuildMemberRow } from "./repositories/guild-scan.js";
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
