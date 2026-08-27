-- The bug-report category, for guilds that already exist.
--
-- Every user-facing error the platform prints now ends by pointing at `/health`
-- and offering a button that opens a ticket here, so the category has to be
-- present in every guild before that button ships — a member pressing it into a
-- guild with no `BUG` row would get a failure inside a failure.
--
-- `position` is one past the seeded five rather than a fixed 5, because a guild
-- may have reordered or added categories since the rebuild and dropping this on
-- top of an existing entry would silently reshuffle their menu. `ON CONFLICT DO
-- NOTHING` covers the guild that already invented a `BUG` key of its own: it is
-- theirs, with their wording, and this migration is not entitled to rewrite it.
--
-- The id matches the deterministic `md5(guild || ':' || key)` shape the rebuild
-- migration used, so the two seeds stay readable side by side.
INSERT INTO "TicketCategory" ("id", "guildId", "key", "name", "description", "position", "updatedAt")
SELECT
    md5(g."id" || ':BUG'),
    g."id",
    'BUG',
    'Bug report',
    'Something on the platform is broken.',
    COALESCE((SELECT MAX(c."position") + 1 FROM "TicketCategory" c WHERE c."guildId" = g."id"), 0),
    CURRENT_TIMESTAMP
FROM "Guild" g
ON CONFLICT ("guildId", "key") DO NOTHING;

-- A guild that had disabled a `BUG` category of its own gets it switched back
-- on, for the same reason it cannot be disabled from here on: the button under
-- every error opens it.
UPDATE "TicketCategory" SET "enabled" = TRUE WHERE "key" = 'BUG' AND "enabled" = FALSE;
