-- Drop the five `*ChannelId` columns GuildChannelBinding replaced.
--
-- The first destructive migration in the platform buildout, so it is written in
-- the only safe order: **backfill, then drop**. A guild whose config was last
-- written by a pre-binding release has its channels in the columns and nothing
-- in the table, and dropping first would silently unconfigure it — the relay
-- would go quiet with no error anywhere to explain why.
--
-- The backfill is a no-op for every guild that has been saved since the
-- bindings shipped, because writes have been mirrored into both places since
-- then and `ON CONFLICT DO NOTHING` leaves the authoritative row alone.

INSERT INTO "GuildChannelBinding" ("id", "guildId", "slot", "channelId", "createdAt", "updatedAt")
SELECT
    -- Any unique text satisfies the id column; md5() needs no extension, which
    -- gen_random_uuid() does on older servers.
    md5(c."guildId" || v.slot || clock_timestamp()::text || random()::text),
    c."guildId",
    v.slot,
    v."channelId",
    NOW(),
    NOW()
FROM "GuildConfig" c
CROSS JOIN LATERAL (
    VALUES
        ('bridge', c."bridgeChannelId"),
        ('staff', c."staffChannelId"),
        ('log', c."logChannelId"),
        ('applications', c."applicationsChannelId"),
        ('events', c."eventsChannelId")
) AS v(slot, "channelId")
WHERE v."channelId" IS NOT NULL
ON CONFLICT ("guildId", "slot") DO NOTHING;

ALTER TABLE "GuildConfig"
    DROP COLUMN "bridgeChannelId",
    DROP COLUMN "staffChannelId",
    DROP COLUMN "logChannelId",
    DROP COLUMN "applicationsChannelId",
    DROP COLUMN "eventsChannelId";
