-- Ticket staff powers become a bridge capability, granted the same way every
-- other one is. Additive only: no existing row names the new value, so nothing
-- has to be backfilled and the per-category `staffRoleIds` grant is unchanged.
ALTER TYPE "BridgeCapability" ADD VALUE 'TICKET_MANAGE';
