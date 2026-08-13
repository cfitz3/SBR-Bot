-- Where a moderation action was issued.
--
-- Existing rows are all panel- or bot-issued, so the DISCORD default backfills
-- them correctly and no data migration is needed. The new value in practice is
-- INGAME: actions reconstructed from Hypixel's own guild-chat notices, which
-- have no actor snowflake and are only emitted for some events. Recording the
-- surface is what lets the Moderation page say so instead of implying parity.
ALTER TABLE "ModerationAction" ADD COLUMN "sourceContext" "SourceContext" NOT NULL DEFAULT 'DISCORD';

CREATE INDEX "ModerationAction_guildId_sourceContext_createdAt_idx"
  ON "ModerationAction" ("guildId", "sourceContext", "createdAt");
