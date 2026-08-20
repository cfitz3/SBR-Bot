-- Milestones become achievements: the same thresholds, presented.
--
-- Tier, icon and hidden are editorial judgements a guild makes and nothing can
-- derive — Catacombs 50 outranks Catacombs 10 by a decision, not by arithmetic.
-- Category is deliberately NOT stored: it follows from the metric, and a column
-- that can disagree with the metric it describes is a bug waiting to be filed.
CREATE TYPE "AchievementTier" AS ENUM ('BRONZE', 'SILVER', 'GOLD', 'PLATINUM');

ALTER TABLE "MilestoneDefinition"
    ADD COLUMN "tier" "AchievementTier" NOT NULL DEFAULT 'BRONZE',
    ADD COLUMN "icon" TEXT,
    -- A hidden achievement is not listed while it is locked. It still detects,
    -- announces and pays exactly as any other; the only difference is that a
    -- member reads about it when they get it.
    ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
