-- LFG rework (PLATFORM_EXPANSION_PLAN.md §2.4, Phase 4).
--
-- Purely additive: every column is nullable with no default, so existing posts
-- keep working and this can be deployed ahead of the code that writes them.
--
-- `channelId`/`messageId` let a post's embed be edited in place as the roster
-- changes; `permGroupId` records which perm a roster was autofilled from; and
-- the closure pair separates "the author closed this" from "it expired".

ALTER TABLE "LFGPost" ADD COLUMN "title" TEXT;
ALTER TABLE "LFGPost" ADD COLUMN "channelId" TEXT;
ALTER TABLE "LFGPost" ADD COLUMN "messageId" TEXT;
ALTER TABLE "LFGPost" ADD COLUMN "permGroupId" TEXT;
ALTER TABLE "LFGPost" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "LFGPost" ADD COLUMN "closedByDiscordId" TEXT;

-- No index on messageId on purpose: every button carries its post id in the
-- customId, so nothing ever looks a post up by the message it was posted as.
