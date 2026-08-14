-- Tickets, rebuilt on the discord-tickets model.
--
-- The old shape was a row and nothing else: a `Ticket` with a fixed enum
-- category, a single unpublished panel config, and a type table whose parent
-- channel and staff roles were stored but read by no runtime code. This
-- migration replaces that with per-guild settings, categories as rows, many
-- panels, canned tags, and a message store that makes transcripts possible.
--
-- Nothing a guild had is thrown away. The five enum values become seeded
-- category rows per guild, every existing ticket is repointed at the row that
-- matches the enum value it carried, and any `TicketTypeConfig` a guild had
-- configured is carried across into the category that shares its key.

-- ── clearing the name ───────────────────────────────────────────────────────
--
-- The new categories table takes the name the old enum had, and in Postgres a
-- table and a type share one namespace — so the enum has to go first. Its two
-- columns are widened to text rather than dropped, because the values are still
-- needed below to point each ticket and each configured type at its new row.

ALTER TABLE "Ticket" ALTER COLUMN "category" DROP DEFAULT;
ALTER TABLE "Ticket" ALTER COLUMN "category" TYPE TEXT USING "category"::TEXT;
ALTER TABLE "TicketTypeConfig" ALTER COLUMN "category" DROP DEFAULT;
ALTER TABLE "TicketTypeConfig" ALTER COLUMN "category" TYPE TEXT USING "category"::TEXT;
DROP TYPE "TicketCategory";

-- ── categories ──────────────────────────────────────────────────────────────

CREATE TABLE "TicketCategory" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "emoji" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "channelNameTemplate" TEXT NOT NULL DEFAULT 'ticket-{num}',
    "parentChannelId" TEXT,
    "staffRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiredRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pingRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "openingMessage" TEXT NOT NULL DEFAULT '',
    "image" TEXT,
    "claiming" BOOLEAN NOT NULL DEFAULT true,
    "cooldownSeconds" INTEGER,
    "memberLimit" INTEGER NOT NULL DEFAULT 1,
    "totalLimit" INTEGER NOT NULL DEFAULT 50,
    "slowModeSeconds" INTEGER,
    "requireTopic" BOOLEAN NOT NULL DEFAULT false,
    "questions" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TicketCategory_guildId_key_key" ON "TicketCategory"("guildId", "key");
CREATE INDEX "TicketCategory_guildId_enabled_idx" ON "TicketCategory"("guildId", "enabled");

ALTER TABLE "TicketCategory" ADD CONSTRAINT "TicketCategory_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the five former enum values for every guild, so no guild that was using
-- tickets wakes up with none. `md5(...)` gives a deterministic id, which keeps
-- the repoint below a plain join rather than a temp table.
INSERT INTO "TicketCategory" ("id", "guildId", "key", "name", "description", "position", "updatedAt")
SELECT
    md5(g."id" || ':' || v."key"),
    g."id",
    v."key",
    v."name",
    v."description",
    v."position",
    CURRENT_TIMESTAMP
FROM "Guild" g
CROSS JOIN (VALUES
    ('SUPPORT',     'Support',     'General help from the staff team.',        0),
    ('REPORT',      'Report',      'Report a member or a rule break.',         1),
    ('APPEAL',      'Appeal',      'Appeal a mute, kick or ban.',              2),
    ('APPLICATION', 'Application', 'Apply to the guild or to the staff team.', 3),
    ('OTHER',       'Other',       'Anything that does not fit the rest.',     4)
) AS v("key", "name", "description", "position");

-- Carry across whatever a guild had actually configured. `TicketTypeConfig`
-- keyed on the same string, so the settings land on the matching category.
UPDATE "TicketCategory" c
SET "name" = t."label",
    "emoji" = t."emoji",
    "position" = t."position",
    "enabled" = t."enabled",
    "parentChannelId" = t."parentChannelId",
    "staffRoleIds" = COALESCE(t."staffRoleIds", ARRAY[]::TEXT[]),
    "openingMessage" = COALESCE(t."prompt", '')
FROM "TicketTypeConfig" t
WHERE t."guildId" = c."guildId" AND t."key" = c."key";

-- A guild that invented its own type keys keeps them as categories of their own.
INSERT INTO "TicketCategory" (
    "id", "guildId", "key", "name", "emoji", "position", "enabled",
    "parentChannelId", "staffRoleIds", "openingMessage", "updatedAt"
)
SELECT
    md5(t."guildId" || ':' || t."key"),
    t."guildId",
    t."key",
    t."label",
    t."emoji",
    t."position",
    t."enabled",
    t."parentChannelId",
    COALESCE(t."staffRoleIds", ARRAY[]::TEXT[]),
    COALESCE(t."prompt", ''),
    CURRENT_TIMESTAMP
FROM "TicketTypeConfig" t
WHERE NOT EXISTS (
    SELECT 1 FROM "TicketCategory" c WHERE c."guildId" = t."guildId" AND c."key" = t."key"
);

-- ── settings ────────────────────────────────────────────────────────────────

