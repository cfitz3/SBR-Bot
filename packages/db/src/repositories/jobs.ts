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
  EventParticipant,
  EventRow,
  EventScoreWrite,
  MilestoneCandidate,
  RosterMemberLike,
  SnapshotMetrics,
  SnapshotWrite,
  StoredRosterRow,
  TrackableEvent,
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

  /** LIVE events that score at least one metric. The tracker's work list. */
  async listLiveTracked(): Promise<readonly TrackableEvent[]> {
    const rows = await prisma.event.findMany({
      where: { status: "LIVE", NOT: { trackedMetrics: { isEmpty: true } } },
      select: { id: true, guildId: true, trackedMetrics: true, pollIntervalMinutes: true },
    });
    return rows;
  },

  /**
   * Participants of one event, resolved to the account behind the RSVP.
   *
   * GOING only, and verified links only. A member who said "maybe" has not
   * entered the competition, and an unlinked one has no profile to measure —
   * both are absent here rather than present with nothing in them.
   */
  async listParticipants(eventId: string): Promise<readonly EventParticipant[]> {
    const rsvps = await prisma.eventRSVP.findMany({
      where: { eventId, state: "GOING" },
      select: { discordId: true },
    });
    if (rsvps.length === 0) return [];

    const links = await prisma.linkedAccount.findMany({
      where: {
        status: "VERIFIED",
        discordUser: { discordId: { in: rsvps.map((r) => r.discordId) } },
      },
      select: {
        discordUser: { select: { discordId: true } },
        minecraftAccount: {
          select: {
            id: true,
            uuid: true,
            selectedProfiles: { where: { isActive: true }, select: { profileId: true }, take: 1 },
            snapshots: {
              where: { eventId },
              orderBy: { capturedAt: "desc" },
              select: { capturedAt: true },
              take: 1,
            },
          },
        },
      },
    });

    return links.map((link) => ({
      discordId: link.discordUser.discordId,
      minecraftAccountId: link.minecraftAccount.id,
      uuid: link.minecraftAccount.uuid,
      profileId: link.minecraftAccount.selectedProfiles[0]?.profileId ?? null,
      // Scoped to this event: the bulk cadence's captures are hours apart and
      // would make every participant look freshly polled, stalling the board.
      lastCapturedAt: link.minecraftAccount.snapshots[0]?.capturedAt.toISOString() ?? null,
    }));
  },

  /**
   * Record one reading.
   *
   * The baseline is written by the create branch and never by the update: the
   * first poll after an event goes LIVE decides where a member started, and
   * anything that moved it afterwards would erase everyone's progress. `delta`
   * is stored so the board can order in the database.
   */
  async upsertScore(write: EventScoreWrite): Promise<void> {
    const existing = await prisma.eventScore.findUnique({
      where: { eventId_uuid_metric: { eventId: write.eventId, uuid: write.uuid, metric: write.metric } },
      select: { baseline: true },
    });
    if (existing === null) {
      await prisma.eventScore.create({
        data: {
          eventId: write.eventId,
          discordId: write.discordId,
          uuid: write.uuid,
          metric: write.metric,
          baseline: write.value,
          current: write.value,
          delta: 0,
        },
      });
      return;
    }
    await prisma.eventScore.update({
      where: { eventId_uuid_metric: { eventId: write.eventId, uuid: write.uuid, metric: write.metric } },
      data: { discordId: write.discordId, current: write.value, delta: write.value - existing.baseline },
    });
  },
};

// ──────────────────────────── progression ────────────────────────────

/** One account to detect over, resolved to the guild and member it concerns. */
export interface DetectionTarget {
  readonly minecraftAccountId: string;
  readonly guildId: string | null;
  readonly discordId: string | null;
}

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
      skyblockLevel: snapshot.skyblockLevel,
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
        skyblockLevel: true,
        networth: true,
        skillAverage: true,
        catacombsLevel: true,
        slayerXp: true,
        senitherWeight: true,
      },
    });
    return rows.map((r) => ({
      skyblockLevel: r.skyblockLevel,
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
          // A definition the guild marked quiet is born already announced:
          // there is nothing left to say about it, and the announcer's queue is
          // exactly "rows still owed a message". Encoding the intent here keeps
          // the sweep a single indexed read instead of a join that re-decides
          // visibility every pass.
          announced: !candidate.announce,
        },
      });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
      throw error;
    }
  },

  /**
   * Accounts to run detection over, each with the guild whose definitions
   * apply and the member to credit.
   *
   * Both may be null: an account can have snapshots without a verified link
   * (the roster scan captures everyone in the Hypixel guild, linked or not).
   * Those still get milestones — the crossing happened — they are just measured
   * against the built-in defaults, announced without a mention, and paid
   * nothing, because there is no member to pay.
   *
   * One guild per account, not all of them. The unique constraint on a
   * milestone is `(account, type, metric, threshold)` with no guild in it, so a
   * crossing is recorded once no matter how many guilds the member is in;
   * picking their oldest active membership makes which guild's definitions
   * apply deterministic rather than a race between two workers.
   */
  async listAccountsForDetection(limit: number): Promise<readonly DetectionTarget[]> {
    const accountIds = await snapshotJobRepository.listAccountsWithHistory(limit);
    if (accountIds.length === 0) return [];

    const links = await prisma.linkedAccount.findMany({
      where: { minecraftAccountId: { in: [...accountIds] }, status: "VERIFIED" },
      // Primary link first, then the oldest verification — so an account with
      // two verified links resolves the same way on every run.
      orderBy: [{ isPrimary: "desc" }, { verifiedAt: "asc" }],
      select: {
        minecraftAccountId: true,
        discordUser: {
          select: {
            discordId: true,
            memberships: {
              where: { status: "ACTIVE" },
              orderBy: { joinedAt: "asc" },
              take: 1,
              select: { guildId: true },
            },
          },
        },
      },
    });

    const context = new Map<string, { guildId: string | null; discordId: string | null }>();
    for (const link of links) {
      if (context.has(link.minecraftAccountId)) continue;
      context.set(link.minecraftAccountId, {
        guildId: link.discordUser.memberships[0]?.guildId ?? null,
        discordId: link.discordUser.discordId,
      });
    }

    return accountIds.map((minecraftAccountId) => ({
      minecraftAccountId,
      guildId: context.get(minecraftAccountId)?.guildId ?? null,
      discordId: context.get(minecraftAccountId)?.discordId ?? null,
    }));
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
