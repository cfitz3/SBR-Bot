-- Human-readable case ids: `CASE-DrJay-a1b2c3d4-2`.
--
-- Additive. `id` remains the primary key and every existing reference to it
-- keeps resolving; this adds the name staff actually use alongside it.

-- Written to be re-runnable. The first release of this migration failed at the
-- unique index below, and Postgres had already committed the columns and the
-- backfill by then, so the recovery path is to apply the whole file again over
-- a half-finished table rather than to hand-patch it. Every step here is
-- therefore either guarded or idempotent: the UPDATE recomputes every row from
-- scratch and does not read what it is overwriting.
ALTER TABLE "ModerationAction" ADD COLUMN IF NOT EXISTS "caseCode" TEXT;
ALTER TABLE "ModerationAction" ADD COLUMN IF NOT EXISTS "caseNumber" INTEGER NOT NULL DEFAULT 0;

-- Backfill, in the order the cases were issued, so somebody's second case is
-- the second one they got rather than whichever row the planner reached first.
-- "Somebody" here means a distinct name-and-uuid pair, which is what the id
-- names and what the runtime allocator counts.
--
-- The name and uuid come from the target's verified Minecraft link when there
-- is one, and fall back to their Discord username and snowflake when there is
-- not: a Discord-only punishment on somebody who never linked still deserves a
-- readable id. The sanitiser mirrors `sanitizeCaseName` in
-- `packages/shared-types/src/case-id.ts` — keep `[A-Za-z0-9_]`, cap at 16.
WITH linked AS (
  SELECT DISTINCT ON (d."discordId")
    d."discordId" AS "discordId",
    m."currentIgn" AS ign,
    m."uuid" AS uuid
  FROM "DiscordUser" d
  JOIN "LinkedAccount" l ON l."discordUserId" = d."id" AND l."status" = 'VERIFIED'
  JOIN "MinecraftAccount" m ON m."id" = l."minecraftAccountId"
  ORDER BY d."discordId", l."isPrimary" DESC, l."verifiedAt" DESC NULLS LAST
),
resolved AS (
  SELECT
    a."id",
    a."guildId",
    substring(
      COALESCE(
        NULLIF(regexp_replace(COALESCE(k.ign, ma."currentIgn", d."username", ''), '[^A-Za-z0-9_]', '', 'g'), ''),
        'unknown'
      ) FROM 1 FOR 16
    ) AS name,
    substring(
      COALESCE(
        NULLIF(lower(replace(COALESCE(k.uuid, ma."uuid", ''), '-', '')), ''),
        NULLIF(a."targetDiscordId", ''),
        '00000000'
      ) FROM 1 FOR 8
    ) AS uuid8,
    a."createdAt"
  FROM "ModerationAction" a
  LEFT JOIN "DiscordUser" d ON d."discordId" = a."targetDiscordId"
  LEFT JOIN linked k ON k."discordId" = a."targetDiscordId"
  LEFT JOIN "MinecraftAccount" ma ON ma."id" = a."targetMinecraftAccountId"
),
-- Numbered by the two segments the id is built from, not by the underlying
-- target. Those are not the same partition: several targets reduce to the same
-- name and uuid fragment - most obviously every action with no recoverable
-- target at all, which lands on `unknown-00000000` - and numbering those
-- separately mints the same code twice and fails the unique index below. This
-- also matches how `createAction` allocates at runtime, which counts the rows
-- whose `caseCode` already starts with the same prefix.
numbered AS (
  SELECT
    "id",
    name,
    uuid8,
    ROW_NUMBER() OVER (PARTITION BY "guildId", name, uuid8 ORDER BY "createdAt", "id") AS seq
  FROM resolved
)
UPDATE "ModerationAction" a
SET "caseNumber" = n.seq,
    "caseCode" = 'CASE-' || n.name || '-' || n.uuid8 || '-' || n.seq
FROM numbered n
WHERE a."id" = n."id";

-- Uniqueness is what makes allocation safe: two staff punishing the same person
-- in the same second both compute the same next number, and the loser takes the
-- next one rather than writing a duplicate id.
CREATE UNIQUE INDEX IF NOT EXISTS "ModerationAction_guildId_caseCode_key" ON "ModerationAction"("guildId", "caseCode");
CREATE INDEX IF NOT EXISTS "ModerationAction_guildId_targetDiscordId_caseNumber_idx" ON "ModerationAction"("guildId", "targetDiscordId", "caseNumber");
