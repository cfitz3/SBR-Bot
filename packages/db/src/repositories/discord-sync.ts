/**
 * Persistence for the Discord half of the member directory, written by the
 * `discord-member-sync` job every two hours.
 *
 * Two tables, deliberately: `DiscordUser` is the person (one row per human,
 * shared across every server we are in) and `GuildMember` is their membership of
 * one guild. A username change follows them everywhere; a nickname or a departure
 * does not.
 */
import { Prisma } from "@prisma/client";
import type { DiscordMemberWrite } from "@sbr/jobs";
import { prisma } from "../client.js";

/** Keeps one statement inside Postgres' parameter ceiling; see guild-scan.ts. */
const CHUNK = 100;

function chunk<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export const discordSyncRepository = {
  /** Discord ids we currently believe are in the server. */
  async listActiveIds(guildId: string): Promise<readonly string[]> {
    const rows = await prisma.guildMember.findMany({
      where: { guildId, status: "ACTIVE" },
      select: { discordUser: { select: { discordId: true } } },
    });
    return rows.map((row) => row.discordUser.discordId);
  },

  /**
   * Upsert people and their membership.
   *
   * Two multi-row statements per batch rather than a loop of Prisma upserts: a
   * thousand-member server is two thousand round trips the naive way, every two
   * hours, for data that changes by a handful of rows.
   *
   * `role` is conspicuously absent from the update: it is the *platform* role,
   * set by staff on the Members page, and a roster scan has no business
   * resetting somebody to MEMBER. Likewise `status` is only ever moved *back* to
   * ACTIVE here — a member who returns is not a new person.
   */
  async upsertMembers(guildId: string, rows: readonly DiscordMemberWrite[]): Promise<void> {
    for (const batch of chunk(rows, CHUNK)) {
      const people = batch.map(
        (r) => Prisma.sql`(gen_random_uuid()::text, ${r.discordId}, ${r.username}, ${r.globalName},
          ${r.avatarHash}, NOW(), NOW())`,
      );
      await prisma.$executeRaw`
        INSERT INTO "DiscordUser"
          ("id", "discordId", "username", "globalName", "avatarHash", "createdAt", "updatedAt")
        VALUES ${Prisma.join(people)}
        ON CONFLICT ("discordId") DO UPDATE SET
          "username"   = EXCLUDED."username",
          "globalName" = EXCLUDED."globalName",
          "avatarHash" = EXCLUDED."avatarHash",
          "updatedAt"  = NOW()
      `;

      const memberships = batch.map(
        (r) => Prisma.sql`(gen_random_uuid()::text, ${guildId},
          (SELECT "id" FROM "DiscordUser" WHERE "discordId" = ${r.discordId}),
          ${r.nickname}, ${r.joinedAt}, ${[...r.roleIds]}::text[], NOW(), NOW())`,
      );
      await prisma.$executeRaw`
        INSERT INTO "GuildMember"
          ("id", "guildId", "discordUserId", "nickname", "joinedAt", "roleIds", "createdAt", "updatedAt")
        VALUES ${Prisma.join(memberships)}
        ON CONFLICT ("guildId", "discordUserId") DO UPDATE SET
          "nickname"  = EXCLUDED."nickname",
          -- The scan is authoritative for roles: a role removed in Discord must
          -- disappear here, or a demoted staffer keeps their capabilities.
          "roleIds"   = EXCLUDED."roleIds",
          -- Discord's own join timestamp is authoritative, but a scan that could
          -- not read it must not erase the one we already have.
          "joinedAt"  = COALESCE(EXCLUDED."joinedAt", "GuildMember"."joinedAt"),
          "status"    = 'ACTIVE',
          "leftAt"    = NULL,
          "updatedAt" = NOW()
      `;
    }
  },

  /**
   * Mark departures. Rows are never deleted: moderation history, XP balances and
   * link records all point at a membership, and a member who leaves is exactly
   * the one whose history someone is about to ask about.
   */
  async markLeft(guildId: string, discordIds: readonly string[]): Promise<void> {
    if (discordIds.length === 0) return;
    await prisma.guildMember.updateMany({
      where: { guildId, discordUser: { discordId: { in: [...discordIds] } }, status: "ACTIVE" },
      data: { status: "LEFT", leftAt: new Date() },
    });
  },

  /** When this guild's Discord roster was last written, or null if never. */
  async lastSyncedAt(guildId: string): Promise<Date | null> {
    const row = await prisma.guildMember.findFirst({
      where: { guildId },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    });
    return row?.updatedAt ?? null;
  },
};
