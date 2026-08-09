-- Join screening: one row per guild-join attempt, holding what we knew about
-- the applicant at the moment they asked and what was decided.
--
-- Purely additive. Nothing reads these tables until the bridge bot's screening
-- handler is wired, so it is safe to deploy ahead of the code.

CREATE TYPE "ScreeningVerdict" AS ENUM ('ACCEPT', 'REVIEW', 'DENY');

CREATE TYPE "ScreeningOutcome" AS ENUM ('PENDING', 'ACCEPTED', 'DENIED', 'EXPIRED', 'JOINED');

CREATE TABLE "GuildJoinScreening" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "uuid" TEXT NOT NULL,
    "ign" TEXT NOT NULL,
    "discordId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verdict" "ScreeningVerdict" NOT NULL,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    -- Three-valued on purpose: TRUE listed, FALSE checked and clear, NULL could
    -- not find out. NOT NULL here would turn an outage into an all-clear.
    "scammer" BOOLEAN,
    "scammerReason" TEXT,
    "scammerSource" TEXT,
    -- Networth exceeds INTEGER on any established account, hence BIGINT.
    "networth" BIGINT,
    "skillAverage" DOUBLE PRECISION,
    "catacombsLevel" DOUBLE PRECISION,
    "senitherWeight" DOUBLE PRECISION,
    "skyblockLevel" DOUBLE PRECISION,
    "profileName" TEXT,
    "firstLoginAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "outcome" "ScreeningOutcome" NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuildJoinScreening_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GuildJoinScreening_guildId_requestedAt_idx"
    ON "GuildJoinScreening"("guildId", "requestedAt");

-- "Have they tried before, and what happened?"
CREATE INDEX "GuildJoinScreening_guildId_uuid_requestedAt_idx"
    ON "GuildJoinScreening"("guildId", "uuid", "requestedAt");

-- The staff queue: pending reviews, oldest first.
CREATE INDEX "GuildJoinScreening_guildId_outcome_requestedAt_idx"
    ON "GuildJoinScreening"("guildId", "outcome", "requestedAt");

ALTER TABLE "GuildJoinScreening"
    ADD CONSTRAINT "GuildJoinScreening_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;
