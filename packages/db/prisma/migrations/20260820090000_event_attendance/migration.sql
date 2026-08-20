-- Who actually turned up, as opposed to who said they would.
--
-- TRACKED rows are written when an event completes, from the participants the
-- poller scored; MARKED rows are a person's judgement from the panel, and are
-- the only way an unlinked member or a walk-in is ever recorded.
CREATE TYPE "AttendanceSource" AS ENUM ('TRACKED', 'MARKED');

CREATE TABLE "EventAttendance" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "source" "AttendanceSource" NOT NULL DEFAULT 'MARKED',
    "recordedBy" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventAttendance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EventAttendance_eventId_discordId_key" ON "EventAttendance"("eventId", "discordId");

-- The aggregate the profile card and the Phase 16 achievement family read:
-- how many events one member has attended.
CREATE INDEX "EventAttendance_discordId_idx" ON "EventAttendance"("discordId");

ALTER TABLE "EventAttendance" ADD CONSTRAINT "EventAttendance_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
