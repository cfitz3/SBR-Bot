-- Perms: standing parties and their rosters.
--
-- Purely additive. Nothing reads these tables until `/perm` ships, so this is
-- safe to deploy ahead of the code.

CREATE TYPE "PermStatus" AS ENUM ('ACTIVE', 'DISBANDED');

CREATE TABLE "PermGroup" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "ownerDiscordId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "activity" "LFGActivity" NOT NULL DEFAULT 'OTHER',
    "status" "PermStatus" NOT NULL DEFAULT 'ACTIVE',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PermGroup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PermGroup_guildId_ownerDiscordId_status_idx" ON "PermGroup"("guildId", "ownerDiscordId", "status");
CREATE INDEX "PermGroup_guildId_activity_status_idx" ON "PermGroup"("guildId", "activity", "status");

-- A perm is addressed by name, so the name has to be unambiguous while the perm
-- is running. Filtered to ACTIVE so disbanding frees the name for reuse, and
-- LOWER() so "Carries" and "carries" cannot both exist — people type these from
-- memory in guild chat, not from a picker.
CREATE UNIQUE INDEX "PermGroup_guildId_name_active_key"
    ON "PermGroup"("guildId", LOWER("name"))
    WHERE "status" = 'ACTIVE';

-- At most one default perm per owner per activity. Prisma cannot express a
-- filtered unique constraint, so it lives here and the service checks it too:
-- this index is the backstop that survives a race, not the error message.
CREATE UNIQUE INDEX "PermGroup_default_per_owner_activity_key"
    ON "PermGroup"("guildId", "ownerDiscordId", "activity")
    WHERE "isDefault" = true AND "status" = 'ACTIVE';

ALTER TABLE "PermGroup"
    ADD CONSTRAINT "PermGroup_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PermMember" (
    "id" TEXT NOT NULL,
    "permGroupId" TEXT NOT NULL,
    "discordId" TEXT,
    "uuid" TEXT,
    "ign" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "slot" INTEGER NOT NULL DEFAULT 0,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PermMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PermMember_permGroupId_ign_role_key" ON "PermMember"("permGroupId", "ign", "role");
CREATE INDEX "PermMember_permGroupId_slot_idx" ON "PermMember"("permGroupId", "slot");

ALTER TABLE "PermMember"
    ADD CONSTRAINT "PermMember_permGroupId_fkey"
    FOREIGN KEY ("permGroupId") REFERENCES "PermGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
