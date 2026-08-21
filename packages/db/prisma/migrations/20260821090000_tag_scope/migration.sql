-- Where a canned reply's auto-pattern may fire.
--
-- TICKET is the default so every tag written before this keeps the blast radius
-- it was created with; answering members in open channels is opt-in.
CREATE TYPE "TagScope" AS ENUM ('TICKET', 'SERVER', 'ANY');

ALTER TABLE "TicketTag" ADD COLUMN "scope" "TagScope" NOT NULL DEFAULT 'TICKET';
