-- The member directory and the GEXP board both order a guild's cache by
-- weeklyGexp descending. Additive index; no data changes.
CREATE INDEX "GuildMemberCache_guildId_weeklyGexp_idx" ON "GuildMemberCache"("guildId", "weeklyGexp");
