/**
 * Panel read models (WEB_PANEL.md §3–§4).
 *
 * Every method here is read-only, deliberately. The panel "commands, it doesn't
 * bypass": writes go through the same domain services the bots use, so the only
 * thing the panel needs its own data access for is the summary and list reads
 * that no bot-facing service has a reason to expose.
 *
 * Analytics reads come from `MetricRollup` and never from `AnalyticsEvent` —
 * the raw fact table grows without bound and a chart must not scan it.
 */
import type { TicketDTO } from "@sbr/shared-types";
import { prisma } from "../client.js";
import { TICKET_SELECT, toTicketDTO } from "./tickets.js";

export interface GuildCardRow {
  readonly id: string;
  readonly name: string;
  readonly discordGuildId: string;
  readonly hypixelGuildId: string | null;
  readonly memberCount: number;
}

export interface OverviewCountsRow {
  readonly memberCount: number;
  readonly activeMemberCount: number;
  readonly linkedMemberCount: number;
  readonly verifiedMemberCount: number;
  readonly openTicketCount: number;
  readonly openInfractionCount: number;
  readonly activeActionCount: number;
  readonly upcomingEventCount: number;
  readonly recentJoinCount: number;
  readonly recentLeaveCount: number;
}

export interface MembershipStatsRow {
  readonly discordMemberCount: number;
  readonly guildMemberCount: number;
  readonly linkedCount: number;
  readonly discordJoins: number;
  readonly discordLeaves: number;
  readonly gameJoins: number;
  readonly gameLeaves: number;
  readonly windowDays: number;
  readonly scannedAt: { readonly discord: string | null; readonly hypixel: string | null };
}

export interface ActivityEntryRow {
  readonly kind: "MODERATION" | "SCREENING" | "MILESTONE" | "EVENT" | "ROSTER";
  readonly at: string;
  readonly title: string;
  readonly detail: string | null;
  readonly tone: "info" | "good" | "warn" | "bad";
}

export interface JoinAttemptRow {
  readonly id: string;
  readonly uuid: string;
  readonly ign: string;
  readonly discordId: string | null;
  readonly requestedAt: string;
  readonly verdict: string;
  readonly outcome: string;
  readonly riskScore: number;
  readonly reasons: readonly string[];
  /** Three-valued: listed / clear / could not find out. */
  readonly scammer: boolean | null;
  readonly scammerReason: string | null;
  readonly networth: number | null;
  readonly skillAverage: number | null;
  readonly catacombsLevel: number | null;
  readonly senitherWeight: number | null;
  readonly skyblockLevel: number | null;
}

export interface LinkedMemberRow {
  readonly discordId: string;
  readonly username: string | null;
  readonly role: string;
  readonly status: string;
  readonly guildRank: string | null;
  readonly lastSeenAt: string | null;
  readonly ign: string | null;
  readonly uuid: string | null;
  /** VERIFIED / PENDING / UNLINKED — the filter the recruitment page offers. */
  readonly verification: "VERIFIED" | "PENDING" | "UNLINKED";
}

export interface RollupPoint {
  readonly metric: string;
  readonly bucketStart: string;
  readonly count: number;
  readonly dims: unknown;
}

export interface CommandUsageRow {
  readonly command: string;
  readonly count: number;
  readonly successCount: number;
  readonly avgLatencyMs: number | null;
}

export interface MessageTotalsRow {
  readonly discordMessages: number;
  readonly guildChatMessages: number;
  readonly commandsUsed: number;
  readonly activeMembers: number;
  readonly days: number;
}

export interface ActiveMemberRow {
  readonly discordId: string | null;
  readonly username: string | null;
  readonly uuid: string | null;
  readonly ign: string | null;
  readonly discordMessages: number;
  readonly guildChatMessages: number;
  readonly commandsUsed: number;
  readonly presenceSamples: number;
  readonly gexp: number | null;
  readonly activeDays: number | null;
}

export interface DailyPointRow {
  readonly day: string;
  readonly value: number;
}

export interface EventRow {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly type: string;
  readonly status: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly capacity: number | null;
  readonly hostDiscordId: string | null;
  readonly going: number;
  readonly maybe: number;
  readonly declined: number;
  readonly trackedMetrics: readonly string[];
  readonly pollIntervalMinutes: number;
  readonly tracksProgression: boolean;
  readonly channelId: string | null;
  readonly messageId: string | null;
  readonly boardUpdatedAt: string | null;
}

/** One member's gain on one metric. Structurally `EventStandingRow` in the panel. */
export interface EventStandingRow {
  readonly discordId: string;
  readonly uuid: string;
  readonly metric: string;
  readonly delta: number;
}

