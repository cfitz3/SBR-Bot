-- Record whether a moderation action was actually carried out.
--
-- The audit table only ever stored what staff *asked for*. A ban issued through
-- the bot wrote a row, replied "Banned", and — because the admin bot wired only
-- the Redis enforcement mirror and never a Discord API call — left the member in
-- the server and in the guild. Nothing in the schema could contradict the row.
--
-- These two columns are that contradiction. The service writes the row first as
-- PENDING, attempts both surfaces, then stamps the verdict here; a FAILED row
-- also alerts staff with the same detail string stored in `enforcementDetail`.
--
-- Existing rows are backfilled rather than left PENDING: they predate any
-- enforcement tracking, so their true status is unknown, and PENDING would put
-- every historical case into the "needs doing by hand" queue on deploy. They are
-- marked NOT_REQUIRED, which reads as "this column does not speak for this row".

CREATE TYPE "EnforcementStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'CONFIRMED', 'FAILED');

ALTER TABLE "ModerationAction"
  ADD COLUMN "enforcement" "EnforcementStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "enforcementDetail" TEXT;

UPDATE "ModerationAction" SET "enforcement" = 'NOT_REQUIRED';

CREATE INDEX "ModerationAction_guildId_enforcement_createdAt_idx"
  ON "ModerationAction"("guildId", "enforcement", "createdAt");
