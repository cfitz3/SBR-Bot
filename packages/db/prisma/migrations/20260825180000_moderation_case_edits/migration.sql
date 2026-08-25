-- Let a moderation case be corrected after the fact.
--
-- The table was append-only. A reason typed wrong stayed wrong, a duration set
-- in haste could not be shortened, and a case enforced by hand could not be
-- marked as such — so the enforcement column added last week accumulated FAILED
-- rows that staff had already dealt with, which is the fastest way to teach
-- people to ignore a queue.
--
-- Four columns, all nullable, all "this has been touched since it was written":
--
--   updatedAt          when the row was last edited, null while it is original.
--                      Deliberately not @updatedAt: the enforcement stamp that
--                      settles a punishment is the service finishing its own
--                      work, not somebody editing the case, and a column that
--                      moved on both could not tell the two apart.
--   editedByDiscordId  who edited it. An edit with no author is a rumour.
--   voidedAt           when it was voided. A void is soft: the record of a
--                      punishment that should not have happened is itself worth
--                      keeping, and deleting the row would leave the case id
--                      dangling in every mod-log card that already quoted it.
--   voidReason         why. Required by the service, nullable here because
--                      every existing row predates the concept.

ALTER TABLE "ModerationAction"
  ADD COLUMN "updatedAt" TIMESTAMP(3),
  ADD COLUMN "editedByDiscordId" TEXT,
  ADD COLUMN "voidedAt" TIMESTAMP(3),
  ADD COLUMN "voidReason" TEXT;