export interface JobHealthRow {
  readonly type: string;
  readonly lastRunAt: string | null;
  readonly lastStatus: string | null;
  readonly durationMs: number | null;
  readonly error: string | null;
  readonly failuresLastDay: number;
}

/**
 * One person in the directory, from either side or both. `discordId` and `uuid`
 * are independently nullable — at least one is set, and which ones are is
 * exactly the information the page exists to show.
 */
export interface DirectoryMemberRowOut {
  readonly discordId: string | null;
  readonly username: string | null;
  readonly nickname: string | null;
  readonly uuid: string | null;
  readonly ign: string | null;
  readonly guildRank: string | null;
  readonly linked: boolean;
  readonly role: string | null;
  readonly status: string | null;
  readonly weeklyGexp: number | null;
  readonly lastSeenAt: string | null;
}

export type DirectorySideIn = "all" | "discord" | "game" | "unlinked";

export interface DirectoryQueryInput {
  readonly q: string;
  readonly side: DirectorySideIn;
  readonly limit: number;
}

export interface DirectoryPageRow {
  readonly rows: readonly DirectoryMemberRowOut[];
  readonly discordCount: number;
  readonly guildCount: number;
  readonly linkedCount: number;
  readonly truncated: boolean;
}

/**
 * "Discord only" and "in-game only" mean *not present on the other side*, not
 * *has a row on this side* — otherwise a linked member would appear under both
 * filters and neither tab would answer the question it is named after.
 */
