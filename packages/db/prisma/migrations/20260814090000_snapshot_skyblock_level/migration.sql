-- SkyBlock Level on the snapshot row.
--
-- Nullable with no backfill, for the same reason `slayerXp` was: a historical
-- row genuinely does not know the figure, and 0 would read as "level zero" —
-- putting every member captured before today at the bottom of the level
-- leaderboard and, worse, making the first real capture look like a jump from
-- nothing to 300. A NULL row is simply absent from that one ranking until the
-- next snapshot pass fills it in.
ALTER TABLE "ProfileSnapshot" ADD COLUMN "skyblockLevel" DOUBLE PRECISION;
