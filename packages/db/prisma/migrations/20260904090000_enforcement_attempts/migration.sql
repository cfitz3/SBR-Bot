-- Enforcement gets a memory: how many times we tried, when we last tried, and
-- what each surface said. Additive only; existing rows keep their verdict.
ALTER TABLE "ModerationAction" ADD COLUMN "enforcementAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ModerationAction" ADD COLUMN "enforcementAt" TIMESTAMP(3);

-- Every settled row was tried exactly once by the code that wrote it, and was
-- tried when it was created. Backfilling that is what stops the first sweep
-- after this migration treating the entire history as never-attempted.
UPDATE "ModerationAction"
SET "enforcementAttempts" = 1, "enforcementAt" = "createdAt"
WHERE "enforcement" <> 'PENDING';

-- Pending rows keep attempts = 0 but must still be dated, or the sweep would
-- measure their staleness from a null and re-enforce the whole backlog at once.
UPDATE "ModerationAction" SET "enforcementAt" = "createdAt" WHERE "enforcementAt" IS NULL;

CREATE TABLE "EnforcementAttempt" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "surface" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnforcementAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EnforcementAttempt_actionId_createdAt_idx" ON "EnforcementAttempt"("actionId", "createdAt");
CREATE INDEX "ModerationAction_enforcement_enforcementAt_idx" ON "ModerationAction"("enforcement", "enforcementAt");

ALTER TABLE "EnforcementAttempt" ADD CONSTRAINT "EnforcementAttempt_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "ModerationAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
