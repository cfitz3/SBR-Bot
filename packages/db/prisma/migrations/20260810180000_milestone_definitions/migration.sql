-- Milestone definitions: guild-configurable thresholds, and the two columns a
-- recorded milestone needs to be announceable.
--
-- Purely additive. `Milestone.definitionId` stays null for everything detected
-- from the built-in defaults, which is every row written so far, so the detector
-- keeps working unchanged until definitions exist.

-- Postgres 12+ allows this inside a transaction as long as the new value is not
-- *used* in the same one. Nothing below writes an XpEvent, so this is safe.
ALTER TYPE "XpSource" ADD VALUE 'MILESTONE';

CREATE TABLE "MilestoneDefinition" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "type" "MilestoneType" NOT NULL,
    "metric" TEXT NOT NULL,
    "threshold" BIGINT NOT NULL,
    "xpReward" INTEGER NOT NULL DEFAULT 0,
    "announce" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MilestoneDefinition_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MilestoneDefinition_guildId_key_key" ON "MilestoneDefinition"("guildId", "key");
CREATE INDEX "MilestoneDefinition_guildId_enabled_idx" ON "MilestoneDefinition"("guildId", "enabled");

ALTER TABLE "MilestoneDefinition" ADD CONSTRAINT "MilestoneDefinition_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nullable, and SET NULL on delete: removing a definition changes what the guild
-- recognises from now on, it does not unmake the fact that someone got there.
ALTER TABLE "Milestone" ADD COLUMN "definitionId" TEXT;
-- Denormalized at detection time so the announcer can mention a person without
-- re-resolving a link that may have changed since.
ALTER TABLE "Milestone" ADD COLUMN "discordId" TEXT;

ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_definitionId_fkey"
    FOREIGN KEY ("definitionId") REFERENCES "MilestoneDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The announcer sweeps unannounced rows oldest-first; the old single-column
-- index on `announced` cannot serve that ordering.
DROP INDEX IF EXISTS "Milestone_announced_idx";
CREATE INDEX "Milestone_announced_achievedAt_idx" ON "Milestone"("announced", "achievedAt");
