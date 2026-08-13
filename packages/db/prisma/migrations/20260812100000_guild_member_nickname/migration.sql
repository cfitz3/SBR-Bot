-- Per-server display name, written by the `discord-member-sync` job.
--
-- Nullable and with no backfill: the column is empty until the first sync runs,
-- and "no nickname set" and "not scanned yet" are both legitimately null. The
-- panel distinguishes them by the scan clock, not by this column.
ALTER TABLE "GuildMember" ADD COLUMN "nickname" TEXT;

-- The member directory searches username, nickname and IGN together. Postgres
-- cannot use a btree index for the leading-wildcard match that search does, so
-- this index earns its keep on the exact-id and prefix paths only; the roster is
-- guild-sized, and the planner falls back to a scan of one guild's rows.
CREATE INDEX "GuildMember_guildId_nickname_idx" ON "GuildMember" ("guildId", "nickname");
