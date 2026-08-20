-- The grant ledger behind automatic Discord roles.
--
-- Auto-roles only ever remove a role that has an open row here, so a role
-- somebody was given by hand is never stripped by a reconcile. Grants are
-- closed by setting "revokedAt", not deleted: "we gave this and took it back"
-- is the question staff ask when a member complains.
CREATE TABLE "RoleGrant" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "reason" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "RoleGrant_pkey" PRIMARY KEY ("id")
);

-- The reconciler's read: every open grant for one member.
CREATE INDEX "RoleGrant_guildId_discordId_idx" ON "RoleGrant"("guildId", "discordId");

-- "Who did this rule give this role to", for the panel's dry run and for
-- cleaning up after a deleted rule.
CREATE INDEX "RoleGrant_guildId_roleId_idx" ON "RoleGrant"("guildId", "roleId");

-- One *open* grant per (member, role, rule). Partial on purpose: a total unique
-- constraint would make a revoked grant permanently unrepeatable, so a member
-- who left the guild and came back could never be given the member role again.
CREATE UNIQUE INDEX "RoleGrant_open_key"
    ON "RoleGrant"("guildId", "discordId", "roleId", "ruleKey")
    WHERE "revokedAt" IS NULL;

ALTER TABLE "RoleGrant" ADD CONSTRAINT "RoleGrant_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;
