/**
 * The grant ledger: which roles this platform handed out, and on whose say-so.
 *
 * Every write here follows a Discord write that already succeeded. The ordering
 * is deliberate and the safe way round: a row recorded for a grant that never
 * landed would authorise us to revoke a role we never gave, while a grant that
 * landed and was not recorded simply means we do not claim it — the member
 * keeps the role and the next reconcile records nothing new.
 */
import type { GrantRecord, GrantRow, RoleGrantRepository } from "@sbr/roles";
import { prisma } from "../client.js";

export const roleGrantRepository: RoleGrantRepository = {
  async openGrants(guildId, discordId) {
    const rows = await prisma.roleGrant.findMany({
      where: { guildId, discordId, revokedAt: null },
      select: { ruleKey: true, roleId: true },
    });
    return rows;
  },

  async recordGrants(guildId, discordId, rows, reason) {
    if (rows.length === 0) return;
    await prisma.roleGrant.createMany({
      data: rows.map((row) => ({ guildId, discordId, roleId: row.roleId, ruleKey: row.ruleKey, reason })),
      // The partial unique index covers open rows only. A duplicate here means
      // a concurrent reconcile got there first, which is not a problem worth
      // failing a whole pass over.
      skipDuplicates: true,
    });
  },

  async closeGrants(guildId, discordId, rows) {
    if (rows.length === 0) return;
    await prisma.roleGrant.updateMany({
      where: {
        guildId,
        discordId,
        revokedAt: null,
        OR: rows.map((row) => ({ roleId: row.roleId, ruleKey: row.ruleKey })),
      },
      data: { revokedAt: new Date() },
    });
  },

  async openGrantsByMember(guildId, discordIds) {
    const byMember = new Map<string, GrantRow[]>();
    if (discordIds.length === 0) return byMember;
    const rows = await prisma.roleGrant.findMany({
      where: { guildId, discordId: { in: [...new Set(discordIds)] }, revokedAt: null },
      select: { discordId: true, ruleKey: true, roleId: true },
    });
    for (const row of rows) {
      const list = byMember.get(row.discordId);
      if (list === undefined) byMember.set(row.discordId, [{ ruleKey: row.ruleKey, roleId: row.roleId }]);
      else list.push({ ruleKey: row.ruleKey, roleId: row.roleId });
    }
    // Members with no open grants are absent rather than empty-listed; the
    // caller defaults, and an empty ledger is the honest answer for them.
    return byMember;
  },

  async openGrantsForRule(guildId, ruleKey): Promise<readonly GrantRecord[]> {
    const rows = await prisma.roleGrant.findMany({
      where: { guildId, ruleKey, revokedAt: null },
      select: { discordId: true, roleId: true, ruleKey: true, grantedAt: true },
      orderBy: { grantedAt: "desc" },
      take: MAX_ROWS,
    });
    return rows.map((row) => ({
      discordId: row.discordId,
      roleId: row.roleId,
      ruleKey: row.ruleKey,
      grantedAt: row.grantedAt.toISOString(),
    }));
  },
};

/** A panel list, not an export: a rule covering a whole guild is normal. */
const MAX_ROWS = 500;

export type { GrantRecord, GrantRow };