CREATE TABLE "TicketSettings" (
    "guildId" TEXT NOT NULL,
    "archiveEnabled" BOOLEAN NOT NULL DEFAULT true,
    "logChannelId" TEXT,
    "blocklistRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "primaryColor" TEXT NOT NULL DEFAULT 'INFO',
    "successColor" TEXT NOT NULL DEFAULT 'SUCCESS',
    "errorColor" TEXT NOT NULL DEFAULT 'DANGER',
    "footer" TEXT,
    "staleAfterMinutes" INTEGER,
    "autoCloseAfterMinutes" INTEGER NOT NULL DEFAULT 720,
    "closeButton" BOOLEAN NOT NULL DEFAULT true,
    "claimButton" BOOLEAN NOT NULL DEFAULT true,
    "workingHours" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketSettings_pkey" PRIMARY KEY ("guildId")
);

ALTER TABLE "TicketSettings" ADD CONSTRAINT "TicketSettings_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── panels ──────────────────────────────────────────────────────────────────

CREATE TYPE "TicketPanelStyle" AS ENUM ('BUTTONS', 'SELECT');

CREATE TABLE "TicketPanel" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channelId" TEXT,
    "messageId" TEXT,
    "title" TEXT NOT NULL DEFAULT 'Support',
    "description" TEXT,
    "image" TEXT,
    "thumbnail" TEXT,
    "style" "TicketPanelStyle" NOT NULL DEFAULT 'BUTTONS',
    "categoryKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketPanel_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TicketPanel_guildId_idx" ON "TicketPanel"("guildId");

ALTER TABLE "TicketPanel" ADD CONSTRAINT "TicketPanel_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The old single panel becomes the guild's first panel. Its `messageId` is
-- deliberately *not* carried: nothing ever published it, so there is no message
-- out there to edit, and pretending otherwise would make the first publish a
-- silent no-op against a message id that does not exist.
INSERT INTO "TicketPanel" ("id", "guildId", "name", "channelId", "title", "description", "categoryKeys", "updatedAt")
SELECT
    p."id",
    p."guildId",
    'Support',
    p."channelId",
    p."title",
    p."description",
    ARRAY(SELECT c."key" FROM "TicketCategory" c WHERE c."guildId" = p."guildId" AND c."enabled" ORDER BY c."position"),
    CURRENT_TIMESTAMP
FROM "TicketPanelConfig" p;

-- ── tags ────────────────────────────────────────────────────────────────────

CREATE TABLE "TicketTag" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "autoPattern" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketTag_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TicketTag_guildId_name_key" ON "TicketTag"("guildId", "name");

ALTER TABLE "TicketTag" ADD CONSTRAINT "TicketTag_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── the ticket itself ───────────────────────────────────────────────────────

ALTER TABLE "Ticket"
    ADD COLUMN "number" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "categoryId" TEXT,
    ADD COLUMN "topic" TEXT,
    ADD COLUMN "answers" JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN "claimedByDiscordId" TEXT,
    ADD COLUMN "claimedAt" TIMESTAMP(3),
    ADD COLUMN "closeRequestedByDiscordId" TEXT,
    ADD COLUMN "closeRequestedAt" TIMESTAMP(3),
    ADD COLUMN "lastMessageAt" TIMESTAMP(3),
    ADD COLUMN "firstStaffReplyAt" TIMESTAMP(3),
    ADD COLUMN "feedbackRating" INTEGER,
    ADD COLUMN "feedbackComment" TEXT,
    ADD COLUMN "transcriptReady" BOOLEAN NOT NULL DEFAULT false;

-- Repoint every existing ticket at the category row matching the enum value it
-- carried. Deterministic id, so this is a plain expression.
UPDATE "Ticket" SET "categoryId" = md5("guildId" || ':' || "category");

-- Number the backlog per guild, oldest first, so `{num}` reads as a sequence
-- rather than as an arbitrary id. New tickets continue from the guild's max.
WITH numbered AS (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "guildId" ORDER BY "createdAt", "id") AS n
    FROM "Ticket"
)
UPDATE "Ticket" t SET "number" = numbered.n FROM numbered WHERE numbered."id" = t."id";

-- The clock a stale ticket is measured against. No message history exists for
-- the backlog, so creation time is the honest starting point.
UPDATE "Ticket" SET "lastMessageAt" = "createdAt" WHERE "lastMessageAt" IS NULL;

ALTER TABLE "Ticket" DROP COLUMN "category";

ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "TicketCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Ticket_guildId_number_key" ON "Ticket"("guildId", "number");
CREATE INDEX "Ticket_channelId_idx" ON "Ticket"("channelId");

-- ── the transcript store ────────────────────────────────────────────────────

CREATE TABLE "TicketMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "discordMessageId" TEXT NOT NULL,
    "authorDiscordId" TEXT NOT NULL,
    "authorTag" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TicketMessage_ticketId_discordMessageId_key" ON "TicketMessage"("ticketId", "discordMessageId");
CREATE INDEX "TicketMessage_ticketId_createdAt_idx" ON "TicketMessage"("ticketId", "createdAt");

ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── the old shape ───────────────────────────────────────────────────────────

DROP TABLE "TicketTypeConfig";
DROP TABLE "TicketPanelConfig";
