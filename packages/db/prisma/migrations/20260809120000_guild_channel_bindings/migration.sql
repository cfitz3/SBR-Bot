-- Open-ended per-guild channel bindings and admin settings.
--
-- Additive and backfilled: the five legacy GuildConfig.*ChannelId columns are
-- copied into bindings here and are still written by the application, so this
-- migration is safe to deploy ahead of the code and safe to roll back behind it.
-- The columns are dropped in a later migration, once nothing reads them.

CREATE TABLE "GuildChannelBinding" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuildChannelBinding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GuildChannelBinding_guildId_slot_key" ON "GuildChannelBinding"("guildId", "slot");
CREATE INDEX "GuildChannelBinding_guildId_idx" ON "GuildChannelBinding"("guildId");

ALTER TABLE "GuildChannelBinding"
    ADD CONSTRAINT "GuildChannelBinding_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "GuildSetting" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuildSetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GuildSetting_guildId_key_key" ON "GuildSetting"("guildId", "key");
CREATE INDEX "GuildSetting_guildId_idx" ON "GuildSetting"("guildId");

ALTER TABLE "GuildSetting"
    ADD CONSTRAINT "GuildSetting_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill the five legacy slots. gen_random_uuid() rather than a cuid because
-- this runs in SQL; ids are opaque and no code parses them.
INSERT INTO "GuildChannelBinding" ("id", "guildId", "slot", "channelId", "updatedAt")
SELECT gen_random_uuid()::text, c."guildId", s.slot, s."channelId", CURRENT_TIMESTAMP
FROM "GuildConfig" c
CROSS JOIN LATERAL (
    VALUES
        ('bridge',       c."bridgeChannelId"),
        ('staff',        c."staffChannelId"),
        ('log',          c."logChannelId"),
        ('applications', c."applicationsChannelId"),
        ('events',       c."eventsChannelId")
) AS s(slot, "channelId")
WHERE s."channelId" IS NOT NULL
ON CONFLICT ("guildId", "slot") DO NOTHING;
