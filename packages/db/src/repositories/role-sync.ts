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
   * Fill in a member's Hypixel guild rank from the roster cache, if it is
   * missing and the cache knows it.
   *
   * This exists because of a hole between two facts that arrive at different
   * times. Linking makes `linked` true immediately, but `inGuild` is
   * `guildRank !== null`, and `guildRank` is written only by `guild-roster-sync`
   * — which reconciles the Hypixel roster against *linked* members, so it
   * cannot have written a rank for somebody who was not linked until a moment
   * ago. An IN_GUILD rule evaluated on the link's own reconcile therefore saw
   * `false` and granted nothing, and by the time the rank landed half an hour
   * later nothing marked the member dirty again.
   *
   * The roster cache is the same roster, already fetched, keyed by
   * `(guildId, uuid)`. Reading it here turns the link into the moment both
   * facts are true rather than only one.
   *
   * Deliberately narrow. It fills a null, never overwrites a rank — a rank that
   * disagrees with the cache is `guild-roster-sync`'s to correct, and a cache up
   * to six hours old has no business winning that argument. It leaves `status`
   * alone for the same reason: resurrecting a member somebody marked departed is
   * a much worse mistake than waiting half an hour for the roster pass.
   *
   * Returns whether anything was written, so the caller can say so in a log.
   */
  async adoptCachedGuildRank(guildId: string, discordId: string): Promise<boolean> {
    const member = await prisma.guildMember.findFirst({
      where: { guildId, discordUser: { discordId }, guildRank: null },
      select: {
        id: true,
        discordUser: {
          select: {
            linkedAccounts: {
              where: { status: "VERIFIED" },
              select: { minecraftAccount: { select: { uuid: true } } },
              take: 1,
            },
          },
        },
      },
    });
    if (member === null) return false;

    const uuid = member.discordUser.linkedAccounts[0]?.minecraftAccount.uuid;
    if (uuid === undefined) return false;

    const cached = await prisma.guildMemberCache.findUnique({
      where: { guildId_uuid: { guildId, uuid } },
      select: { guildRank: true },
    });
    if (cached?.guildRank == null) return false;

    // Guarded on `guildRank: null` again rather than by id alone, so two
    // concurrent links cannot both decide they are the one writing it.
    const written = await prisma.guildMember.updateMany({
      where: { id: member.id, guildRank: null },
      data: { guildRank: cached.guildRank },
    });
    return written.count > 0;
  },

  /**
   * The Hypixel guild a platform guild is bound to, or null when nobody has
   * bound one yet.
   *
   * Read on the link path so a live membership probe knows which guild it is
   * asking about. A guild with no binding simply skips the probe: there is no
   * roster to be a member of, so "in guild" is not a question that has an
   * answer for it.
   */
  async hypixelGuildIdFor(guildId: string): Promise<string | null> {
    const row = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { hypixelGuildId: true },
    });
    return row?.hypixelGuildId ?? null;
  },

  /** The member's verified Minecraft uuid, which is what Hypixel is asked about. */
  async linkedUuid(discordId: string): Promise<string | null> {
    const row = await prisma.linkedAccount.findFirst({
      where: { status: "VERIFIED", discordUser: { discordId } },
      orderBy: [{ isPrimary: "desc" }, { verifiedAt: "desc" }],
      select: { minecraftAccount: { select: { uuid: true } } },
    });
    return row?.minecraftAccount.uuid ?? null;
  },

  /**
   * Write a guild rank we just read from Hypixel itself.
   *
   * The counterpart to `adoptCachedGuildRank`, and deliberately the opposite
   * shape: that one fills a null from a roster cache that may be six hours old
   * and refuses to overwrite anything, because it is guessing. This one is
   * called with an answer Hypixel gave a moment ago, so it overwrites — a rank
   * that changed is now correct, and a member who has left the guild has their
   * rank cleared, which is what makes an IN_GUILD rule revoke on the spot
   * instead of at the next roster scan.
   *
   * Still leaves `status` alone. Leaving the Hypixel guild is not leaving the
   * Discord server, and conflating the two is how a member loses everything for
   * changing guilds.
   *
   * Returns whether the stored rank actually changed, so the caller can say so
   * in a log without a second read.
   */
  async writeGuildRank(guildId: string, discordId: string, rank: string | null): Promise<boolean> {
    // Read first rather than filtering on `NOT: { guildRank: rank }`: in SQL a
    // `<> 'Member'` comparison is *unknown* for a NULL rank, so the row that
    // most needs the write — somebody who has never had one — is the one such a
    // filter would silently skip.
    const member = await prisma.guildMember.findFirst({
      where: { guildId, discordUser: { discordId } },
      select: { id: true, guildRank: true },
    });
    if (member === null || member.guildRank === rank) return false;
    await prisma.guildMember.update({ where: { id: member.id }, data: { guildRank: rank } });
    return true;
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
      where: { status: "VERIFIED", minecraftAccount: { uuid: { in: [...new Set(uuids)] } } },
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
 * Asks Hypixel, right now, what rank somebody holds in a guild.
 *
 * A port rather than an import because `@sbr/db` has no business knowing what
 * an HTTP client is, and because the honest answers are three rather than two:
 * a rank, `null` for "confirmed not a member", and `undefined` for "could not
 * tell". The third is the one that matters — treating an unreachable API as
 * "not a member" would revoke the guild role of everybody who linked during an
 * outage, which is a far worse failure than the role arriving late.
 */
export interface LiveGuildRankProbe {
  rank(hypixelGuildId: string, uuid: string): Promise<string | null | undefined>;
}

/** What one member's immediate pass managed to settle. */
export interface MemberMarkReport {
  /** How many platform guilds the member belongs to. */
  readonly guilds: number;
  /**
   * True when at least one guild's Hypixel membership could not be confirmed,
   * so any guild-gated role is still outstanding. The caller says so to the
   * member; the retry and the sweep are what eventually make it false.
   */
  readonly pending: boolean;
}

export interface MemberRoleDirtyMarkerOptions {
  /**
   * Live guild membership, when the app has a Hypixel client to spare. Absent
   * — which is what setting `LINK_GUILD_PROBE=0` produces — falls back to the
   * roster cache exactly as before, so the flag is a true off switch rather
   * than a different code path.
   */
  readonly probe?: LiveGuildRankProbe;
  /** How long to wait before one more attempt at a membership we could not read. */
  readonly retryMs?: number;
  /** How many such attempts. One, by default: past that the sweep is the answer. */
  readonly retries?: number;
  /** Step-by-step operational trace of a link. Silent when absent. */
  readonly log?: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

const DEFAULT_RETRY_MS = 45_000;

/**
 * Turns a per-guild dirty marker into the guild-agnostic one identity wants,
 * and — given a probe — settles the member's Hypixel guild status before it
 * marks, so the reconcile that follows evaluates the facts as they are rather
 * than as the last roster scan left them.
 *
 * Lives here rather than in a composition file because every app that links
 * accounts needs exactly this, and the fan-out query is a database concern. The
 * structural parameter type keeps `@sbr/db` from having to depend on either the
 * identity package or the Redis one.
 *
 * The order inside the loop is load-bearing and has cost us a bug before:
 * membership is settled *before* the mark, never after. The reconcile a mark
 * triggers reads the member's facts once, so a rank that lands afterwards is a
 * fact that arrived too late to be used.
 *
 * Nothing here retries forever and nothing here is durable. Every member it
 * touches is in `roles:dirty:<guildId>` regardless, and the fifteen-minute
 * sweep is still what guarantees they are reconciled at all — this only decides
 * how many of them get there while somebody is still looking at the reply.
 */
export function memberRoleDirtyMarker(
  sink: { mark(guildId: string, discordIds: readonly string[]): Promise<void> },
  options: MemberRoleDirtyMarkerOptions = {},
): { markMember(discordId: string): Promise<MemberMarkReport> } {
  const log = options.log;
  const retries = options.retries ?? 1;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;

  /**
   * Settle one guild's membership from Hypixel. Returns whether it was settled;
   * `false` means the caller should fall back to the roster cache and report the
   * member as pending.
   */
  async function settle(guildId: string, discordId: string, uuid: string): Promise<boolean> {
    const probe = options.probe;
    if (probe === undefined) return false;

    const hypixelGuildId = await roleSyncRepository.hypixelGuildIdFor(guildId).catch(() => null);
    if (hypixelGuildId === null) {
      log?.info("link: guild has no Hypixel guild bound", { guildId, discordId });
      return false;
    }

    const rank = await probe.rank(hypixelGuildId, uuid).catch(() => undefined);
    if (rank === undefined) {
      log?.warn("link: Hypixel would not say whether the member is in the guild", {
        guildId,
        discordId,
        hypixelGuildId,
      });
      return false;
    }

    const changed = await roleSyncRepository
      .writeGuildRank(guildId, discordId, rank)
      .catch(() => false);
    log?.info("link: guild membership resolved", {
      guildId,
      discordId,
      inGuild: rank !== null,
      rank,
      changed,
    });
    return true;
  }

  async function pass(discordId: string, attemptsLeft: number): Promise<MemberMarkReport> {
    const guildIds = await roleSyncRepository.guildIdsForMember(discordId);
    // One read for every guild rather than one per guild: a member's link is
    // guild-agnostic, and so is the uuid Hypixel is asked about.
    const uuid =
      options.probe === undefined
        ? null
        : await roleSyncRepository.linkedUuid(discordId).catch(() => null);

    let pending = false;
    for (const guildId of guildIds) {
      const settled = uuid === null ? false : await settle(guildId, discordId, uuid);
      if (!settled) {
        if (options.probe !== undefined && uuid !== null) pending = true;
        await roleSyncRepository.adoptCachedGuildRank(guildId, discordId).catch(() => false);
      }
      await sink.mark(guildId, [discordId]);
      log?.info("link: member marked for role sync", { guildId, discordId, settled });
    }

    // The short-lived retry. Not durable and not a queue: a timer in this
    // process, unreferenced so it never holds a shutdown open, doing one more
    // pass at a membership Hypixel would not confirm. If the process dies first
    // the member is still dirty and the sweep still reconciles them.
    if (pending && attemptsLeft > 0) {
      const timer = setTimeout(() => {
        void pass(discordId, attemptsLeft - 1).catch(() => undefined);
      }, retryMs);
      timer.unref?.();
      log?.info("link: guild membership retry scheduled", { discordId, inMs: retryMs });
    }

    return { guilds: guildIds.length, pending };
  }

  return {
    markMember(discordId) {
      return pass(discordId, retries);
    },
  };
}
