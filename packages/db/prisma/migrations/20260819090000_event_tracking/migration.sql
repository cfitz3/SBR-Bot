-- Events become tracked competitions.
--
-- Everything added here is nullable or defaulted, so an event created before
-- today keeps working untouched: no tracked metrics means the tracker skips it,
-- and a null `channelId`/`messageId` means the board has not been posted yet,
-- which is exactly the state a pre-existing event is in.
ALTER TABLE "Event" ADD COLUMN "channelId" TEXT;
ALTER TABLE "Event" ADD COLUMN "boardUpdatedAt" TIMESTAMP(3);
ALTER TABLE "Event" ADD COLUMN "trackedMetrics" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Event" ADD COLUMN "pollIntervalMinutes" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Event" ADD COLUMN "discordEventId" TEXT;

-- One participant's standing in one metric. `delta` is stored rather than
-- derived so the board can order by it in the database; the index is on
-- (eventId, metric, delta) for exactly that read.
CREATE TABLE "EventScore" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "uuid" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "baseline" DOUBLE PRECISION NOT NULL,
    "current" DOUBLE PRECISION NOT NULL,
    "delta" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventScore_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EventScore_eventId_uuid_metric_key" ON "EventScore"("eventId", "uuid", "metric");
CREATE INDEX "EventScore_eventId_metric_delta_idx" ON "EventScore"("eventId", "metric", "delta");

ALTER TABLE "EventScore" ADD CONSTRAINT "EventScore_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
