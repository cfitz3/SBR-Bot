-- The two "newest first, whole guild" reads behind the Moderation page. Both
-- previously fell back to a sort over every row the guild had ever recorded.
CREATE INDEX "ModerationAction_guildId_createdAt_idx" ON "ModerationAction"("guildId", "createdAt");
CREATE INDEX "Infraction_guildId_createdAt_idx" ON "Infraction"("guildId", "createdAt");
