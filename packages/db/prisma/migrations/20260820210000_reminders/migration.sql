-- Reminders set by members with `/remind`.
--
-- Durable rather than an in-process timer: a reminder set for tomorrow has to
-- survive tonight's deploy. The sweeper reads `(delivered, dueAt)` and flips the
-- flag after the message lands.
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- The sweeper's query: undelivered, oldest due first.
CREATE INDEX "Reminder_delivered_dueAt_idx" ON "Reminder"("delivered", "dueAt");

-- `/reminders` — one member's own pending list.
CREATE INDEX "Reminder_guildId_discordId_delivered_idx" ON "Reminder"("guildId", "discordId", "delivered");

ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;
