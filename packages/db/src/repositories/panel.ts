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
import { prisma } from "../client.js";

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

export interface EventRow {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly status: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly capacity: number | null;
  readonly hostDiscordId: string | null;
  readonly going: number;
  readonly maybe: number;
  readonly declined: number;
}

export interface TicketRow {
  readonly id: string;
  readonly openerDiscordId: string;
  readonly assigneeDiscordId: string | null;
  readonly category: string;
  readonly status: string;
  readonly subject: string | null;
  readonly createdAt: string;
}

export interface JobHealthRow {
  readonly type: string;
  readonly lastRunAt: string | null;
  readonly lastStatus: string | null;
  readonly durationMs: number | null;
  readonly error: string | null;
  readonly failuresLastDay: number;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

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

  // ─────────────────────────── events ───────────────────────────

  async listEvents(guildId: string, limit = 50): Promise<readonly EventRow[]> {
    const events = await prisma.event.findMany({
      where: { guildId },
      take: limit,
      orderBy: { startsAt: "desc" },
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        startsAt: true,
        endsAt: true,
        capacity: true,
        hostDiscordId: true,
        rsvps: { select: { state: true } },
      },
    });

    return events.map((e) => {
      const tally = (state: string): number => e.rsvps.filter((r) => r.state === state).length;
      return {
        id: e.id,
        title: e.title,
        type: e.type,
        status: e.status,
        startsAt: e.startsAt.toISOString(),
        endsAt: iso(e.endsAt),
        capacity: e.capacity,
        hostDiscordId: e.hostDiscordId,
        going: tally("GOING"),
        maybe: tally("MAYBE"),
        declined: tally("NOT_GOING"),
      };
    });
  },

  async listTickets(guildId: string, limit = 100): Promise<readonly TicketRow[]> {
    const rows = await prisma.ticket.findMany({
      where: { guildId },
      take: limit,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      select: {
        id: true,
        openerDiscordId: true,
        assigneeDiscordId: true,
        category: true,
        status: true,
        subject: true,
        createdAt: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      openerDiscordId: r.openerDiscordId,
      assigneeDiscordId: r.assigneeDiscordId,
      category: r.category,
      status: r.status,
      subject: r.subject,
      createdAt: r.createdAt.toISOString(),
    }));
  },

  // ─────────────────────────── health ───────────────────────────

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
