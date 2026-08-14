/**
 * The values every leaderboard ranks, one query per category.
 *
 * Four tables answer eight categories, and the joins that turn each of them
 * into "a member of this guild, with a name" live here rather than in
 * `@sbr/leaderboards` — the domain package sees a flat `{ key, label, value }`
 * and never learns that wealth comes from a snapshot and XP from a balance.
 *
 * **Who is eligible.** Every category is filtered to *active members of this
 * guild*. Someone who left keeps their history — the ledger and the snapshots
 * are not rewritten — but they stop being ranked, because a leaderboard is a
 * statement about the guild as it is now.
 */
import type { LeaderboardCategory, LeaderboardSource, MemberValue } from "@sbr/leaderboards";
import { prisma } from "../client.js";

/** Bound on any one board. A guild is ~125 people; this is the runaway guard. */
const MAX_ROWS = 1_000;

/** Membership filter, reused by every query so eligibility is defined once. */
function activeMemberOfGuild(guildId: string) {
  return { memberships: { some: { guildId, status: "ACTIVE" as const } } };
}

/**
 * Discord snowflake → IGN, for the Discord-keyed boards.
 *
 * Ordered primary-first, newest-verification-second, and the first row per
 * member wins — the same precedence `linkDirectory` uses, so a member with two
 * linked accounts shows the same name everywhere.
 */
async function ignByDiscordId(guildId: string): Promise<Map<string, string>> {
  const rows = await prisma.linkedAccount.findMany({
    where: { status: "VERIFIED", discordUser: activeMemberOfGuild(guildId) },
    orderBy: [{ isPrimary: "desc" }, { verifiedAt: "desc" }],
    select: {
      discordUser: { select: { discordId: true } },
      minecraftAccount: { select: { currentIgn: true } },
    },
  });

  const out = new Map<string, string>();
  for (const row of rows) {
    const ign = row.minecraftAccount.currentIgn;
    if (ign === null || out.has(row.discordUser.discordId)) continue;
    out.set(row.discordUser.discordId, ign);
  }
  return out;
}

/**
 * A Discord-keyed row's display name. An unlinked member is rendered as a
 * mention rather than a raw id: Discord resolves it to their name, and the
 * in-game surface flattens it, so neither surface prints a snowflake.
 */
function labelFor(discordId: string, igns: ReadonlyMap<string, string>): string {
  return igns.get(discordId) ?? `<@${discordId}>`;
}

/** Every active member's snowflake, for filtering the aggregate boards. */
async function activeSnowflakes(guildId: string): Promise<ReadonlySet<string>> {
  const rows = await prisma.guildMember.findMany({
    where: { guildId, status: "ACTIVE" },
    select: { discordUser: { select: { discordId: true } } },
  });
  return new Set(rows.map((r) => r.discordUser.discordId));
}

type SnapshotMetric = "skyblockLevel" | "networth" | "skillAverage" | "catacombsLevel" | "slayerXp";

/**
 * The newest snapshot per linked account, projected onto one metric.
 *
 * `distinct` over an ordered `findMany` is Prisma's per-group-latest: order by
 * account then capture time descending and keep the first row per account. One
 * query for the whole guild, not one per member.
 *
 * A null metric is dropped rather than read as zero — a profile with its API
 * off is unknown, and unknown is not "poorest in the guild".
 */
async function snapshotValues(guildId: string, metric: SnapshotMetric): Promise<readonly MemberValue[]> {
  const rows = await prisma.profileSnapshot.findMany({
    where: {
      minecraftAccount: {
        linkedAccounts: { some: { status: "VERIFIED", discordUser: activeMemberOfGuild(guildId) } },
      },
    },
    orderBy: [{ minecraftAccountId: "asc" }, { capturedAt: "desc" }],
    distinct: ["minecraftAccountId"],
    take: MAX_ROWS,
    select: {
      capturedAt: true,
      skyblockLevel: true,
      networth: true,
      skillAverage: true,
      catacombsLevel: true,
      slayerXp: true,
      minecraftAccount: { select: { uuid: true, currentIgn: true } },
    },
  });

  const values: MemberValue[] = [];
  for (const row of rows) {
    const raw = row[metric];
    if (raw === null) continue;
    values.push({
      key: row.minecraftAccount.uuid,
      label: row.minecraftAccount.currentIgn ?? row.minecraftAccount.uuid.slice(0, 8),
      value: typeof raw === "bigint" ? Number(raw) : raw,
      at: row.capturedAt.toISOString(),
    });
  }
  return values;
}

