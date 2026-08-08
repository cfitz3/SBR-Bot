-- `/set-role type:mapping` binds a platform role to a Discord role id.
-- Existing guilds get an empty map, which reads as "no mappings configured".
ALTER TABLE "GuildConfig" ADD COLUMN "roleMappings" JSONB NOT NULL DEFAULT '{}';
