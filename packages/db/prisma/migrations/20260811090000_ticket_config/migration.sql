-- Ticketing config: the panel a guild posts, and the types a member can pick.
--
-- Purely additive. `/ticket` falls back to the five built-in types when a guild
-- has no rows here, so every existing guild keeps the behaviour it has today
-- until an admin configures something.

CREATE TABLE "TicketPanelConfig" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT,
    "messageId" TEXT,
    "title" TEXT NOT NULL DEFAULT 'Support',
    "description" TEXT,
    "embed" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketPanelConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TicketPanelConfig_guildId_key" ON "TicketPanelConfig"("guildId");

ALTER TABLE "TicketPanelConfig" ADD CONSTRAINT "TicketPanelConfig_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TicketTypeConfig" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "emoji" TEXT,
    "category" "TicketCategory" NOT NULL DEFAULT 'SUPPORT',
    "parentChannelId" TEXT,
    "staffRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "prompt" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketTypeConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TicketTypeConfig_guildId_key_key" ON "TicketTypeConfig"("guildId", "key");
CREATE INDEX "TicketTypeConfig_guildId_enabled_idx" ON "TicketTypeConfig"("guildId", "enabled");

ALTER TABLE "TicketTypeConfig" ADD CONSTRAINT "TicketTypeConfig_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;
