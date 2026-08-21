-- Replace the per-player stat time series with a current-reading table.
--
-- `ProfileSnapshot` was append-only and fed by a twice-hourly job: one row per
-- member per capture, forever. That is the "session tracking" pattern the
-- Hypixel Developer API Policy prohibits outright (docs/HYPIXEL_COMPLIANCE.md
-- §1), so the series goes.
--
-- What replaces it is smaller than it sounds, because almost nothing read a
-- series. Milestone detection compares a reading against the one before it;
-- leaderboards, the perms roster and profile cards read the newest reading.
-- `ProfileCurrent` serves all of those from one upserted row per profile that
-- carries its own previous reading. `/progress` and `/goal` are the only
-- genuine consumers of history, and they move to snapshots a member saves.
--
-- This migration is lossy on purpose: the scheduled history is deleted, not
-- archived. Keeping it in another table would keep the thing the policy objects
-- to. The newest reading per profile survives, as `ProfileCurrent`, so
-- leaderboards and milestone detection do not blank out on deploy.

-- ─────────────────────────── 1. the new table ───────────────────────────

CREATE TABLE "ProfileCurrent" (
    "id" TEXT NOT NULL,
    "minecraftAccountId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "networth" BIGINT,
    "skillAverage" DOUBLE PRECISION,
    "catacombsLevel" DOUBLE PRECISION,
    "slayerXp" BIGINT,
    "senitherWeight" DOUBLE PRECISION,
    "skyblockLevel" DOUBLE PRECISION,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "previousMetrics" JSONB NOT NULL DEFAULT '{}',
    "previousCapturedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfileCurrent_pkey" PRIMARY KEY ("id")
);

-- The shape that makes this table bounded: one row per profile, upserted.
CREATE UNIQUE INDEX "ProfileCurrent_minecraftAccountId_profileId_key" ON "ProfileCurrent"("minecraftAccountId", "profileId");

CREATE INDEX "ProfileCurrent_minecraftAccountId_capturedAt_idx" ON "ProfileCurrent"("minecraftAccountId", "capturedAt");

ALTER TABLE "ProfileCurrent" ADD CONSTRAINT "ProfileCurrent_minecraftAccountId_fkey" FOREIGN KEY ("minecraftAccountId") REFERENCES "MinecraftAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────────────────── 2. carry the newest reading over ─────────────────────
--
-- Newest per (account, profile), plus the one before it as `previousMetrics` so
-- milestone detection has something to compare on the first run after deploy
-- rather than treating every member as newly seen. The snapshot's own id is
-- reused as the primary key: unique already, and it makes the provenance of a
-- backfilled row traceable in a way a fresh uuid would not be.

WITH ranked AS (
    SELECT
        "id",
        "minecraftAccountId",
        "profileId",
        "capturedAt",
        "networth",
        "skillAverage",
        "catacombsLevel",
        "slayerXp",
        "senitherWeight",
        "skyblockLevel",
        "metrics",
        ROW_NUMBER() OVER (
            PARTITION BY "minecraftAccountId", "profileId"
            ORDER BY "capturedAt" DESC, "id" DESC
        ) AS rn
    FROM "ProfileSnapshot"
)
INSERT INTO "ProfileCurrent" (
    "id", "minecraftAccountId", "profileId", "capturedAt",
    "networth", "skillAverage", "catacombsLevel", "slayerXp",
    "senitherWeight", "skyblockLevel", "metrics",
    "previousMetrics", "previousCapturedAt", "createdAt", "updatedAt"
)
SELECT
    cur."id",
    cur."minecraftAccountId",
    cur."profileId",
    cur."capturedAt",
    cur."networth",
    cur."skillAverage",
    cur."catacombsLevel",
    cur."slayerXp",
    cur."senitherWeight",
    cur."skyblockLevel",
    cur."metrics",
    -- The displaced reading, rebuilt as one object. The column-backed metrics
    -- are folded in beside whatever the widened catalog left in `metrics`,
    -- because that is the shape the detector reads.
    COALESCE(
        prev."metrics" || jsonb_strip_nulls(jsonb_build_object(
            'networth', prev."networth",
            'skillAverage', prev."skillAverage",
            'catacombsLevel', prev."catacombsLevel",
            'slayerXp', prev."slayerXp",
            'senitherWeight', prev."senitherWeight",
            'skyblockLevel', prev."skyblockLevel"
        )),
        '{}'::jsonb
    ),
    prev."capturedAt",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM ranked cur
LEFT JOIN ranked prev
    ON prev."minecraftAccountId" = cur."minecraftAccountId"
   AND prev."profileId" = cur."profileId"
   AND prev.rn = 2
WHERE cur.rn = 1;

-- ─────────────── 3. narrow ProfileSnapshot to explicit captures ───────────────
--
-- Every surviving row was machine-written on a timer, so there is nothing here
-- a member asked for and nothing worth keeping. Deleting before the enum swap
-- also means no row still carries a value the new type does not have.

DELETE FROM "ProfileSnapshot";

DROP INDEX IF EXISTS "ProfileSnapshot_minecraftAccountId_profileId_captureDate_seq_key";
DROP INDEX IF EXISTS "ProfileSnapshot_eventId_minecraftAccountId_capturedAt_idx";

ALTER TABLE "ProfileSnapshot" DROP COLUMN "captureDate";
ALTER TABLE "ProfileSnapshot" DROP COLUMN "seq";
ALTER TABLE "ProfileSnapshot" ADD COLUMN "savedBy" TEXT;
ALTER TABLE "ProfileSnapshot" ADD COLUMN "label" TEXT;

-- The old members described cadences that no longer exist. Swapping the type
-- rather than adding to it keeps `SCHEDULED` from being writable by accident.
ALTER TABLE "ProfileSnapshot" ALTER COLUMN "source" DROP DEFAULT;
CREATE TYPE "SnapshotSource_new" AS ENUM ('USER_SAVED', 'EVENT_BASELINE', 'EVENT_FINAL');
ALTER TABLE "ProfileSnapshot" ALTER COLUMN "source" TYPE "SnapshotSource_new" USING 'USER_SAVED'::"SnapshotSource_new";
DROP TYPE "SnapshotSource";
ALTER TYPE "SnapshotSource_new" RENAME TO "SnapshotSource";
ALTER TABLE "ProfileSnapshot" ALTER COLUMN "source" SET DEFAULT 'USER_SAVED';

-- One baseline and one final per participant per event, enforced by the schema
-- rather than by the job remembering. Nulls are distinct in Postgres, so
-- user-saved rows (null `eventId`) are unaffected and a member may save many.
CREATE UNIQUE INDEX "ProfileSnapshot_minecraftAccountId_eventId_source_key" ON "ProfileSnapshot"("minecraftAccountId", "eventId", "source");

CREATE INDEX "ProfileSnapshot_eventId_source_idx" ON "ProfileSnapshot"("eventId", "source");
