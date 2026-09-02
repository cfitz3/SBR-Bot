/**
 * The half of `/serverinfo` that Discord cannot answer.
 *
 * Discord reports how many accounts sit in a server. It does not know which of
 * them this platform tracks, which have linked a Minecraft account, or which
 * have said anything this week — those are our own counters, kept per member
 * per day in `ActivityDaily` by the same writers the leaderboards read.
 *
 * Read-only, one guild at a time, and deliberately not routed through
 * `leaderboardSource`: a board ranks members and this counts a server, and
 * borrowing the board would mean rendering a card out of a thousand rows to
 * print two totals and a name.
 */
import type { ServerActivityDTO, ServerActivitySource, ServerTopMemberDTO } from "@sbr/shared-types";
import { prisma } from "../client.js";

/** The window the card names. A week is what "this week" means. */
const WINDOW_DAYS = 7;

/** Midnight UTC, `days` ago — `ActivityDaily.day` is a date, not an instant. */
function since(days: number): Date {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  cutoff.setUTCHours(0, 0, 0, 0);
  return cutoff;
}

/**
 * The busiest member of the window, by everything they said.
 *
 * Both counters summed rather than ranked separately: a member who carries
 * guild chat and a member who carries the Discord side are both the reason the
 * week was busy, and a card with room for one name should not have to pick
 * which kind of talking counts.
 */
function busiest(
  rows: readonly { discordId: string; discord: number; guildChat: number }[],
): { discordId: string; discord: number; guildChat: number } | null {
  let best: { discordId: string; discord: number; guildChat: number } | null = null;
  for (const row of rows) {
    const total = row.discord + row.guildChat;
    if (total <= 0) continue;
    if (best === null || total > best.discord + best.guildChat) best = row;
  }
  return best;
}

export const serverActivityRepository: ServerActivitySource = {
  async serverWeek(guildId: string): Promise<ServerActivityDTO | null> {
    const cutoff = since(WINDOW_DAYS);

    const [daily, trackedMembers, linkedMembers] = await Promise.all([
      prisma.activityDaily.groupBy({
        by: ["discordId"],
        where: { guildId, day: { gte: cutoff } },
        _sum: { discordMessages: true, guildChatMessages: true },
      }),
      prisma.guildMember.count({ where: { guildId, status: "ACTIVE" } }),
      prisma.linkedAccount.count({
        where: {
          status: "VERIFIED",
          discordUser: { memberships: { some: { guildId, status: "ACTIVE" } } },
        },
      }),
    ]);

    const rows = daily.map((row) => ({
      discordId: row.discordId,
      discord: row._sum.discordMessages ?? 0,
      guildChat: row._sum.guildChatMessages ?? 0,
    }));

    const top = busiest(rows);
    // Only the one name is resolved. Fetching every talker's IGN to print one
    // of them is the kind of query that looks free until a guild has a busy
    // week.
    const ign = top === null ? null : await primaryIgn(guildId, top.discordId);

    return {
      trackedMembers,
      linkedMembers,
      // Someone who was counted is someone who said something: rows only exist
      // for days a member was active, and a zero row cannot be written.
      activeMembers: rows.filter((row) => row.discord + row.guildChat > 0).length,
      discordMessages: rows.reduce((sum, row) => sum + row.discord, 0),
      guildChatMessages: rows.reduce((sum, row) => sum + row.guildChat, 0),
      top:
        top === null
          ? null
          : ({
              discordId: top.discordId,
              ign,
              discordMessages: top.discord,
              guildChatMessages: top.guildChat,
            } satisfies ServerTopMemberDTO),
      windowDays: WINDOW_DAYS,
    };
  },
};

/** Primary-first, newest-verified-second — the precedence every other name uses. */
async function primaryIgn(guildId: string, discordId: string): Promise<string | null> {
  const link = await prisma.linkedAccount.findFirst({
    where: {
      status: "VERIFIED",
      discordUser: { discordId, memberships: { some: { guildId, status: "ACTIVE" } } },
    },
    orderBy: [{ isPrimary: "desc" }, { verifiedAt: "desc" }],
    select: { minecraftAccount: { select: { currentIgn: true } } },
  });
  return link?.minecraftAccount.currentIgn ?? null;
}