/**
 * Days since joining, from `GuildMember.joinedAt` — the same column XP's tenure
 * awards are computed from, so a member's tenure rank and their tenure XP can
 * never disagree.
 */
async function tenureValues(guildId: string): Promise<readonly MemberValue[]> {
  const [rows, igns] = await Promise.all([
    prisma.guildMember.findMany({
      where: { guildId, status: "ACTIVE", joinedAt: { not: null } },
      take: MAX_ROWS,
      select: { joinedAt: true, discordUser: { select: { discordId: true } } },
    }),
    ignByDiscordId(guildId),
  ]);

  const now = Date.now();
  return rows.map((row) => ({
    key: row.discordUser.discordId,
    label: labelFor(row.discordUser.discordId, igns),
    value: Math.max(0, Math.floor((now - (row.joinedAt?.getTime() ?? now)) / 86_400_000)),
    // Derived at read time from a stored date — there is no "reading" to age.
    at: null,
  }));
}

/** Summed daily counters over a rolling window. */
async function activityValues(
  guildId: string,
  field: "discordMessages" | "guildChatMessages",
  windowDays: number,
): Promise<readonly MemberValue[]> {
  const cutoff = new Date(Date.now() - windowDays * 86_400_000);
  cutoff.setUTCHours(0, 0, 0, 0);

  const [rows, igns, active] = await Promise.all([
    prisma.activityDaily.groupBy({
      by: ["discordId"],
      where: { guildId, day: { gte: cutoff } },
      _sum: { discordMessages: true, guildChatMessages: true },
      // No `take`: Prisma only allows one alongside an aggregate `orderBy`, and
      // the membership filter below already bounds this to the guild's roster.
    }),
    ignByDiscordId(guildId),
    activeSnowflakes(guildId),
  ]);

  return rows
    .filter((row) => active.has(row.discordId))
    .map((row) => ({
      key: row.discordId,
      label: labelFor(row.discordId, igns),
      value: row._sum[field] ?? 0,
      at: null,
    }));
}

/** Total guild XP, from the balance the aggregate job rebuilds. */
async function xpValues(guildId: string): Promise<readonly MemberValue[]> {
  const [rows, igns, active] = await Promise.all([
    prisma.xpBalance.findMany({
      where: { guildId },
      orderBy: { totalXp: "desc" },
      take: MAX_ROWS,
      select: { discordId: true, totalXp: true },
    }),
    ignByDiscordId(guildId),
    activeSnowflakes(guildId),
  ]);

  return rows
    .filter((row) => active.has(row.discordId))
    .map((row) => ({
      key: row.discordId,
      label: labelFor(row.discordId, igns),
      value: row.totalXp,
      at: null,
    }));
}

/** True for the categories keyed by Minecraft uuid rather than Discord id. */
function isSnapshotCategory(category: LeaderboardCategory): boolean {
  return (
    category === "level" ||
    category === "wealth" ||
    category === "skill-average" ||
    category === "catacombs" ||
    category === "slayer"
  );
}

export const leaderboardSource: LeaderboardSource = {
  async values(guildId, category, windowDays): Promise<readonly MemberValue[]> {
    switch (category) {
      case "level":
        return snapshotValues(guildId, "skyblockLevel");
      case "wealth":
        return snapshotValues(guildId, "networth");
      case "skill-average":
        return snapshotValues(guildId, "skillAverage");
      case "catacombs":
        return snapshotValues(guildId, "catacombsLevel");
      case "slayer":
        return snapshotValues(guildId, "slayerXp");
      case "tenure":
        return tenureValues(guildId);
      case "discord-activity":
        return activityValues(guildId, "discordMessages", windowDays);
      case "guild-chat":
        return activityValues(guildId, "guildChatMessages", windowDays);
      case "xp":
        return xpValues(guildId);
    }
  },

  async viewerKey(guildId, discordId, category): Promise<string | null> {
    if (!isSnapshotCategory(category)) return discordId;
    // The Hypixel-side boards are keyed by uuid, so an unlinked caller has no
    // key at all — which is the honest answer to "where am I" for a board they
    // are not on.
    const link = await prisma.linkedAccount.findFirst({
      where: {
        status: "VERIFIED",
        discordUser: { discordId, ...activeMemberOfGuild(guildId) },
      },
      orderBy: [{ isPrimary: "desc" }, { verifiedAt: "desc" }],
      select: { minecraftAccount: { select: { uuid: true } } },
    });
    return link?.minecraftAccount.uuid ?? null;
  },
};
