/**
 * @sbr/jobs — scheduler-agnostic worker job runner (lock guard, retry/backoff,
 * WorkerJobLog recording) plus concrete job definitions.
 */
export { JobRunner, type JobDefinition, type JobOutcome, type JobRunnerDeps } from "./runner.js";
export { PermanentJobError } from "./ports.js";
export type { LockPort, Sleeper, JobLogSink, JobLogEntry } from "./ports.js";
export { InMemoryLock, RecordingLogSink } from "./memory.js";
export {
  defineAnalyticsIngestJob,
  defineAnalyticsRollupJob,
  defineAuctionSweepJob,
  defineBazaarRefreshJob,
  defineConfigInvalidationJob,
  defineEndedAuctionJob,
  defineEventTransitionJob,
  defineDiscordMemberSyncJob,
  defineGuildScanJob,
  defineInactivityScanJob,
  defineMilestoneBackfillJob,
  defineMilestoneDetectJob,
  defineProfileRefreshJob,
  definePunishmentExpiryJob,
  defineReminderDispatchJob,
  defineResourcesRefreshJob,
  defineRoleSyncJob,
  defineRosterSyncJob,
  defineSafetyExpiryJob,
  defineTicketSweepJob,
  defineEventBoardJob,
  defineLeaderboardPostJob,
  defineEventTrackingJob,
  defineXpAggregateJob,
} from "./jobs.js";
export {
  MAX_MEMBERS_PER_PASS,
  syncOneMember,
  syncRoles,
  type MemberSyncDeps,
  type RoleApplyOutcome,
  type RoleMemberSnapshot,
  type RoleSyncDeps,
} from "./role-sync.js";
export { createGuildRankProbe, type GuildLookup, type ProbeGuild } from "./role-gate.js";
export {
  NUDGE_BURST,
  NUDGE_MAX_PENDING,
  NUDGE_REFILL_MS,
  createRoleNudgeQueue,
  type RoleNudgeQueue,
  type RoleNudgeQueueDeps,
} from "./role-nudge.js";
export {
  blendEstimate,
  ingestEndedAuctions,
  median,
  refreshBazaar,
  refreshResources,
  sweepAuctions,
  type AuctionLike,
  type AuctionPageLike,
  type AuctionSweepDeps,
  type BazaarProductLike,
  type BazaarRefreshDeps,
  type BinWrite,
  type CachedPriceWrite,
  type EndedAuctionDeps,
  type EndedAuctionLike,
  type ResourceRefreshDeps,
  type SaleStats,
} from "./market.js";
export {
  DEFAULT_EVENT_DURATION_MS,
  REMINDER_OFFSETS_MINUTES,
  dispatchReminders,
  dueReminders,
  nextEventStatus,
  transitionEvents,
  type DueReminder,
  type EventRow,
  type EventStatus,
  type EventTransitionDeps,
  type ReminderDispatchDeps,
} from "./events.js";
export {
  backfillMilestones,
  detectAndRecord,
  detectMilestones,
  isMilestoneMetric,
  resolveDefinitions,
  refreshProfiles,
  standingMilestones,
  DEFAULT_MILESTONE_DEFINITIONS,
  type BackfillTarget,
  type MilestoneBackfillDeps,
  type MilestoneCandidate,
  type MilestoneDefinition,
  type MilestoneDetectDeps,
  type MilestoneMetric,
  type MilestoneType,
  type ProfileReading,
  type ProfileRefreshDeps,
  type SnapshotMetrics,
  type SnapshotSource,
  type SnapshotWrite,
  type TrackedAccount,
} from "./progression.js";
export {
  MEMBER_CACHE_TTL_MS,
  collectGexp,
  isCacheFresh,
  scanGuild,
  type CachedMemberRow,
  type GexpDailyWrite,
  type GuildScanDeps,
  type GuildScanResult,
  type MemberCacheWrite,
  type ScannedMember,
} from "./guild-scan.js";
export {
  syncDiscordMembers,
  type DiscordMemberRow,
  type DiscordMemberWrite,
  type DiscordSyncPorts,
  type DiscordSyncResult,
} from "./discord-sync.js";
export {
  diffRoster,
  findInactive,
  ingestAnalytics,
  invalidateConfigCaches,
  scanInactivity,
  syncRoster,
  type ActivityRow,
  type AnalyticsIngestDeps,
  type ConfigInvalidationDeps,
  type InactivityFlag,
  type InactivityScanDeps,
  type RosterDiff,
  type RosterMemberLike,
  type RosterSyncDeps,
  type RosterSyncResult,
  type StoredRosterRow,
} from "./maintenance.js";
export {
  sweepTickets,
  type SweepableTicket,
  type TicketSweepAction,
  type TicketSweepDeps,
} from "./tickets.js";
export {
  trackEvents,
  isEventMetric,
  EVENT_POLL_FLOOR_MINUTES,
  EVENT_METRICS,
  type EventMetric,
  type EventParticipant,
  type EventScoreWrite,
  type EventTrackingDeps,
  type TrackableEvent,
} from "./event-tracking.js";
export {
  postLeaderboardDigests,
  type DigestGuild,
  type LeaderboardPostJobDeps,
} from "./leaderboard-post.js";
export {
  publishEventBoards,
  BOARD_REFRESH_MS,
  type BoardableEvent,
  type EventBoardJobDeps,
} from "./event-board.js";
