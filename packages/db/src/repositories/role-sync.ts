/**
 * The reads behind `role-sync`: everything the auto-role rules can ask about a
 * batch of members, in one query per table rather than one per rule.
 *
 * A guild with thirty rules and four hundred members is five queries a pass
 * here, and would be twelve thousand the naive way. The shape is deliberately
 * batch-in, batch-out for that reason — the pure resolver evaluates every rule
 * against a bundle already in memory.
 */
import type { RoleMemberSnapshot } from "@sbr/jobs";
import { prisma } from "../client.js";

export const roleSyncRepository = {
  /** Everyone we might have to act on: the Discord roster we mirror. */
  async listMemberIds(guildId: string): Promise<readonly string[]> {
    const rows = await prisma.guildMember.findMany({
      where: { guildId, status: "ACTIVE" },
      select: { discordUser: { select: { discordId: true } } },
    });
    return rows.map((row) => row.discordUser.discordId);
  },

  /**
   * Every guild on this platform the member belongs to.
   *
   * Auto-roles are per guild, and the events that change a member's facts —
   * linking, most of all — are not. This is how a guild-agnostic change becomes
   * the right set of per-guild marks.
   */
  async guildIdsForMember(discordId: string): Promise<readonly string[]> {
    const rows = await prisma.guildMember.findMany({
      where: { discordUser: { discordId } },
      select: { guildId: true },
    });
    return [...new Set(rows.map((row) => row.guildId))];
  },

  /**
   * Discord ids for a batch of Minecraft uuids, for callers that only learned
   * about a change in Hypixel terms.
   *
   * A uuid with no verified link yields nothing: they are not a Discord member
   * we can give a role to, so there is nothing for the reconciler to do.
   */
  async discordIdsForUuids(uuids: readonly string[]): Promise<readonly string[]> {
    if (uuids.length === 0) return [];
    const rows = await prisma.linkedAccount.findMany({
      where: { minecraftUuid: { in: [...new Set(uuids)] }, status: "VERIFIED" },
      select: { discordUser: { select: { discordId: true } } },
    });
    return [...new Set(rows.map((row) => row.discordUser.discordId))];
  },

  /**
   * One bundle per member.
   *
   * Members with no `GuildMember` row are simply absent from the result: they
   * are not in the server, so there is nothing to reconcile and no facts to
   * gather. The caller drops them rather than acting on an empty bundle, which
   * would read as "qualifies for nothing" and revoke.
   */
  async loadSnapshots(guildId: string, discordIds: readonly string[]): Promise<readonly RoleMemberSnapshot[]> {
    if (discordIds.length === 0) return [];
    const ids = [...new Set(discordIds)];

    const members = await prisma.guildMember.findMany({
      where: { guildId, discordUser: { discordId: { in: ids } } },
      select: {
        discordUserId: true,
        guildRank: true,
        roleIds: true,
        status: true,
        discordUser: { select: { discordId: true } },
      },
    });
    if (members.length === 0) return [];

    const userIds = members.map((m) => m.discordUserId);
    const present = members.map((m) => m.discordUser.discordId);

    const [links, balances, milestones, attendance] = await Promise.all([
      prisma.linkedAccount.findMany({
        where: { discordUserId: { in: userIds }, status: "VERIFIED" },
        select: { discordUserId: true },
      }),
      prisma.xpBalance.findMany({
        where: { guildId, discordId: { in: present } },
        select: { discordId: true, level: true },
      }),
      // The denormalized `discordId` on Milestone is what makes this one query:
      // going through the link would be a join per member, and a member who
      // relinked would lose achievements they had already earned.
      prisma.milestone.findMany({
        where: { guildId, discordId: { in: present }, definition: { isNot: null } },
        select: { discordId: true, definition: { select: { key: true } } },
      }),
      prisma.eventAttendance.groupBy({
        by: ["discordId"],
        where: { discordId: { in: present }, event: { guildId } },
        _count: { _all: true },
      }),
    ]);

    const linked = new Set(links.map((l) => l.discordUserId));
    const level = new Map(balances.map((b) => [b.discordId, b.level]));
    const attended = new Map(attendance.map((a) => [a.discordId, a._count._all]));
    const keys = new Map<string, string[]>();
    for (const row of milestones) {
      const key = row.definition?.key;
      if (row.discordId === null || key === undefined) continue;
      const list = keys.get(row.discordId);
      if (list === undefined) keys.set(row.discordId, [key]);
      else list.push(key);
    }

    return members.map((member) => {
      const discordId = member.discordUser.discordId;
      return {
        facts: {
          discordId,
          // "In the guild" means the Hypixel guild, not the Discord server: the
          // rule a guild writes as "guild member" is about the roster. A rank
          // is what the roster scan writes, so its presence is the membership.
          inGuild: member.status === "ACTIVE" && member.guildRank !== null,
          linked: linked.has(member.discordUserId),
          guildRank: member.guildRank,
          xpLevel: level.get(discordId) ?? 0,
          achievementKeys: keys.get(discordId) ?? [],
          eventsAttended: attended.get(discordId) ?? 0,
        },
        heldRoleIds: member.roleIds,
      };
    });
  },
};

/**
 * Turns a per-guild dirty marker into the guild-agnostic one identity wants.
 *
 * Lives here rather than in a composition file because every app that links
 * accounts needs exactly this, and the fan-out query is a database concern. The
 * structural parameter type keeps `@sbr/db` from having to depend on either the
 * identity package or the Redis one.
 */
export function memberRoleDirtyMarker(sink: {
  mark(guildId: string, discordIds: readonly string[]): Promise<void>;
}): { markMember(discordId: string): Promise<void> } {
  return {
    async markMember(discordId) {
      const guildIds = await roleSyncRepository.guildIdsForMember(discordId);
      for (const guildId of guildIds) await sink.mark(guildId, [discordId]);
    },
  };
}
