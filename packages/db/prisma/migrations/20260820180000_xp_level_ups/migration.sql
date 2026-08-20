-- Levels climbed, queued for announcement.
--
-- A durable row rather than a published event, for the same reason milestones
-- are one: the nightly pass that discovers a climb runs in the workers, and the
-- message is sent by the member bot. A bot that was restarting during the pass
-- has to find the backlog waiting, which a pub/sub message would not survive.
CREATE TABLE "XpLevelUp" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "fromLevel" INTEGER NOT NULL,
    "toLevel" INTEGER NOT NULL,
    "totalXp" INTEGER NOT NULL,
    "announced" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XpLevelUp_pkey" PRIMARY KEY ("id")
);

-- The announcer's read: the oldest unannounced rows across the fleet.
CREATE INDEX "XpLevelUp_announced_createdAt_idx" ON "XpLevelUp"("announced", "createdAt");

-- One row per level reached. Balances are rebuilt from the whole ledger on
-- every pass, so the same climb is recomputed routinely; without this a replay
-- would announce it again every night.
CREATE UNIQUE INDEX "XpLevelUp_guildId_discordId_toLevel_key"
    ON "XpLevelUp"("guildId", "discordId", "toLevel");

ALTER TABLE "XpLevelUp" ADD CONSTRAINT "XpLevelUp_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;
