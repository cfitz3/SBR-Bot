/**
 * Prisma-backed data access for the worker jobs.
 *
 * The jobs themselves are pure logic behind injected ports (`@sbr/jobs`); this
 * module is the other half — the concrete reads and writes those ports describe.
 * Keeping it here rather than in `@sbr/jobs` is what lets the job logic be tested
 * without a database.
 */
import type {
  ActivityRow,
  EventRow,
  MilestoneCandidate,
  RosterMemberLike,
  SnapshotMetrics,
  SnapshotWrite,
  StoredRosterRow,
} from "@sbr/jobs";
import { Prisma } from "@prisma/client";
import { prisma } from "../client.js";

function toNumber(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

/** Coins exceed the float range long before they exceed BigInt's. */
function toBigInt(value: number | null): bigint | null {
  return value === null ? null : BigInt(Math.round(value));
}

// ────────────────────────────── events ──────────────────────────────

export const eventJobRepository = {
  /** SCHEDULED and LIVE events across every guild — the sweep's whole input. */
  async listOpenEvents(): Promise<readonly EventRow[]> {
    const rows = await prisma.event.findMany({
      where: { status: { in: ["SCHEDULED", "LIVE"] } },
      select: {
        id: true,
        guildId: true,
        title: true,
        status: true,
        startsAt: true,
        endsAt: true,
        reminderState: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      guildId: r.guildId,
      title: r.title,
      status: r.status as EventRow["status"],
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt?.toISOString() ?? null,
      reminderState: (r.reminderState ?? {}) as Readonly<Record<string, unknown>>,
    }));
  },

  async setStatus(eventId: string, status: EventRow["status"]): Promise<void> {
    await prisma.event.update({ where: { id: eventId }, data: { status } });
  },

  /** GOING and MAYBE both get reminded; a MAYBE is exactly who a nudge is for. */
  async listAttendees(eventId: string): Promise<readonly string[]> {
    const rows = await prisma.eventRSVP.findMany({
      where: { eventId, state: { in: ["GOING", "MAYBE"] } },
      select: { discordId: true },
    });
    return rows.map((r) => r.discordId);
  },

  /**
   * Record that an offset was sent. Read-modify-write on the JSON column rather
   * than a merge, because Prisma has no partial-JSON update — the row is only
   * touched by this single-locked job, so the race it would otherwise invite
   * cannot happen.
   */
  async markReminderSent(eventId: string, offsetMinutes: number): Promise<void> {
    const row = await prisma.event.findUnique({ where: { id: eventId }, select: { reminderState: true } });
    const state = { ...((row?.reminderState ?? {}) as Record<string, unknown>) };
    state[String(offsetMinutes)] = new Date().toISOString();
    await prisma.event.update({
      where: { id: eventId },
      data: { reminderState: state as Prisma.InputJsonValue },
    });
  },

  /** Accounts in the progression cohort of a currently-live tracked event. */
  async listEventTrackedAccounts(): Promise<readonly { eventId: string; minecraftAccountId: string; uuid: string }[]> {
    const events = await prisma.event.findMany({
      where: { status: "LIVE", tracksProgression: true },
      select: { id: true, rsvps: { where: { state: "GOING" }, select: { discordId: true } } },
    });

    const cohort: { eventId: string; minecraftAccountId: string; uuid: string }[] = [];
    for (const event of events) {
      const discordIds = event.rsvps.map((r) => r.discordId);
      if (discordIds.length === 0) continue;
      const links = await prisma.linkedAccount.findMany({
        where: { status: "VERIFIED", discordUser: { discordId: { in: discordIds } } },
        select: { minecraftAccount: { select: { id: true, uuid: true } } },
      });
      for (const link of links) {
        cohort.push({
          eventId: event.id,
          minecraftAccountId: link.minecraftAccount.id,
          uuid: link.minecraftAccount.uuid,
        });
      }
    }
    return cohort;
  },
};

// ──────────────────────────── progression ────────────────────────────

export const snapshotJobRepository = {
  /**
   * Every verified account, with the timestamp of its newest snapshot.
   *
   * The snapshot job orders by that timestamp to spread the guild across runs,
   * so accounts never captured must sort first — they come back with null.
   */
  async listTracked(): Promise<
    readonly { minecraftAccountId: string; uuid: string; profileId: string | null; lastCapturedAt: string | null }[]
  > {
    const accounts = await prisma.minecraftAccount.findMany({
      where: { linkedAccounts: { some: { status: "VERIFIED" } } },
      select: {
        id: true,
        uuid: true,
        selectedProfiles: { where: { isActive: true }, select: { profileId: true }, take: 1 },
        snapshots: { orderBy: { capturedAt: "desc" }, select: { capturedAt: true }, take: 1 },
      },
    });
    return accounts.map((a) => ({
      minecraftAccountId: a.id,
      uuid: a.uuid,
      profileId: a.selectedProfiles[0]?.profileId ?? null,
      lastCapturedAt: a.snapshots[0]?.capturedAt.toISOString() ?? null,
    }));
  },

  /**
   * Upsert on the documented `(account, profile, day, seq)` key, so re-running a
   * day's capture corrects the row instead of duplicating it.
   */
  async write(snapshot: SnapshotWrite): Promise<void> {
    const key = {
      minecraftAccountId: snapshot.minecraftAccountId,
      profileId: snapshot.profileId,
      captureDate: new Date(`${snapshot.captureDate}T00:00:00.000Z`),
      seq: snapshot.seq,
    };
    const metrics = {
      capturedAt: new Date(snapshot.capturedAt),
      source: snapshot.source,
      eventId: snapshot.eventId,
      networth: toBigInt(snapshot.networth),
      skillAverage: snapshot.skillAverage,
      catacombsLevel: snapshot.catacombsLevel,
      slayerXp: toBigInt(snapshot.slayerXp),
      senitherWeight: snapshot.senitherWeight,
    };
    await prisma.profileSnapshot.upsert({
      where: { minecraftAccountId_profileId_captureDate_seq: key },
      create: { ...key, ...metrics },
      update: metrics,
    });
  },

  /** The two newest snapshots, newest first — exactly what detection compares. */
  async recentSnapshots(minecraftAccountId: string): Promise<readonly SnapshotMetrics[]> {
    const rows = await prisma.profileSnapshot.findMany({
      where: { minecraftAccountId },
      orderBy: { capturedAt: "desc" },
      take: 2,
      select: {
        networth: true,
        skillAverage: true,
        catacombsLevel: true,
        slayerXp: true,
        senitherWeight: true,
      },
    });
    return rows.map((r) => ({
      networth: toNumber(r.networth),
      skillAverage: r.skillAverage,
      catacombsLevel: r.catacombsLevel,
      slayerXp: toNumber(r.slayerXp),
      senitherWeight: r.senitherWeight,
    }));
  },

  /**
   * Insert a milestone, reporting whether it was new.
   *
   * The unique constraint is the real idempotency guard: two workers detecting
   * the same crossing race to insert and exactly one wins, so `false` here means
   * "already recorded", not "failed".
   */
  async record(
    candidate: MilestoneCandidate,
    guildId: string | null,
    discordId: string | null = null,
  ): Promise<boolean> {
    try {
      await prisma.milestone.create({
        data: {
          minecraftAccountId: candidate.minecraftAccountId,
          guildId,
          // Null for the built-in defaults: they are not rows, so there is
          // nothing to point at.
          definitionId: candidate.definitionId,
          discordId,
          type: candidate.type,
          metric: candidate.metric,
          thresholdValue: BigInt(Math.round(candidate.thresholdValue)),
        },
      });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
      throw error;
    }
  },

  /** Accounts with at least two snapshots — anything less has nothing to compare. */
  async listAccountsWithHistory(limit: number): Promise<readonly string[]> {
    const rows = await prisma.profileSnapshot.groupBy({
      by: ["minecraftAccountId"],
      _count: { _all: true },
      having: { minecraftAccountId: { _count: { gte: 2 } } },
      orderBy: { minecraftAccountId: "asc" },
      take: limit,
    });
    return rows.map((r) => r.minecraftAccountId);
  },
};

// ──────────────────────────── maintenance ────────────────────────────

export const maintenanceJobRepository = {
  /**
   * The roster as we hold it, keyed by Minecraft UUID.
   *
   * Only members with a verified link appear: an unlinked Hypixel member has no
   * row here to reconcile against, so roster sync is necessarily a statement
   * about linked members and the diff is read that way.
   */
  async listStoredRoster(guildId: string): Promise<readonly StoredRosterRow[]> {
    const members = await prisma.guildMember.findMany({
      where: { guildId },
      select: {
        status: true,
        guildRank: true,
        discordUser: {
          select: {
            linkedAccounts: {
              where: { status: "VERIFIED" },
              select: { minecraftAccount: { select: { id: true, uuid: true } } },
              take: 1,
            },
          },
        },
      },
    });

    const rows: StoredRosterRow[] = [];
    for (const member of members) {
      const account = member.discordUser.linkedAccounts[0]?.minecraftAccount;
      if (!account) continue;
      rows.push({
        minecraftAccountId: account.id,
        uuid: account.uuid,
        guildRank: member.guildRank,
        active: member.status === "ACTIVE",
      });
    }
    return rows;
  },

  /**
   * A rejoin reactivates the existing row rather than creating a second one.
   * Joins by players we have never linked are not recorded — there is no
   * DiscordUser to attach a GuildMember to, and inventing one would produce a
   * roster full of ghosts.
   */
  async applyJoined(guildId: string, members: readonly RosterMemberLike[]): Promise<void> {
    for (const member of members) {
      const uuid = member.uuid.replace(/-/g, "").toLowerCase();
      const link = await prisma.linkedAccount.findFirst({
        where: { status: "VERIFIED", minecraftAccount: { uuid } },
        select: { discordUserId: true },
      });
      if (!link) continue;
      await prisma.guildMember.updateMany({
        where: { guildId, discordUserId: link.discordUserId },
        data: {
          status: "ACTIVE",
          leftAt: null,
          ...(member.rank === null ? {} : { guildRank: member.rank }),
          ...(member.joinedAt === null ? {} : { joinedAt: new Date(member.joinedAt) }),
        },
      });
    }
  },

  async applyLeft(guildId: string, rows: readonly StoredRosterRow[]): Promise<void> {
    for (const row of rows) {
      const link = await prisma.linkedAccount.findFirst({
        where: { status: "VERIFIED", minecraftAccountId: row.minecraftAccountId },
        select: { discordUserId: true },
      });
      if (!link) continue;
      // Marked departed, never deleted: infractions and history stay attached
      // to the row, and a rejoin flips it back.
      await prisma.guildMember.updateMany({
        where: { guildId, discordUserId: link.discordUserId },
        data: { status: "LEFT", leftAt: new Date() },
      });
    }
  },

  async applyRankChanges(
    guildId: string,
    changes: readonly { readonly row: StoredRosterRow; readonly rank: string | null }[],
  ): Promise<void> {
    for (const change of changes) {
      const link = await prisma.linkedAccount.findFirst({
        where: { status: "VERIFIED", minecraftAccountId: change.row.minecraftAccountId },
        select: { discordUserId: true },
      });
      if (!link) continue;
      await prisma.guildMember.updateMany({
        where: { guildId, discordUserId: link.discordUserId },
        data: { guildRank: change.rank },
      });
    }
  },

  /** Activity for the inactivity scan. Officers and above are exempt. */
  async listActivity(guildId: string): Promise<readonly ActivityRow[]> {
    const members = await prisma.guildMember.findMany({
      where: { guildId, status: "ACTIVE" },
      select: {
        role: true,
        joinedAt: true,
        lastSeenAt: true,
        discordUser: {
          select: {
            linkedAccounts: {
              where: { status: "VERIFIED" },
              select: { minecraftAccount: { select: { id: true, uuid: true } } },
              take: 1,
            },
          },
        },
      },
    });

    const rows: ActivityRow[] = [];
    for (const member of members) {
      const account = member.discordUser.linkedAccounts[0]?.minecraftAccount;
      if (!account) continue;
      rows.push({
        minecraftAccountId: account.id,
        uuid: account.uuid,
        lastSeenAt: member.lastSeenAt?.getTime() ?? null,
        joinedAt: member.joinedAt?.getTime() ?? null,
        exempt: member.role === "OFFICER" || member.role === "ADMIN" || member.role === "OWNER",
      });
    }
    return rows;
  },

  /** Guilds whose config changed since a watermark — the invalidation input. */
  async listChangedGuilds(since: Date): Promise<readonly string[]> {
    const rows = await prisma.guildConfig.findMany({
      where: { updatedAt: { gt: since } },
      select: { guildId: true },
    });
    return rows.map((r) => r.guildId);
  },
};

// ───────────────────────────── analytics ─────────────────────────────

export interface AnalyticsEventRow {
  readonly guildId: string | null;
  readonly discordId: string | null;
  readonly surface: string;
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly ts: string;
}

export interface MetricRollupRow {
  readonly guildId: string | null;
  readonly metric: string;
  readonly period: "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";
  readonly bucketStart: string;
  readonly dims: Readonly<Record<string, string>>;
  readonly count: number;
}

export const analyticsJobRepository = {
  /** Bulk insert; duplicates from a replayed batch are tolerated by design. */
  async persistEvents(events: readonly AnalyticsEventRow[]): Promise<number> {
    if (events.length === 0) return 0;
    const result = await prisma.analyticsEvent.createMany({
      data: events.map((e) => ({
        guildId: e.guildId,
        discordId: e.discordId,
        surface: e.surface,
        type: e.type,
        props: e.props as Prisma.InputJsonValue,
        ts: new Date(e.ts),
      })),
    });
    return result.count;
  },

  /** Raw events in a window, for a rollup or a rebuild of one. */
  async listEvents(from: Date, to: Date): Promise<readonly AnalyticsEventRow[]> {
    const rows = await prisma.analyticsEvent.findMany({
      where: { ts: { gte: from, lt: to } },
      orderBy: { ts: "asc" },
    });
    return rows.map((r) => ({
      guildId: r.guildId,
      discordId: r.discordId,
      surface: r.surface,
      type: r.type,
      props: (r.props ?? {}) as Readonly<Record<string, unknown>>,
      ts: r.ts.toISOString(),
    }));
  },

  /**
   * Replace a rollup partition.
   *
   * Delete-then-insert inside one transaction, which is what makes the
   * documented rebuild safe: a recompute over corrected events fully supersedes
   * the previous answer instead of merging with it. There is no unique key to
   * upsert against, and adding one over a nullable `guildId` would not behave —
   * Postgres treats NULLs as distinct.
   */
  async replaceRollups(
    period: MetricRollupRow["period"],
    from: Date,
    to: Date,
    rows: readonly MetricRollupRow[],
  ): Promise<number> {
    return prisma.$transaction(async (tx) => {
      await tx.metricRollup.deleteMany({ where: { period, bucketStart: { gte: from, lt: to } } });
      if (rows.length === 0) return 0;
      const result = await tx.metricRollup.createMany({
        data: rows.map((r) => ({
          guildId: r.guildId,
          metric: r.metric,
          period: r.period,
          bucketStart: new Date(r.bucketStart),
          dims: r.dims as Prisma.InputJsonValue,
          count: r.count,
        })),
      });
      return result.count;
    });
  },
};
