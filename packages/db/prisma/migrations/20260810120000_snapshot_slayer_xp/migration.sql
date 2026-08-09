-- Total slayer XP on the snapshot row.
--
-- Nullable with no backfill on purpose: existing rows genuinely do not know the
-- figure, and writing 0 would put every historical member at the bottom of the
-- slayer leaderboard as though they had never killed anything. The next
-- snapshot pass fills each account in, and until then a NULL row is simply
-- absent from that one ranking.
ALTER TABLE "ProfileSnapshot" ADD COLUMN "slayerXp" BIGINT;
