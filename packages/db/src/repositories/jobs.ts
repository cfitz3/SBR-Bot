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
  ProfileReading,
  SnapshotMetrics,
  SnapshotWrite,
  StoredRosterRow,
  TrackableEvent,
} from "@sbr/jobs";
import { Prisma } from "@prisma/client";
import { prisma } from "../client.js";
import { packAllMetrics, packJsonMetrics, unpackAllMetrics, unpackJsonMetrics } from "./snapshot-metrics.js";

function toNumber(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

/** Coins exceed the float range long before they exceed BigInt's. */
function toBigInt(value: number | null): bigint | null {
  return value === null ? null : BigInt(Math.round(value));
}

// ────────────────────────────── events ──────────────────────────────

/**
 * The board row shapes are declared here rather than imported, because both
 * things that consume them — the workers' board job and the bridge bot's board
 * gateway — describe their own port, and this module satisfies both
 * structurally. A drift shows up as a type error at the wiring site, which is
 * where it belongs.
 */
export interface BoardableEvent {
  readonly id: string;
  readonly guildId: string;
}

export interface EventBoardRow {
  readonly id: string;
  readonly guildId: string;
  readonly title: string;
  readonly status: "SCHEDULED" | "LIVE" | "COMPLETED" | "CANCELLED";
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly channelId: string | null;
  readonly messageId: string | null;
  readonly trackedMetrics: readonly string[];
  /** GOING RSVPs — who the event is actually about. */
  readonly participantCount: number;
  /** Free text, shown on the board. Informational: nothing pays it out. */
  readonly prize: string | null;
}

export interface EventStanding {
  readonly discordId: string;
  readonly uuid: string;
  readonly delta: number;
}


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
   *
   * Create first and catch the duplicate, rather than reading and then
   * branching: two overlapping poll passes — a slow one still finishing when
   * the next tick fires — would both read absent, both insert, and one would
   * take a P2002 out of the middle of the roster, costing everybody after it
   * their pass. Losing the insert race is not an error here; it means somebody
   * else wrote the same baseline, and the update below is what this pass owes
   * the row either way. The re-read is safe under the same race because the
   * baseline is immutable once written, so both writers compute one delta.
   */
  async upsertScore(write: EventScoreWrite): Promise<void> {
    const where = { eventId_uuid_metric: { eventId: write.eventId, uuid: write.uuid, metric: write.metric } };
    try {
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
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    }

    const existing = await prisma.eventScore.findUnique({
      where,
      select: { baseline: true, current: true, discordId: true },
    });
    // Gone between the failed insert and this read: the event was deleted out
    // from under the poll. Nothing to record.
    if (existing === null) return;
    // A reading identical to the stored one is not a write. `updatedAt` is
    // `@updatedAt`, so writing it anyway would stamp the row on every pass and
    // make "have this event's standings moved since the board was drawn?"
    // permanently true -- which is the question the board sweep now asks before
    // spending a Discord edit.
    if (existing.current === write.value && existing.discordId === write.discordId) return;
    await prisma.eventScore.update({
      where,
      data: { discordId: write.discordId, current: write.value, delta: write.value - existing.baseline },
    });
  },

  // ── the tracker board ──────────────────────────────────────────────────────

  /**
   * Events whose board is due a pass: a live one that has not been edited
   * within its refresh window, and a finished one whose card has not yet been
   * written. `boardFinal` is what separates the second case from an endless
   * rewrite of the same result card.
   *
   * A finished event with no `messageId` is skipped rather than posted: a
   * result card for something nobody ever saw a board for is an announcement,
   * and this job does not announce.
   */
  async listBoardDue(staleBefore: Date, limit = 50): Promise<readonly BoardableEvent[]> {
    const rows = await prisma.event.findMany({
      where: {
        OR: [
          { status: "LIVE", OR: [{ boardUpdatedAt: null }, { boardUpdatedAt: { lt: staleBefore } }] },
          { status: { in: ["COMPLETED", "CANCELLED"] }, boardFinal: false, NOT: { messageId: null } },
        ],
      },
      orderBy: { startsAt: "asc" },
      take: limit,
      select: { id: true, guildId: true, status: true, boardUpdatedAt: true },
    });

    // A live board that has never been drawn is always due; one that has been
    // is due only if a score moved since. The sweep runs on a fixed half-hourly
    // clock and the tracker polls hourly at the fastest, so without this every
    // data change costs two edits, the second redrawing the same table.
    const needsCheck = rows.filter((r) => r.status === "LIVE" && r.boardUpdatedAt !== null);
    const moved = new Map<string, Date | null>();
    if (needsCheck.length > 0) {
      const groups = await prisma.eventScore.groupBy({
        by: ["eventId"],
        where: { eventId: { in: needsCheck.map((r) => r.id) } },
        _max: { updatedAt: true },
      });
      for (const g of groups) moved.set(g.eventId, g._max.updatedAt);
    }

    return rows
      .filter((r) => {
        if (r.status !== "LIVE" || r.boardUpdatedAt === null) return true;
        const last = moved.get(r.id);
        // No scores at all is not staleness: the board already says the first
        // poll sets everyone's baseline, and redrawing that sentence hourly is
        // the exact spend this filter exists to stop.
        return last != null && last > r.boardUpdatedAt;
      })
      .map((r) => ({ id: r.id, guildId: r.guildId }));
  },

  /** Everything the board renders, in one read. */
  async boardEvent(eventId: string): Promise<EventBoardRow | null> {
    const row = await prisma.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        guildId: true,
        title: true,
        status: true,
        startsAt: true,
        endsAt: true,
        channelId: true,
        messageId: true,
        trackedMetrics: true,
        prize: true,
        _count: { select: { rsvps: { where: { state: "GOING" } } } },
      },
    });
    if (row === null) return null;
    return {
      id: row.id,
      guildId: row.guildId,
      title: row.title,
      status: row.status as EventBoardRow["status"],
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt?.toISOString() ?? null,
      channelId: row.channelId,
      messageId: row.messageId,
      trackedMetrics: row.trackedMetrics,
      participantCount: row._count.rsvps,
      prize: row.prize,
    };
  },

  /**
   * Who said they were coming and cannot be scored, because nothing links them
   * to a Minecraft account.
   *
   * The complement of `listParticipants`, deliberately computed the same way:
   * a VERIFIED link is what makes somebody trackable, so a pending or revoked
   * one counts as unlinked here exactly as it does there. Two queries rather
   * than a NOT-EXISTS, because the RSVP list is the guest list for one event
   * and is small.
   */
  async unlinkedParticipants(eventId: string): Promise<readonly { readonly discordId: string }[]> {
    const rsvps = await prisma.eventRSVP.findMany({
      where: { eventId, state: "GOING" },
      select: { discordId: true },
    });
    if (rsvps.length === 0) return [];

    const ids = rsvps.map((r) => r.discordId);
    const linked = await prisma.linkedAccount.findMany({
      where: { status: "VERIFIED", discordUser: { discordId: { in: ids } } },
      select: { discordUser: { select: { discordId: true } } },
    });
    const known = new Set(linked.map((l) => l.discordUser.discordId));
    return ids.filter((id) => !known.has(id)).map((discordId) => ({ discordId }));
  },

  /**
   * The leaderboard for one metric, ordered on the stored `delta` so the sort
   * happens in Postgres rather than over every participant's row.
   */
  async standings(eventId: string, metric: string, limit: number): Promise<readonly EventStanding[]> {
    const rows = await prisma.eventScore.findMany({
      where: { eventId, metric },
      orderBy: { delta: "desc" },
      take: limit,
      select: { discordId: true, uuid: true, delta: true },
    });
    return rows;
  },

  /**
   * Record where the board landed. `messageId` of null un-records a board that
   * could not be posted, so the next pass posts fresh instead of editing a
   * message that is not there.
   */
  async bindBoardMessage(
    eventId: string,
    channelId: string,
    messageId: string | null,
    final: boolean,
  ): Promise<void> {
    await prisma.event
      .update({
        where: { id: eventId },
        data: { channelId, messageId, boardUpdatedAt: new Date(), boardFinal: final },
      })
      .catch(() => undefined);
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
   * Every verified account, with the timestamp of its current reading.
   *
   * The refresh job orders by that timestamp to spread the guild across runs,
   * so accounts never read must sort first — they come back with null.
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
        current: { orderBy: { capturedAt: "desc" }, select: { capturedAt: true }, take: 1 },
      },
    });
    return accounts.map((a) => ({
      minecraftAccountId: a.id,
      uuid: a.uuid,
      profileId: a.selectedProfiles[0]?.profileId ?? null,
      lastCapturedAt: a.current[0]?.capturedAt.toISOString() ?? null,
    }));
  },

  /**
   * Roll a fresh reading onto the account's current row.
   *
   * The one before it is not discarded but demoted: it moves into
   * `previousMetrics`, whole, which is the entire history this table keeps.
   * That bound is the point — milestone detection needs the pair and nothing
   * else does, so storing the pair is storing exactly what is used and no more
   * (docs/HYPIXEL_COMPLIANCE.md §1).
   *
   * Read-then-write inside a transaction, because the demotion depends on what
   * is already there. Two refreshes of the same profile racing would otherwise
   * be able to interleave and lose the displaced reading — rare, since the job
   * spreads accounts across runs, but the failure would be a silently missed
   * milestone rather than an error.
   */
  async write(reading: ProfileReading): Promise<void> {
    const key = { minecraftAccountId: reading.minecraftAccountId, profileId: reading.profileId };
    const columns = {
      capturedAt: new Date(reading.capturedAt),
      skyblockLevel: reading.skyblockLevel,
      networth: toBigInt(reading.networth),
      skillAverage: reading.skillAverage,
      catacombsLevel: reading.catacombsLevel,
      slayerXp: toBigInt(reading.slayerXp),
      senitherWeight: reading.senitherWeight,
      // The widened catalog rides here rather than in columns of its own —
      // see `snapshot-metrics.ts` for the trade that buys.
      metrics: packJsonMetrics(reading),
    };

    await prisma.$transaction(async (tx) => {
      const existing = await tx.profileCurrent.findUnique({
        where: { minecraftAccountId_profileId: key },
        select: {
          capturedAt: true,
          skyblockLevel: true,
          networth: true,
          skillAverage: true,
          catacombsLevel: true,
          slayerXp: true,
          senitherWeight: true,
          metrics: true,
        },
      });

      if (existing === null) {
        // A first reading has nothing to compare against, and `{}` says so —
        // `detectMilestones` reads an absent metric as "not a crossing", so a
        // newly tracked member is not congratulated for everything at once.
        await tx.profileCurrent.create({ data: { ...key, ...columns, previousMetrics: {} } });
        return;
      }

      const displaced = packAllMetrics({
        skyblockLevel: existing.skyblockLevel,
        networth: toNumber(existing.networth),
        skillAverage: existing.skillAverage,
        catacombsLevel: existing.catacombsLevel,
        slayerXp: toNumber(existing.slayerXp),
        senitherWeight: existing.senitherWeight,
        ...unpackJsonMetrics(existing.metrics),
      });

      await tx.profileCurrent.update({
        where: { minecraftAccountId_profileId: key },
        data: { ...columns, previousMetrics: displaced, previousCapturedAt: existing.capturedAt },
      });
    });
  },

  /**
   * The account's current reading and the one it displaced, newest first.
   *
   * The pair comes off a single row, so this is one indexed read rather than an
   * ordered scan of a series — and there is structurally no third element to
   * return. An account refreshed once yields one entry; never refreshed, none.
   *
   * Where an account has more than one profile, the newest reading wins. That
   * matches what the rest of the platform shows: a member's numbers are the
   * numbers of whichever profile they last played.
   */
  async recentReadings(minecraftAccountId: string): Promise<readonly SnapshotMetrics[]> {
    const row = await prisma.profileCurrent.findFirst({
      where: { minecraftAccountId },
      orderBy: { capturedAt: "desc" },
      select: {
        skyblockLevel: true,
        networth: true,
        skillAverage: true,
        catacombsLevel: true,
        slayerXp: true,
        senitherWeight: true,
        metrics: true,
        previousMetrics: true,
        previousCapturedAt: true,
      },
    });
    if (row === null) return [];

    const current: SnapshotMetrics = {
      skyblockLevel: row.skyblockLevel,
      networth: toNumber(row.networth),
      skillAverage: row.skillAverage,
      catacombsLevel: row.catacombsLevel,
      slayerXp: toNumber(row.slayerXp),
      senitherWeight: row.senitherWeight,
      ...unpackJsonMetrics(row.metrics),
    };
    if (row.previousCapturedAt === null) return [current];
    return [current, unpackAllMetrics(row.previousMetrics)];
  },

  /**
   * A snapshot somebody asked for: an event boundary, or a member saving a
   * marker to compare against later.
   *
   * `create` rather than `upsert` for baselines, because a baseline is a fact
   * about a moment that has passed — the unique constraint on
   * `(account, event, source)` turns a second attempt into a caught P2002 and a
   * no-op rather than a moved starting line. Finals take the upsert branch, so
   * the last pass before an event completes overwrites the one before it and
   * two rows per participant is the ceiling.
   *
   * Member-saved rows have a null `eventId`, and Postgres treats nulls as
   * distinct in a unique index, so they are unconstrained by it — a member may
   * save many, bounded instead by the maintenance sweep.
   */
  async writeSnapshot(snapshot: SnapshotWrite, mode: "create-if-absent" | "overwrite"): Promise<void> {
    const data = {
      minecraftAccountId: snapshot.minecraftAccountId,
      profileId: snapshot.profileId,
      capturedAt: new Date(snapshot.capturedAt),
      source: snapshot.source,
      eventId: snapshot.eventId,
      savedBy: snapshot.savedBy,
      label: snapshot.label,
      skyblockLevel: snapshot.skyblockLevel,
      networth: toBigInt(snapshot.networth),
      skillAverage: snapshot.skillAverage,
      catacombsLevel: snapshot.catacombsLevel,
      slayerXp: toBigInt(snapshot.slayerXp),
      senitherWeight: snapshot.senitherWeight,
      metrics: packJsonMetrics(snapshot),
    };

    if (mode === "create-if-absent" || snapshot.eventId === null) {
      try {
        await prisma.profileSnapshot.create({ data });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return;
        throw error;
      }
      return;
    }

    await prisma.profileSnapshot.upsert({
      where: {
        minecraftAccountId_eventId_source: {
          minecraftAccountId: snapshot.minecraftAccountId,
          eventId: snapshot.eventId,
          source: snapshot.source,
        },
      },
      create: data,
      update: data,
    });
  },

  /** Where a participant started. Written once per participant per event. */
  writeBaseline(snapshot: SnapshotWrite): Promise<void> {
    return snapshotJobRepository.writeSnapshot(snapshot, "create-if-absent");
  },

  /** Where a participant stands now. Overwritten on every pass. */
  writeFinal(snapshot: SnapshotWrite): Promise<void> {
    return snapshotJobRepository.writeSnapshot(snapshot, "overwrite");
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
    announced: boolean = !candidate.announce,
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
          // visibility every pass. The backfill overrides it to `true` for the
          // same reason from the other direction: a threshold crossed before
          // the bot existed is history, not news.
          announced,
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
    return snapshotJobRepository.resolveTargets(await snapshotJobRepository.listAccountsWithHistory(limit));
  },

  /** Attach the guild and member context to a page of account ids. */
  async resolveTargets(accountIds: readonly string[]): Promise<readonly DetectionTarget[]> {
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

  /**
   * Accounts to back-fill, paged in a stable order.
   *
   * One reading is enough here, unlike detection's two: standings are read from
   * the current reading alone, so a member refreshed for the first time this
   * morning still has thresholds worth recording.
   */
  async listAccountsForBackfill(limit: number, offset: number): Promise<readonly DetectionTarget[]> {
    const rows = await prisma.profileCurrent.groupBy({
      by: ["minecraftAccountId"],
      orderBy: { minecraftAccountId: "asc" },
      take: limit,
      skip: offset,
    });
    return snapshotJobRepository.resolveTargets(rows.map((r) => r.minecraftAccountId));
  },

  /** The current reading's metrics, or null when the account has none. */
  async latestSnapshot(minecraftAccountId: string): Promise<SnapshotMetrics | null> {
    const [newest] = await snapshotJobRepository.recentReadings(minecraftAccountId);
    return newest ?? null;
  },

  /**
   * Accounts with something to compare — a current reading that displaced an
   * earlier one. A member refreshed only once has no crossing to detect yet.
   */
  async listAccountsWithHistory(limit: number): Promise<readonly string[]> {
    const rows = await prisma.profileCurrent.findMany({
      where: { previousCapturedAt: { not: null } },
      distinct: ["minecraftAccountId"],
      orderBy: { minecraftAccountId: "asc" },
      take: limit,
      select: { minecraftAccountId: true },
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
