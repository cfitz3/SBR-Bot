-- Rolling in-game roster cache, permanent GEXP series, and a scan audit trail.
--
-- Purely additive: nothing reads these until the guild-scan job populates them,
-- so this is safe to deploy ahead of the code.

CREATE TABLE "GuildMemberCache" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "uuid" TEXT NOT NULL,
    "ign" TEXT,
    "guildRank" TEXT,
    "joinedAt" TIMESTAMP(3),
    "weeklyGexp" INTEGER NOT NULL DEFAULT 0,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuildMemberCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GuildMemberCache_guildId_uuid_key" ON "GuildMemberCache"("guildId", "uuid");
CREATE INDEX "GuildMemberCache_guildId_refreshedAt_idx" ON "GuildMemberCache"("guildId", "refreshedAt");

ALTER TABLE "GuildMemberCache"
    ADD CONSTRAINT "GuildMemberCache_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "GuildGexpDaily" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "uuid" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "gexp" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "GuildGexpDaily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GuildGexpDaily_guildId_uuid_day_key" ON "GuildGexpDaily"("guildId", "uuid", "day");
CREATE INDEX "GuildGexpDaily_guildId_day_idx" ON "GuildGexpDaily"("guildId", "day");

ALTER TABLE "GuildGexpDaily"
    ADD CONSTRAINT "GuildGexpDaily_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "GuildScan" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "joined" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "left" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "error" TEXT,

    CONSTRAINT "GuildScan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GuildScan_guildId_startedAt_idx" ON "GuildScan"("guildId", "startedAt");

ALTER TABLE "GuildScan"
    ADD CONSTRAINT "GuildScan_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;
