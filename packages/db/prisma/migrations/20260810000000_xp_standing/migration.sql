-- XP & standing: the ledger, the denormalized balance, per-source policy and the
-- raw activity counters XP is derived from.
--
-- Purely additive. Nothing reads these tables until the XP commands ship, and an
-- empty XpSourceConfig means every source is disabled, so deploying this ahead
-- of the code awards nobody anything.

CREATE TYPE "XpSource" AS ENUM (
    'GEXP',
    'DISCORD_MESSAGE',
    'GUILD_CHAT_MESSAGE',
    'TENURE',
    'COMMAND_USAGE',
    'EVENT',
    'MANUAL'
);

CREATE TABLE "XpEvent" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "source" "XpSource" NOT NULL,
    "amount" INTEGER NOT NULL,
    "rawValue" INTEGER NOT NULL DEFAULT 0,
    "day" DATE NOT NULL,
    "dedupeKey" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XpEvent_pkey" PRIMARY KEY ("id")
);

-- The whole anti-double-credit story. Postgres treats NULLs as distinct here, so
-- one-off awards (MANUAL) can leave the key null and still be insertable, while
-- anything a job might replay must carry one.
CREATE UNIQUE INDEX "XpEvent_dedupeKey_key" ON "XpEvent"("dedupeKey");

CREATE INDEX "XpEvent_guildId_discordId_day_idx" ON "XpEvent"("guildId", "discordId", "day");
CREATE INDEX "XpEvent_guildId_source_day_idx" ON "XpEvent"("guildId", "source", "day");

ALTER TABLE "XpEvent"
    ADD CONSTRAINT "XpEvent_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "XpBalance" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "totalXp" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 0,
    "bySource" JSONB NOT NULL DEFAULT '{}',
    "tenureDays" INTEGER NOT NULL DEFAULT 0,
    "lastAwardAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XpBalance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "XpBalance_guildId_discordId_key" ON "XpBalance"("guildId", "discordId");
-- Leaderboards read this ordered and descending; the index serves either
-- direction, so one is enough.
CREATE INDEX "XpBalance_guildId_totalXp_idx" ON "XpBalance"("guildId", "totalXp");

ALTER TABLE "XpBalance"
    ADD CONSTRAINT "XpBalance_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "XpSourceConfig" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "source" "XpSource" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "dailyCap" INTEGER,
    "cooldownSec" INTEGER NOT NULL DEFAULT 0,
    "minLength" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XpSourceConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "XpSourceConfig_guildId_source_key" ON "XpSourceConfig"("guildId", "source");

ALTER TABLE "XpSourceConfig"
    ADD CONSTRAINT "XpSourceConfig_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ActivityDaily" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "discordMessages" INTEGER NOT NULL DEFAULT 0,
    "guildChatMessages" INTEGER NOT NULL DEFAULT 0,
    "commandsUsed" INTEGER NOT NULL DEFAULT 0,
    "presenceSamples" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActivityDaily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ActivityDaily_guildId_discordId_day_key" ON "ActivityDaily"("guildId", "discordId", "day");
CREATE INDEX "ActivityDaily_guildId_day_idx" ON "ActivityDaily"("guildId", "day");

ALTER TABLE "ActivityDaily"
    ADD CONSTRAINT "ActivityDaily_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;
