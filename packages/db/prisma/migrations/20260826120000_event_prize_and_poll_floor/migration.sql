-- Free-text prize, shown on the board and the result card. Nullable: every
-- event that already exists was run without one.
ALTER TABLE "Event" ADD COLUMN "prize" TEXT;

-- The poll interval's floor is one hour, because one poll is one Hypixel
-- profile fetch per participant and the Developer API Policy caps this platform
-- at one request per player per hour. Values under the floor were already being
-- clamped to it at read time, so raising them here changes no behaviour — it
-- only stops the stored number from disagreeing with the one in effect.
ALTER TABLE "Event" ALTER COLUMN "pollIntervalMinutes" SET DEFAULT 60;
UPDATE "Event" SET "pollIntervalMinutes" = 60 WHERE "pollIntervalMinutes" < 60;