function sideMatches(row: DirectoryMemberRowOut, side: DirectorySideIn): boolean {
  switch (side) {
    case "discord":
      return row.discordId !== null && !row.linked;
    case "game":
      return row.uuid !== null && row.discordId === null;
    case "unlinked":
      return !row.linked;
    default:
      return true;
  }
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/**
 * `ActivityDaily.day` and `GuildGexpDaily.day` are `@db.Date`, so a cutoff with
 * a time component would silently exclude the whole first day of the window.
 * Every daily-counter read floors through here.
 */
function dayFloor(since: Date): Date {
  const d = new Date(since);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Whole days the window covers, at least one — the divisor for per-day copy. */
function windowDays(since: Date): number {
  return Math.max(1, Math.round((Date.now() - dayFloor(since).getTime()) / 86_400_000));
}

export const panelRepository = {
  // ─────────────────────────── selector ───────────────────────────

  /**
   * Cards for the guild selector. Takes the manageable set from the session
   * rather than re-deriving it, because Discord authority was already resolved
   * at login and this query has no way to check it.
   */
  async listGuildCards(guildIds: readonly string[]): Promise<readonly GuildCardRow[]> {
    if (guildIds.length === 0) return [];
    const guilds = await prisma.guild.findMany({
      where: { id: { in: [...guildIds] } },
      select: {
        id: true,
        name: true,
        discordGuildId: true,
        hypixelGuildId: true,
        _count: { select: { members: true } },
      },
      orderBy: { name: "asc" },
    });
    return guilds.map((g) => ({
      id: g.id,
      name: g.name,
      discordGuildId: g.discordGuildId,
      hypixelGuildId: g.hypixelGuildId,
      memberCount: g._count.members,
    }));
  },

  // ─────────────────────────── overview ───────────────────────────

  async overviewCounts(guildId: string, recentWindowDays = 7): Promise<OverviewCountsRow> {
    const since = new Date(Date.now() - recentWindowDays * 86_400_000);
    const now = new Date();

    const [
      memberCount,
      activeMemberCount,
      linkedMemberCount,
      verifiedMemberCount,
      openTicketCount,
      openInfractionCount,
      activeActionCount,
      upcomingEventCount,
      recentJoinCount,
      recentLeaveCount,
    ] = await Promise.all([
      prisma.guildMember.count({ where: { guildId } }),
      prisma.guildMember.count({ where: { guildId, status: "ACTIVE" } }),
      prisma.guildMember.count({
        where: { guildId, discordUser: { linkedAccounts: { some: {} } } },
      }),
      prisma.guildMember.count({
        where: { guildId, discordUser: { linkedAccounts: { some: { status: "VERIFIED" } } } },
      }),
      prisma.ticket.count({ where: { guildId, status: { in: ["OPEN", "PENDING"] } } }),
      prisma.infraction.count({ where: { guildId, status: "OPEN" } }),
      prisma.moderationAction.count({ where: { guildId, active: true } }),
      prisma.event.count({ where: { guildId, status: { in: ["SCHEDULED", "LIVE"] }, startsAt: { gte: now } } }),
      prisma.guildMember.count({ where: { guildId, joinedAt: { gte: since } } }),
      prisma.guildMember.count({ where: { guildId, leftAt: { gte: since } } }),
    ]);

    return {
      memberCount,
      activeMemberCount,
      linkedMemberCount,
      verifiedMemberCount,
      openTicketCount,
      openInfractionCount,
      activeActionCount,
      upcomingEventCount,
      recentJoinCount,
      recentLeaveCount,
    };
  },

  /** Newest snapshot capture across the guild's linked accounts. */
  async lastSnapshotAt(guildId: string): Promise<string | null> {
    const row = await prisma.profileSnapshot.findFirst({
      where: {
        minecraftAccount: {
          linkedAccounts: { some: { discordUser: { memberships: { some: { guildId } } } } },
        },
      },
      orderBy: { capturedAt: "desc" },
      select: { capturedAt: true },
    });
    return iso(row?.capturedAt);
  },

  // ─────────────────────────── members ───────────────────────────

  async listLinkedMembers(guildId: string, limit = 200): Promise<readonly LinkedMemberRow[]> {
    const members = await prisma.guildMember.findMany({
      where: { guildId },
      take: limit,
      orderBy: [{ role: "desc" }, { createdAt: "asc" }],
      select: {
        role: true,
        status: true,
        guildRank: true,
        lastSeenAt: true,
        discordUser: {
          select: {
            discordId: true,
            username: true,
            linkedAccounts: {
              // Primary first so a multi-account member shows the account they play.
              orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
              take: 1,
              select: {
                status: true,
                minecraftAccount: { select: { uuid: true, currentIgn: true } },
              },
            },
          },
        },
      },
    });

    return members.map((m) => {
      const link = m.discordUser.linkedAccounts[0];
      // No link at all is UNLINKED; a link that exists but hasn't passed the
      // Hypixel social check is PENDING, which is a different staff action.
      const verification =
        link === undefined ? "UNLINKED" : link.status === "VERIFIED" ? "VERIFIED" : "PENDING";
      return {
        discordId: m.discordUser.discordId,
        username: m.discordUser.username,
        role: m.role,
        status: m.status,
        guildRank: m.guildRank,
        lastSeenAt: iso(m.lastSeenAt),
        ign: link?.minecraftAccount.currentIgn ?? null,
        uuid: link?.minecraftAccount.uuid ?? null,
        verification,
      };
    });
  },

  /**
   * The unified member directory: everyone Discord knows, everyone the in-game
   * guild knows, and the links between them.
   *
   * Merged in JS rather than SQL because this is a full outer join across two
   * tables with no shared key — they meet only through `LinkedAccount`, and the
   * rows that matter most are precisely the ones where that join fails. Both
   * sides are guild-sized (hundreds, occasionally a few thousand), which is why
   * loading them whole is cheaper than the query that would avoid it.
   *
   * `q` is matched here rather than in the database for the same reason: it has
   * to search across both sides of a row that does not exist until this function
   * builds it.
   */
  async listDirectory(guildId: string, query: DirectoryQueryInput): Promise<DirectoryPageRow> {
    const [discordSide, gameSide] = await Promise.all([
      prisma.guildMember.findMany({
        where: { guildId },
        orderBy: [{ role: "desc" }, { createdAt: "asc" }],
        select: {
          role: true,
          status: true,
          guildRank: true,
          nickname: true,
          lastSeenAt: true,
          discordUser: {
            select: {
              discordId: true,
              username: true,
              linkedAccounts: {
                orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
                take: 1,
                select: { status: true, minecraftAccount: { select: { uuid: true, currentIgn: true } } },
              },
            },
          },
        },
      }),
      prisma.guildMemberCache.findMany({
        where: { guildId },
        orderBy: { weeklyGexp: "desc" },
        select: { uuid: true, ign: true, guildRank: true, weeklyGexp: true },
      }),
    ]);

    const byUuid = new Map(gameSide.map((row) => [row.uuid, row]));
    const claimed = new Set<string>();
    const rows: DirectoryMemberRowOut[] = [];

    for (const member of discordSide) {
      const link = member.discordUser.linkedAccounts[0];
      // Only a VERIFIED link counts as linked. An unverified one is a link
      // attempt, and treating it as a match would put someone else's stats on
      // this row.
      const uuid = link?.status === "VERIFIED" ? link.minecraftAccount.uuid : null;
      const game = uuid === null ? undefined : byUuid.get(uuid);
      if (uuid !== null) claimed.add(uuid);
      rows.push({
        discordId: member.discordUser.discordId,
        username: member.discordUser.username,
        nickname: member.nickname,
        uuid,
        ign: game?.ign ?? link?.minecraftAccount.currentIgn ?? null,
        // The in-game rank is the live one; the stored copy is a fallback for a
        // member the last scan missed.
        guildRank: game?.guildRank ?? member.guildRank,
        linked: uuid !== null,
        role: member.role,
        status: member.status,
        weeklyGexp: game?.weeklyGexp ?? null,
        lastSeenAt: iso(member.lastSeenAt),
      });
    }

    // Whoever the in-game guild knows and no Discord membership claimed. These
    // are the rows the old read could not represent at all.
    for (const game of gameSide) {
      if (claimed.has(game.uuid)) continue;
      rows.push({
        discordId: null,
        username: null,
        nickname: null,
        uuid: game.uuid,
        ign: game.ign,
        guildRank: game.guildRank,
        linked: false,
        role: null,
        status: null,
        weeklyGexp: game.weeklyGexp,
        lastSeenAt: null,
      });
    }

    const needle = query.q.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (!sideMatches(row, query.side)) return false;
      if (needle.length === 0) return true;
      return [row.username, row.nickname, row.ign, row.discordId, row.uuid, row.guildRank].some(
        (field) => (field ?? "").toLowerCase().includes(needle),
      );
    });

    return {
      rows: filtered.slice(0, query.limit),
      discordCount: discordSide.filter((m) => m.status === "ACTIVE").length,
      guildCount: gameSide.length,
      linkedCount: rows.filter((row) => row.linked).length,
      truncated: filtered.length > query.limit,
    };
  },

  /**
   * The two scan clocks. Shown rather than hidden: a roster is only as true as
   * its last scan, and a page that displays stale numbers without saying so is
   * the one that gets acted on.
   */
  async directoryScannedAt(guildId: string): Promise<{ discord: string | null; hypixel: string | null }> {
    const [discord, hypixel] = await Promise.all([
      prisma.guildMember.findFirst({
        where: { guildId },
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true },
      }),
      prisma.guildMemberCache.findFirst({
        where: { guildId },
        orderBy: { refreshedAt: "desc" },
        select: { refreshedAt: true },
      }),
    ]);
    return { discord: iso(discord?.updatedAt), hypixel: iso(hypixel?.refreshedAt) };
  },

  /**
   * Both rosters and their movement, as two populations rather than one.
   *
   * The in-game side's joins and leaves are summed off `GuildScan`'s per-scan
   * uuid deltas, not derived from the cache: the cache is a mirror of *now* and
   * has no memory of somebody who joined and left inside the window. The Discord
   * side reads its own timestamps, which do.
   */
  async membershipStats(guildId: string, windowDays = 7): Promise<MembershipStatsRow> {
    const since = new Date(Date.now() - windowDays * 86_400_000);

    const [discordMemberCount, guildMemberCount, linkedCount, discordJoins, discordLeaves, scans, clocks] =
      await Promise.all([
        prisma.guildMember.count({ where: { guildId, status: "ACTIVE" } }),
        prisma.guildMemberCache.count({ where: { guildId } }),
        prisma.guildMember.count({
          where: { guildId, discordUser: { linkedAccounts: { some: { status: "VERIFIED" } } } },
        }),
        prisma.guildMember.count({ where: { guildId, joinedAt: { gte: since } } }),
        prisma.guildMember.count({ where: { guildId, leftAt: { gte: since } } }),
        prisma.guildScan.findMany({
          where: { guildId, startedAt: { gte: since }, error: null },
          select: { joined: true, left: true },
          // Bounded: a 6-hourly scan gives ~28 rows a week, and a guild that
          // somehow ran many more should not turn this into a table scan.
          take: 200,
          orderBy: { startedAt: "desc" },
        }),
        panelRepository.directoryScannedAt(guildId),
      ]);

    let gameJoins = 0;
    let gameLeaves = 0;
    for (const scan of scans) {
      gameJoins += scan.joined.length;
      gameLeaves += scan.left.length;
    }

    return {
      discordMemberCount,
      guildMemberCount,
      linkedCount,
      discordJoins,
      discordLeaves,
      gameJoins,
      gameLeaves,
      windowDays,
      scannedAt: clocks,
    };
  },

  /**
   * The merged activity feed.
   *
   * Five bounded queries interleaved in JS rather than one union in SQL: the
   * sources have different shapes, different ownership and different indexes,
   * and a database-side union would need a common projection that every future
   * source has to be bent into. `take: limit` per source keeps the work bounded
   * whichever source happens to be busy — the same shape `listJobHealth` uses.
   */
  async listActivity(guildId: string, limit = 40): Promise<readonly ActivityEntryRow[]> {
    const [actions, screenings, milestones, events, scans] = await Promise.all([
      prisma.moderationAction.findMany({
        where: { guildId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          type: true, reason: true, targetDiscordId: true, actorDiscordId: true,
          sourceContext: true, createdAt: true,
        },
      }),
      prisma.guildJoinScreening.findMany({
        where: { guildId },
        orderBy: { requestedAt: "desc" },
        take: limit,
        select: { ign: true, verdict: true, outcome: true, riskScore: true, requestedAt: true },
      }),
      prisma.milestone.findMany({
        where: { guildId },
        orderBy: { achievedAt: "desc" },
        take: limit,
        select: {
          metric: true, type: true, thresholdValue: true, achievedAt: true,
          minecraftAccount: { select: { currentIgn: true } },
        },
      }),
      prisma.event.findMany({
        where: { guildId },
        orderBy: { updatedAt: "desc" },
        take: limit,
        select: { title: true, status: true, type: true, updatedAt: true },
      }),
      prisma.guildScan.findMany({
        where: { guildId, OR: [{ joined: { isEmpty: false } }, { left: { isEmpty: false } }, { error: { not: null } }] },
        orderBy: { startedAt: "desc" },
        take: limit,
        select: { joined: true, left: true, error: true, memberCount: true, startedAt: true },
      }),
    ]);

    const entries: ActivityEntryRow[] = [];

    for (const a of actions) {
      entries.push({
        kind: "MODERATION",
        at: a.createdAt.toISOString(),
        title: `${a.type} — ${a.targetDiscordId ?? "unknown member"}`,
        // In-game rows are parsed from Hypixel's own notices and carry no actor
        // snowflake, so they are labelled rather than attributed to nobody.
        detail: a.sourceContext === "INGAME" ? `${a.reason} (seen in guild chat)` : `${a.reason} — by ${a.actorDiscordId}`,
        tone: a.type === "WARN" ? "warn" : "bad",
      });
    }

    for (const s of screenings) {
      entries.push({
        kind: "SCREENING",
        at: s.requestedAt.toISOString(),
        title: `${s.ign} asked to join`,
        detail: `${s.verdict.toLowerCase()} · ${s.outcome.toLowerCase()} · risk ${s.riskScore}`,
        tone: s.verdict === "ACCEPT" ? "good" : s.verdict === "DENY" ? "bad" : "warn",
      });
    }

    for (const m of milestones) {
      entries.push({
        kind: "MILESTONE",
        at: m.achievedAt.toISOString(),
        title: `${m.minecraftAccount.currentIgn ?? "A member"} reached ${m.metric}`,
        detail: `${m.type.toLowerCase().replace(/_/g, " ")} · ${m.thresholdValue.toString()}`,
        tone: "good",
      });
    }

    for (const e of events) {
      entries.push({
        kind: "EVENT",
        at: e.updatedAt.toISOString(),
        title: `${e.title} is ${e.status.toLowerCase()}`,
        detail: e.type.toLowerCase().replace(/_/g, " "),
        tone: e.status === "CANCELLED" ? "warn" : "info",
      });
    }

    for (const s of scans) {
      const parts: string[] = [];
      if (s.joined.length > 0) parts.push(`${s.joined.length} joined`);
      if (s.left.length > 0) parts.push(`${s.left.length} left`);
      entries.push({
        kind: "ROSTER",
        at: s.startedAt.toISOString(),
        title: s.error === null ? "Guild roster scanned" : "Guild roster scan failed",
        detail: s.error ?? `${parts.join(", ")} · ${s.memberCount} in guild`,
        tone: s.error === null ? "info" : "bad",
      });
    }

    entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return entries.slice(0, limit);
  },

  /**
   * Recent join attempts, stat block included.
   *
   * `networth` is a BigInt column; it is narrowed to a Number here because the
   * value travels as JSON and no networth reaches the 2^53 boundary — but the
   * narrowing is done once, here, rather than left for a caller to discover.
   */
  async listJoinAttempts(guildId: string, limit = 15): Promise<readonly JoinAttemptRow[]> {
    const rows = await prisma.guildJoinScreening.findMany({
      where: { guildId },
      orderBy: { requestedAt: "desc" },
      take: limit,
      select: {
        id: true, uuid: true, ign: true, discordId: true, requestedAt: true,
        verdict: true, outcome: true, riskScore: true, reasons: true,
        scammer: true, scammerReason: true,
        networth: true, skillAverage: true, catacombsLevel: true,
        senitherWeight: true, skyblockLevel: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      uuid: r.uuid,
      ign: r.ign,
      discordId: r.discordId,
      requestedAt: r.requestedAt.toISOString(),
      verdict: r.verdict,
      outcome: r.outcome,
      riskScore: r.riskScore,
      reasons: r.reasons,
      scammer: r.scammer,
      scammerReason: r.scammerReason,
      networth: r.networth === null ? null : Number(r.networth),
      skillAverage: r.skillAverage,
      catacombsLevel: r.catacombsLevel,
      senitherWeight: r.senitherWeight,
      skyblockLevel: r.skyblockLevel,
    }));
  },

  // ─────────────────────────── analytics ───────────────────────────

  async listRollups(input: {
    guildId: string;
    period: "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";
    since: Date;
    metrics?: readonly string[];
  }): Promise<readonly RollupPoint[]> {
    const rows = await prisma.metricRollup.findMany({
      where: {
        guildId: input.guildId,
        period: input.period,
        bucketStart: { gte: input.since },
        ...(input.metrics && input.metrics.length > 0 ? { metric: { in: [...input.metrics] } } : {}),
      },
      orderBy: [{ metric: "asc" }, { bucketStart: "asc" }],
      select: { metric: true, bucketStart: true, count: true, dims: true },
    });
    return rows.map((r) => ({
      metric: r.metric,
      bucketStart: r.bucketStart.toISOString(),
      count: r.count,
      dims: r.dims,
    }));
  },

  /**
   * Top commands over a window. This one does read `CommandUsage` rather than a
   * rollup, because the panel needs the per-command breakdown and success rate
   * that the rollups intentionally don't carry — bounded by `take` and by the
   * window, so it stays an index scan rather than a table scan.
   */
  async topCommands(guildId: string, since: Date, limit = 15): Promise<readonly CommandUsageRow[]> {
    const grouped = await prisma.commandUsage.groupBy({
      by: ["command"],
      where: { guildId, invokedAt: { gte: since } },
      _count: { _all: true },
      _avg: { latencyMs: true },
      orderBy: { _count: { command: "desc" } },
      take: limit,
    });

    const successes = await prisma.commandUsage.groupBy({
      by: ["command"],
      where: { guildId, invokedAt: { gte: since }, success: true },
      _count: { _all: true },
      orderBy: { command: "asc" },
    });
    const successBy = new Map(successes.map((s) => [s.command, s._count._all]));

    return grouped.map((g) => ({
      command: g.command,
      count: g._count._all,
      successCount: successBy.get(g.command) ?? 0,
      avgLatencyMs: g._avg.latencyMs === null ? null : Math.round(g._avg.latencyMs),
    }));
  },

  /**
   * Message volume over the window, as two numbers and a headcount.
   *
   * `activeMembers` is the number of people with a non-zero counter, not the
   * roster size: it answers "how many of them actually said something", which
   * is the only reading of "active" the counters can support.
   */
  async messageTotals(guildId: string, since: Date): Promise<MessageTotalsRow> {
    const rows = await prisma.activityDaily.groupBy({
      by: ["discordId"],
      where: { guildId, day: { gte: dayFloor(since) } },
      _sum: { discordMessages: true, guildChatMessages: true, commandsUsed: true },
    });

    let discordMessages = 0;
    let guildChatMessages = 0;
    let commandsUsed = 0;
    let activeMembers = 0;
    for (const row of rows) {
      const d = row._sum.discordMessages ?? 0;
      const g = row._sum.guildChatMessages ?? 0;
      const c = row._sum.commandsUsed ?? 0;
      discordMessages += d;
      guildChatMessages += g;
      commandsUsed += c;
      if (d + g + c > 0) activeMembers += 1;
    }

    return { discordMessages, guildChatMessages, commandsUsed, activeMembers, days: windowDays(since) };
  },

  /**
   * The most active members across both surfaces, merged into one table.
   *
   * Two independent populations feed this: people the Discord counters know
   * (keyed by snowflake) and people the GEXP series knows (keyed by uuid). A
   * verified link fuses a pair into one row; everyone else appears on their own
   * terms, which is what lets a member who only plays and a member who only
   * talks share a ranking. `gexp`/`activeDays` stay null for a row with no
   * uuid — that is "we cannot know", not "they earned none".
   */
  async topActiveMembers(guildId: string, since: Date, limit = 15): Promise<readonly ActiveMemberRow[]> {
    const floor = dayFloor(since);
    const [activity, gexpSum, gexpDays, links, cache] = await Promise.all([
      prisma.activityDaily.groupBy({
        by: ["discordId"],
        where: { guildId, day: { gte: floor } },
        _sum: {
          discordMessages: true,
          guildChatMessages: true,
          commandsUsed: true,
          presenceSamples: true,
        },
      }),
      prisma.guildGexpDaily.groupBy({
        by: ["uuid"],
        where: { guildId, day: { gte: floor } },
        _sum: { gexp: true },
      }),
      prisma.guildGexpDaily.groupBy({
        by: ["uuid"],
        where: { guildId, day: { gte: floor }, gexp: { gt: 0 } },
        _count: { _all: true },
      }),
      prisma.linkedAccount.findMany({
        where: { status: "VERIFIED", discordUser: { memberships: { some: { guildId } } } },
        orderBy: [{ isPrimary: "desc" }, { verifiedAt: "desc" }],
        select: {
          discordUser: { select: { discordId: true, username: true } },
          minecraftAccount: { select: { uuid: true, currentIgn: true } },
        },
      }),
      prisma.guildMemberCache.findMany({ where: { guildId }, select: { uuid: true, ign: true } }),
    ]);

    const uuidByDiscord = new Map<string, string>();
    const identity = new Map<string, { discordId: string | null; username: string | null; ign: string | null }>();
    for (const link of links) {
      const { discordId, username } = link.discordUser;
      if (uuidByDiscord.has(discordId)) continue;
      const uuid = link.minecraftAccount.uuid;
      uuidByDiscord.set(discordId, uuid);
      identity.set(uuid, { discordId, username, ign: link.minecraftAccount.currentIgn });
    }
    const ignByUuid = new Map(cache.map((row) => [row.uuid, row.ign]));
    const sumByUuid = new Map(gexpSum.map((row) => [row.uuid, row._sum.gexp ?? 0]));
    const daysByUuid = new Map(gexpDays.map((row) => [row.uuid, row._count._all]));

    const rows: ActiveMemberRow[] = [];
    const claimed = new Set<string>();

    for (const row of activity) {
      const uuid = uuidByDiscord.get(row.discordId) ?? null;
      if (uuid !== null) claimed.add(uuid);
      const who = uuid === null ? undefined : identity.get(uuid);
      rows.push({
        discordId: row.discordId,
        username: who?.username ?? null,
        uuid,
        ign: uuid === null ? null : (ignByUuid.get(uuid) ?? who?.ign ?? null),
        discordMessages: row._sum.discordMessages ?? 0,
        guildChatMessages: row._sum.guildChatMessages ?? 0,
        commandsUsed: row._sum.commandsUsed ?? 0,
        presenceSamples: row._sum.presenceSamples ?? 0,
        gexp: uuid === null ? null : (sumByUuid.get(uuid) ?? 0),
        activeDays: uuid === null ? null : (daysByUuid.get(uuid) ?? 0),
      });
    }

    // Everyone the GEXP series knows and no Discord row claimed: guild members
    // who never linked, or linked members with no counted messages at all.
    for (const [uuid, gexp] of sumByUuid) {
      if (claimed.has(uuid)) continue;
      const who = identity.get(uuid);
      rows.push({
        discordId: who?.discordId ?? null,
        username: who?.username ?? null,
        uuid,
        ign: ignByUuid.get(uuid) ?? who?.ign ?? null,
        discordMessages: 0,
        guildChatMessages: 0,
        commandsUsed: 0,
        presenceSamples: 0,
        gexp,
        activeDays: daysByUuid.get(uuid) ?? 0,
      });
    }

    // Messages and playing days are different units, so the rank is a blend by
    // design: a day of play is worth as much as ten messages. It orders the
    // table, it is not reported as a score.
    const rank = (r: ActiveMemberRow): number =>
      r.discordMessages + r.guildChatMessages + r.commandsUsed + (r.activeDays ?? 0) * 10;
    return rows.sort((a, b) => rank(b) - rank(a)).slice(0, limit);
  },

  async gexpSeries(guildId: string, days: number): Promise<readonly DailyPointRow[]> {
    const since = dayFloor(new Date(Date.now() - days * 86_400_000));
    const rows = await prisma.guildGexpDaily.groupBy({
      by: ["day"],
      where: { guildId, day: { gte: since } },
      _sum: { gexp: true },
      orderBy: { day: "asc" },
    });
    return rows.map((row) => ({ day: row.day.toISOString().slice(0, 10), value: row._sum.gexp ?? 0 }));
  },

  /**
   * One member's row. Returns null only when the guild has never counted
   * anything for them *and* they have no verified link — an existing member
   * with a quiet window is a row of zeroes, which is a different answer.
   */
  async memberActivity(guildId: string, discordId: string, since: Date): Promise<ActiveMemberRow | null> {
    const floor = dayFloor(since);
    const [totals, link] = await Promise.all([
      prisma.activityDaily.aggregate({
        where: { guildId, discordId, day: { gte: floor } },
        _sum: {
          discordMessages: true,
          guildChatMessages: true,
          commandsUsed: true,
          presenceSamples: true,
        },
        _count: { _all: true },
      }),
      prisma.linkedAccount.findFirst({
        where: { status: "VERIFIED", discordUser: { discordId } },
        orderBy: [{ isPrimary: "desc" }, { verifiedAt: "desc" }],
        select: {
          discordUser: { select: { username: true } },
          minecraftAccount: { select: { uuid: true, currentIgn: true } },
        },
      }),
    ]);

    if (totals._count._all === 0 && link === null) return null;

    const uuid = link?.minecraftAccount.uuid ?? null;
    const [gexp, activeDays] =
      uuid === null
        ? [null, null]
        : await Promise.all([
            prisma.guildGexpDaily
              .aggregate({ where: { guildId, uuid, day: { gte: floor } }, _sum: { gexp: true } })
              .then((r) => r._sum.gexp ?? 0),
            prisma.guildGexpDaily.count({ where: { guildId, uuid, day: { gte: floor }, gexp: { gt: 0 } } }),
          ]);

    return {
      discordId,
      username: link?.discordUser.username ?? null,
      uuid,
      ign: link?.minecraftAccount.currentIgn ?? null,
      discordMessages: totals._sum.discordMessages ?? 0,
      guildChatMessages: totals._sum.guildChatMessages ?? 0,
      commandsUsed: totals._sum.commandsUsed ?? 0,
      presenceSamples: totals._sum.presenceSamples ?? 0,
      gexp,
      activeDays,
    };
  },

  // ─────────────────────────── events ───────────────────────────

  async listEvents(guildId: string, limit = 50): Promise<readonly EventRow[]> {
    const events = await prisma.event.findMany({
      where: { guildId },
      take: limit,
      orderBy: { startsAt: "desc" },
      select: {
        id: true,
        title: true,
        description: true,
        type: true,
        status: true,
        startsAt: true,
        endsAt: true,
        capacity: true,
        hostDiscordId: true,
        trackedMetrics: true,
        pollIntervalMinutes: true,
        tracksProgression: true,
        channelId: true,
        messageId: true,
        boardUpdatedAt: true,
        rsvps: { select: { state: true } },
      },
    });

    return events.map((e) => {
      const tally = (state: string): number => e.rsvps.filter((r) => r.state === state).length;
      return {
        id: e.id,
        title: e.title,
        description: e.description,
        type: e.type,
        status: e.status,
        startsAt: e.startsAt.toISOString(),
        endsAt: iso(e.endsAt),
        capacity: e.capacity,
        hostDiscordId: e.hostDiscordId,
        trackedMetrics: e.trackedMetrics,
        pollIntervalMinutes: e.pollIntervalMinutes,
        tracksProgression: e.tracksProgression,
        channelId: e.channelId,
        messageId: e.messageId,
        boardUpdatedAt: iso(e.boardUpdatedAt),
        going: tally("GOING"),
        maybe: tally("MAYBE"),
        declined: tally("NOT_GOING"),
      };
    });
  },

  /**
   * One event's scores, ordered the way the board ranks them.
   *
   * The composite index is `(eventId, metric, delta)`, so metric-then-delta is
   * the order the database already holds and the page can slice per metric
   * without sorting anything itself.
   */
  async eventStandings(eventId: string, limit = 200): Promise<readonly EventStandingRow[]> {
    const rows = await prisma.eventScore.findMany({
      where: { eventId },
      take: limit,
      orderBy: [{ metric: "asc" }, { delta: "desc" }],
      select: { discordId: true, uuid: true, metric: true, delta: true },
    });
    return rows;
  },

  /**
   * The ticket queue, newest first, closed ones included.
   *
   * Delegated to `ticketRepository` for the row shape — the panel showing a
   * different set of fields from the bots is how the two ended up disagreeing
   * about ticket state in the first place.
   */
  async listTickets(guildId: string, limit = 100): Promise<readonly TicketDTO[]> {
    const rows = await prisma.ticket.findMany({
      where: { guildId },
      take: limit,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      select: TICKET_SELECT,
    });
    return rows.map(toTicketDTO);
  },

  // ─────────────────────────── health ───────────────────────────

  async pendingMilestones(guildId: string): Promise<number> {
    return prisma.milestone.count({ where: { guildId, announced: false } });
  },

  async listJobHealth(): Promise<readonly JobHealthRow[]> {
    const dayAgo = new Date(Date.now() - 86_400_000);

    const types = await prisma.workerJobLog.groupBy({
      by: ["type"],
      _max: { createdAt: true },
      orderBy: { type: "asc" },
    });

    const failures = await prisma.workerJobLog.groupBy({
      by: ["type"],
      where: { status: "FAILED", createdAt: { gte: dayAgo } },
      _count: { _all: true },
      orderBy: { type: "asc" },
    });
    const failureBy = new Map(failures.map((f) => [f.type, f._count._all]));

    return Promise.all(
      types.map(async (t) => {
        const last = await prisma.workerJobLog.findFirst({
          where: { type: t.type },
          orderBy: { createdAt: "desc" },
          select: { finishedAt: true, status: true, durationMs: true, error: true },
        });
        return {
          type: t.type,
          lastRunAt: iso(last?.finishedAt),
          lastStatus: last?.status ?? null,
          durationMs: last?.durationMs ?? null,
          error: last?.error ?? null,
          failuresLastDay: failureBy.get(t.type) ?? 0,
        };
      }),
    );
  },
};
