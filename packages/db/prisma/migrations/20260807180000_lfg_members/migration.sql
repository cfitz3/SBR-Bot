-- Roster for LFG posts. Additive: existing rows get an empty array, and
-- `slotsFilled` stays authoritative for counts until each post is next touched.
ALTER TABLE "LFGPost" ADD COLUMN "members" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
