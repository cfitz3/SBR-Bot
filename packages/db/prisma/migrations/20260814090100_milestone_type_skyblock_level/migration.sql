-- SkyBlock Level becomes a milestone kind of its own rather than riding under
-- CUSTOM, so the panel can label and sort it like the other progression tracks.
--
-- Additive only: no existing row's value changes, and nothing is removed.
ALTER TYPE "MilestoneType" ADD VALUE IF NOT EXISTS 'SKYBLOCK_LEVEL';
