-- Role derivation: the facts `resolveMemberRole` needs, on the row that already
-- holds the membership.
--
-- Both columns are additive with defaults, so an existing guild keeps exactly
-- the roles it has today: `roleIds` starts empty (nothing to raise anyone by)
-- and `roleOverride` starts null (no demotion in force), which makes the derived
-- role identical to the stored `role` until the sync job and the panel fill them
-- in.
ALTER TABLE "GuildMember" ADD COLUMN "roleIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "GuildMember" ADD COLUMN "roleOverride" "MemberRole";
