-- Targets members set for themselves (`/goal`), and whether they got there.
--
-- Unique on (guild, member, metric): a goal is a current intention rather than
-- a ledger, so setting a new networth target replaces the old one. The record
-- of *reaching* one is a Milestone row, written by the goal-check job.
CREATE TABLE "ProgressionGoal" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "minecraftAccountId" TEXT NOT NULL,
    "discordId" TEXT,
    "metric" TEXT NOT NULL,
    "target" BIGINT NOT NULL,
    "startValue" BIGINT,
    "achievedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgressionGoal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProgressionGoal_guildId_minecraftAccountId_metric_key" ON "ProgressionGoal"("guildId", "minecraftAccountId", "metric");

-- `/goal` — one member's list.
CREATE INDEX "ProgressionGoal_guildId_minecraftAccountId_idx" ON "ProgressionGoal"("guildId", "minecraftAccountId");

-- The checker's sweep: everything still outstanding, paged by id.
CREATE INDEX "ProgressionGoal_achievedAt_id_idx" ON "ProgressionGoal"("achievedAt", "id");

ALTER TABLE "ProgressionGoal" ADD CONSTRAINT "ProgressionGoal_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProgressionGoal" ADD CONSTRAINT "ProgressionGoal_minecraftAccountId_fkey" FOREIGN KEY ("minecraftAccountId") REFERENCES "MinecraftAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
