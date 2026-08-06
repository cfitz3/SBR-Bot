-- CreateEnum
CREATE TYPE "GuildStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('MEMBER', 'MODERATOR', 'OFFICER', 'ADMIN', 'OWNER');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'LEFT', 'BANNED');

-- CreateEnum
CREATE TYPE "LinkStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'UNLINKED');

-- CreateEnum
CREATE TYPE "LinkVerificationMethod" AS ENUM ('HYPIXEL_SOCIAL', 'MANUAL');

-- CreateEnum
CREATE TYPE "SkyblockGameMode" AS ENUM ('NORMAL', 'IRONMAN', 'STRANDED', 'BINGO');

-- CreateEnum
CREATE TYPE "PermSubjectType" AS ENUM ('DISCORD_ROLE', 'DISCORD_USER', 'GUILD_RANK');

-- CreateEnum
CREATE TYPE "BridgeCapability" AS ENUM ('RELAY_MESSAGE', 'RUN_COMMAND', 'MENTION', 'BYPASS_FILTER', 'BYPASS_COOLDOWN', 'ADMIN');

-- CreateEnum
CREATE TYPE "WordMatchType" AS ENUM ('EXACT', 'SUBSTRING', 'REGEX', 'WILDCARD');

-- CreateEnum
CREATE TYPE "WordAction" AS ENUM ('BLOCK', 'FLAG', 'REPLACE', 'SHADOW_MUTE');

-- CreateEnum
CREATE TYPE "SourceContext" AS ENUM ('BRIDGE', 'DISCORD', 'INGAME');

-- CreateEnum
CREATE TYPE "InfractionType" AS ENUM ('SPAM', 'PROFANITY', 'HARASSMENT', 'ADVERTISING', 'CHEATING', 'RULE_BREAK', 'OTHER');

-- CreateEnum
CREATE TYPE "InfractionSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "InfractionStatus" AS ENUM ('OPEN', 'ACTIONED', 'EXPIRED', 'APPEALED', 'OVERTURNED');

-- CreateEnum
CREATE TYPE "ModActionType" AS ENUM ('WARN', 'MUTE', 'UNMUTE', 'KICK', 'BAN', 'UNBAN', 'NOTE', 'ROLE_CHANGE', 'GUILD_EXPEL');

-- CreateEnum
CREATE TYPE "TicketCategory" AS ENUM ('SUPPORT', 'REPORT', 'APPEAL', 'APPLICATION', 'OTHER');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'PENDING', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('DUNGEON', 'SLAYER', 'FISHING', 'MINING', 'GIVEAWAY', 'MEETING', 'CUSTOM');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RSVPState" AS ENUM ('GOING', 'MAYBE', 'NOT_GOING', 'WAITLIST');

-- CreateEnum
CREATE TYPE "LFGActivity" AS ENUM ('DUNGEONS', 'SLAYERS', 'KUUDRA', 'FISHING', 'MINING', 'OTHER');

-- CreateEnum
CREATE TYPE "LFGStatus" AS ENUM ('OPEN', 'FULL', 'EXPIRED', 'CLOSED');

-- CreateEnum
CREATE TYPE "MilestoneType" AS ENUM ('SKILL_LEVEL', 'CATACOMBS_LEVEL', 'SLAYER_TIER', 'NETWORTH_THRESHOLD', 'COLLECTION', 'CUSTOM');

-- CreateEnum
CREATE TYPE "SnapshotSource" AS ENUM ('SCHEDULED', 'ON_DEMAND', 'EVENT_TRACKED', 'BACKFILL');

-- CreateEnum
CREATE TYPE "CommandSurface" AS ENUM ('BRIDGE_BOT', 'ADMIN_BOT', 'WEB_PANEL', 'INGAME');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'ACTIVE', 'COMPLETED', 'FAILED', 'RETRYING', 'CANCELLED');

