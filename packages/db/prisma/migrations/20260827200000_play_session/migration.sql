-- Measure playtime instead of sampling it.
--
-- `ActivityDaily.presenceSamples` counted how often a member turned up in a
-- `/g online` read. That is a proxy with two failure modes pointing opposite
-- ways: somebody on for ten hours while nobody typed the command scores zero,
-- and somebody who logs in for a minute during a busy hour scores as highly as
-- somebody who played through it. The column stays — it is what every existing
-- XP award was computed from, and rewriting history silently is worse than a
-- column with a narrow meaning — but nothing new is derived from it.
--
-- A session is bounded by the bridge account's own view of guild chat: Hypixel
-- prints `Guild > Steve joined.` and `Guild > Steve left.`, and those two lines
-- are the whole signal. Sessions are stored closed, one row each, rather than
-- as a running total, so a bad reading can be found and deleted rather than
-- having to be subtracted from an opaque counter.
--
-- Keyed on `ign` rather than a member id on purpose: the bridge sees Minecraft
-- names and nothing else, and a member who has not linked a Discord account
-- still plays. Linking happens at read time, where a missing link is visible.

CREATE TABLE "PlaySession" (
  "id"        TEXT NOT NULL,
  "guildId"   TEXT NOT NULL,
  "ign"       TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "endedAt"   TIMESTAMP(3) NOT NULL,
  "seconds"   INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PlaySession_pkey" PRIMARY KEY ("id")
);

-- The two questions asked of this table: "how much has this member played
-- lately" and "who played over this window". One index each.
CREATE INDEX "PlaySession_guildId_ign_startedAt_idx" ON "PlaySession"("guildId", "ign", "startedAt");
CREATE INDEX "PlaySession_guildId_startedAt_idx" ON "PlaySession"("guildId", "startedAt");

-- A restart that replays the same chat window must not double-count. The end
-- time is exact to the millisecond and comes from the leave notice, so the pair
-- is as close to a natural key as this data has.
CREATE UNIQUE INDEX "PlaySession_guildId_ign_endedAt_key" ON "PlaySession"("guildId", "ign", "endedAt");

ALTER TABLE "PlaySession"
  ADD CONSTRAINT "PlaySession_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;
