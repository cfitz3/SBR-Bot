-- The board's "this card is finished" flag. Without it a completed event's
-- board is indistinguishable from one that is merely overdue for a refresh.
ALTER TABLE "Event" ADD COLUMN "boardFinal" BOOLEAN NOT NULL DEFAULT false;

-- The board pass reads by status and by how stale the board is.
CREATE INDEX "Event_status_boardUpdatedAt_idx" ON "Event"("status", "boardUpdatedAt");