-- CreateTable
CREATE TABLE "DiscordUser" (
    "id" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "username" TEXT,
    "globalName" TEXT,
    "avatarHash" TEXT,
    "isStaff" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscordUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MinecraftAccount" (
    "id" TEXT NOT NULL,
    "uuid" TEXT NOT NULL,
    "currentIgn" TEXT,
    "ignHistoryCachedAt" TIMESTAMP(3),
    "hypixelLastFetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MinecraftAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinkedAccount" (
    "id" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "minecraftAccountId" TEXT NOT NULL,
    "status" "LinkStatus" NOT NULL DEFAULT 'PENDING',
    "verificationMethod" "LinkVerificationMethod" NOT NULL DEFAULT 'HYPIXEL_SOCIAL',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Guild" (
    "id" TEXT NOT NULL,
    "hypixelGuildId" TEXT,
    "name" TEXT NOT NULL,
    "tag" TEXT,
    "discordGuildId" TEXT NOT NULL,
    "status" "GuildStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Guild_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuildMember" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "guildRank" TEXT,
    "role" "MemberRole" NOT NULL DEFAULT 'MEMBER',
    "status" "MemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedAt" TIMESTAMP(3),
    "leftAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuildMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelectedSkyblockProfile" (
    "id" TEXT NOT NULL,
    "minecraftAccountId" TEXT NOT NULL,
    "guildId" TEXT,
    "profileId" TEXT NOT NULL,
    "cuteName" TEXT,
    "gameMode" "SkyblockGameMode" NOT NULL DEFAULT 'NORMAL',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SelectedSkyblockProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuildConfig" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "bridgeChannelId" TEXT,
    "staffChannelId" TEXT,
    "logChannelId" TEXT,
    "applicationsChannelId" TEXT,
    "eventsChannelId" TEXT,
    "prefixes" TEXT[] DEFAULT ARRAY['!']::TEXT[],
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "applicationsOpen" BOOLEAN NOT NULL DEFAULT false,
    "bridgeSuspended" BOOLEAN NOT NULL DEFAULT false,
    "minWeight" INTEGER,
    "minNetworth" BIGINT,
    "features" JSONB NOT NULL DEFAULT '{}',
    "cooldownDefaults" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuildConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BridgePermission" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "subjectType" "PermSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "capability" "BridgeCapability" NOT NULL,
    "allow" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BridgePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WordlistEntry" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "matchType" "WordMatchType" NOT NULL DEFAULT 'SUBSTRING',
    "action" "WordAction" NOT NULL DEFAULT 'BLOCK',
    "severity" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "addedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WordlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Infraction" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "targetDiscordId" TEXT,
    "targetMinecraftAccountId" TEXT,
    "type" "InfractionType" NOT NULL,
    "severity" "InfractionSeverity" NOT NULL DEFAULT 'LOW',
    "reason" TEXT NOT NULL,
    "sourceContext" "SourceContext" NOT NULL DEFAULT 'DISCORD',
    "status" "InfractionStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Infraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModerationAction" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "infractionId" TEXT,
    "actorDiscordId" TEXT NOT NULL,
    "targetDiscordId" TEXT,
    "targetMinecraftAccountId" TEXT,
    "type" "ModActionType" NOT NULL,
    "reason" TEXT NOT NULL,
    "surfaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "durationSeconds" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "openerDiscordId" TEXT NOT NULL,
    "assigneeDiscordId" TEXT,
    "category" "TicketCategory" NOT NULL DEFAULT 'SUPPORT',
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "channelId" TEXT,
    "subject" TEXT,
    "closeReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "applicantDiscordId" TEXT NOT NULL,
    "minecraftAccountId" TEXT,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "status" "ApplicationStatus" NOT NULL DEFAULT 'SUBMITTED',
    "reviewerDiscordId" TEXT,
    "decisionReason" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "EventType" NOT NULL DEFAULT 'CUSTOM',
    "status" "EventStatus" NOT NULL DEFAULT 'SCHEDULED',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "capacity" INTEGER,
    "hostDiscordId" TEXT,
    "messageId" TEXT,
    "tracksProgression" BOOLEAN NOT NULL DEFAULT false,
    "reminderState" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventRSVP" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "state" "RSVPState" NOT NULL DEFAULT 'GOING',
    "respondedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventRSVP_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LFGPost" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "authorDiscordId" TEXT NOT NULL,
    "activity" "LFGActivity" NOT NULL DEFAULT 'OTHER',
    "details" TEXT,
    "slotsTotal" INTEGER NOT NULL DEFAULT 5,
    "slotsFilled" INTEGER NOT NULL DEFAULT 1,
    "status" "LFGStatus" NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LFGPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationSubscription" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileSnapshot" (
    "id" TEXT NOT NULL,
    "minecraftAccountId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "captureDate" DATE NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "SnapshotSource" NOT NULL DEFAULT 'SCHEDULED',
    "eventId" TEXT,
    "networth" BIGINT,
    "skillAverage" DOUBLE PRECISION,
    "catacombsLevel" DOUBLE PRECISION,
    "senitherWeight" DOUBLE PRECISION,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Milestone" (
    "id" TEXT NOT NULL,
    "minecraftAccountId" TEXT NOT NULL,
    "guildId" TEXT,
    "type" "MilestoneType" NOT NULL,
    "metric" TEXT NOT NULL,
    "thresholdValue" BIGINT NOT NULL,
    "achievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snapshotId" TEXT,
    "announced" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Milestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommandUsage" (
    "id" TEXT NOT NULL,
    "guildId" TEXT,
    "discordId" TEXT,
    "surface" "CommandSurface" NOT NULL,
    "command" TEXT NOT NULL,
    "args" JSONB,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "latencyMs" INTEGER,
    "invokedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommandUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerJobLog" (
    "id" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "jobId" TEXT,
    "type" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "error" TEXT,
    "resultSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerJobLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DiscordUser_discordId_key" ON "DiscordUser"("discordId");

-- CreateIndex
CREATE INDEX "DiscordUser_discordId_idx" ON "DiscordUser"("discordId");

-- CreateIndex
CREATE UNIQUE INDEX "MinecraftAccount_uuid_key" ON "MinecraftAccount"("uuid");

-- CreateIndex
CREATE INDEX "MinecraftAccount_uuid_idx" ON "MinecraftAccount"("uuid");

-- CreateIndex
CREATE INDEX "MinecraftAccount_currentIgn_idx" ON "MinecraftAccount"("currentIgn");

-- CreateIndex
CREATE INDEX "LinkedAccount_status_idx" ON "LinkedAccount"("status");

-- CreateIndex
CREATE UNIQUE INDEX "LinkedAccount_discordUserId_minecraftAccountId_key" ON "LinkedAccount"("discordUserId", "minecraftAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Guild_hypixelGuildId_key" ON "Guild"("hypixelGuildId");

-- CreateIndex
CREATE UNIQUE INDEX "Guild_discordGuildId_key" ON "Guild"("discordGuildId");

-- CreateIndex
CREATE INDEX "Guild_discordGuildId_idx" ON "Guild"("discordGuildId");

-- CreateIndex
CREATE INDEX "GuildMember_guildId_status_idx" ON "GuildMember"("guildId", "status");

-- CreateIndex
CREATE INDEX "GuildMember_guildId_role_idx" ON "GuildMember"("guildId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "GuildMember_guildId_discordUserId_key" ON "GuildMember"("guildId", "discordUserId");

-- CreateIndex
CREATE INDEX "SelectedSkyblockProfile_minecraftAccountId_isActive_idx" ON "SelectedSkyblockProfile"("minecraftAccountId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "SelectedSkyblockProfile_minecraftAccountId_guildId_key" ON "SelectedSkyblockProfile"("minecraftAccountId", "guildId");

-- CreateIndex
CREATE UNIQUE INDEX "GuildConfig_guildId_key" ON "GuildConfig"("guildId");

-- CreateIndex
CREATE INDEX "BridgePermission_guildId_capability_idx" ON "BridgePermission"("guildId", "capability");

-- CreateIndex
CREATE UNIQUE INDEX "BridgePermission_guildId_subjectType_subjectId_capability_key" ON "BridgePermission"("guildId", "subjectType", "subjectId", "capability");

-- CreateIndex
CREATE INDEX "WordlistEntry_guildId_enabled_idx" ON "WordlistEntry"("guildId", "enabled");

-- CreateIndex
CREATE INDEX "WordlistEntry_guildId_action_idx" ON "WordlistEntry"("guildId", "action");

-- CreateIndex
CREATE INDEX "Infraction_guildId_targetDiscordId_createdAt_idx" ON "Infraction"("guildId", "targetDiscordId", "createdAt");

-- CreateIndex
CREATE INDEX "Infraction_guildId_type_idx" ON "Infraction"("guildId", "type");

-- CreateIndex
CREATE INDEX "Infraction_guildId_status_idx" ON "Infraction"("guildId", "status");

-- CreateIndex
CREATE INDEX "ModerationAction_guildId_targetDiscordId_active_idx" ON "ModerationAction"("guildId", "targetDiscordId", "active");

-- CreateIndex
CREATE INDEX "ModerationAction_guildId_type_createdAt_idx" ON "ModerationAction"("guildId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "ModerationAction_guildId_expiresAt_idx" ON "ModerationAction"("guildId", "expiresAt");

-- CreateIndex
CREATE INDEX "Ticket_guildId_status_idx" ON "Ticket"("guildId", "status");

-- CreateIndex
CREATE INDEX "Ticket_guildId_openerDiscordId_idx" ON "Ticket"("guildId", "openerDiscordId");

-- CreateIndex
CREATE INDEX "Application_guildId_status_idx" ON "Application"("guildId", "status");

-- CreateIndex
CREATE INDEX "Application_guildId_applicantDiscordId_idx" ON "Application"("guildId", "applicantDiscordId");

-- CreateIndex
CREATE INDEX "Event_guildId_status_startsAt_idx" ON "Event"("guildId", "status", "startsAt");

-- CreateIndex
CREATE INDEX "EventRSVP_eventId_state_idx" ON "EventRSVP"("eventId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "EventRSVP_eventId_discordId_key" ON "EventRSVP"("eventId", "discordId");

-- CreateIndex
CREATE INDEX "LFGPost_guildId_status_idx" ON "LFGPost"("guildId", "status");

-- CreateIndex
CREATE INDEX "LFGPost_guildId_activity_status_idx" ON "LFGPost"("guildId", "activity", "status");

-- CreateIndex
CREATE INDEX "NotificationSubscription_guildId_category_idx" ON "NotificationSubscription"("guildId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationSubscription_guildId_discordId_category_key" ON "NotificationSubscription"("guildId", "discordId", "category");

-- CreateIndex
CREATE INDEX "ProfileSnapshot_minecraftAccountId_capturedAt_idx" ON "ProfileSnapshot"("minecraftAccountId", "capturedAt");

-- CreateIndex
CREATE INDEX "ProfileSnapshot_eventId_minecraftAccountId_capturedAt_idx" ON "ProfileSnapshot"("eventId", "minecraftAccountId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProfileSnapshot_minecraftAccountId_profileId_captureDate_se_key" ON "ProfileSnapshot"("minecraftAccountId", "profileId", "captureDate", "seq");

-- CreateIndex
CREATE INDEX "Milestone_minecraftAccountId_achievedAt_idx" ON "Milestone"("minecraftAccountId", "achievedAt");

-- CreateIndex
CREATE INDEX "Milestone_announced_idx" ON "Milestone"("announced");

-- CreateIndex
CREATE UNIQUE INDEX "Milestone_minecraftAccountId_type_metric_thresholdValue_key" ON "Milestone"("minecraftAccountId", "type", "metric", "thresholdValue");

-- CreateIndex
CREATE INDEX "CommandUsage_guildId_command_invokedAt_idx" ON "CommandUsage"("guildId", "command", "invokedAt");

-- CreateIndex
CREATE INDEX "CommandUsage_surface_invokedAt_idx" ON "CommandUsage"("surface", "invokedAt");

-- CreateIndex
CREATE INDEX "WorkerJobLog_queue_status_createdAt_idx" ON "WorkerJobLog"("queue", "status", "createdAt");

-- CreateIndex
CREATE INDEX "WorkerJobLog_type_createdAt_idx" ON "WorkerJobLog"("type", "createdAt");

-- AddForeignKey
ALTER TABLE "LinkedAccount" ADD CONSTRAINT "LinkedAccount_discordUserId_fkey" FOREIGN KEY ("discordUserId") REFERENCES "DiscordUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkedAccount" ADD CONSTRAINT "LinkedAccount_minecraftAccountId_fkey" FOREIGN KEY ("minecraftAccountId") REFERENCES "MinecraftAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuildMember" ADD CONSTRAINT "GuildMember_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuildMember" ADD CONSTRAINT "GuildMember_discordUserId_fkey" FOREIGN KEY ("discordUserId") REFERENCES "DiscordUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelectedSkyblockProfile" ADD CONSTRAINT "SelectedSkyblockProfile_minecraftAccountId_fkey" FOREIGN KEY ("minecraftAccountId") REFERENCES "MinecraftAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuildConfig" ADD CONSTRAINT "GuildConfig_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BridgePermission" ADD CONSTRAINT "BridgePermission_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WordlistEntry" ADD CONSTRAINT "WordlistEntry_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Infraction" ADD CONSTRAINT "Infraction_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_infractionId_fkey" FOREIGN KEY ("infractionId") REFERENCES "Infraction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRSVP" ADD CONSTRAINT "EventRSVP_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LFGPost" ADD CONSTRAINT "LFGPost_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationSubscription" ADD CONSTRAINT "NotificationSubscription_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileSnapshot" ADD CONSTRAINT "ProfileSnapshot_minecraftAccountId_fkey" FOREIGN KEY ("minecraftAccountId") REFERENCES "MinecraftAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileSnapshot" ADD CONSTRAINT "ProfileSnapshot_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_minecraftAccountId_fkey" FOREIGN KEY ("minecraftAccountId") REFERENCES "MinecraftAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "ProfileSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
