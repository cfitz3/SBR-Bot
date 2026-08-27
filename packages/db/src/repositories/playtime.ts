/**
 * Storage for closed play sessions, and the two questions asked of them.
 *
 * The tracker in `@sbr/playtime` owns the state machine and holds no I/O; this
 * is the only place a session touches Postgres. `record` is idempotent by way
 * of the `(guildId, ign, endedAt)` unique index rather than a read-then-write:
 * a bridge restart that replays a chat window would otherwise double-count, and
 * a duplicate is far more likely than two members leaving in the same
 * millisecond under the same name.
 */
import { prisma } from "../client.js";
import type { PlaySession, PlaySessionSink } from "@sbr/playtime";

export const playSessionSink: PlaySessionSink = {
  async record(guildId, session) {
    await prisma.playSession.createMany({
      data: [
        {
          guildId,
          ign: session.ign,
          startedAt: new Date(session.startedAt),
          endedAt: new Date(session.endedAt),
          seconds: session.seconds,
        },
      ],
      skipDuplicates: true,
    });
  },
};

export const playtimeRepository = {
  /** Total seconds one member has played since a cutoff. */
  async totalFor(guildId: string, ign: string, since: Date): Promise<number> {
    const result = await prisma.playSession.aggregate({
      where: { guildId, ign: { equals: ign, mode: "insensitive" }, startedAt: { gte: since } },
      _sum: { seconds: true },
    });
    return result._sum.seconds ?? 0;
  },

  /**
   * Who played most over a window, longest first.
   *
   * Grouped in the database rather than pulled and summed here: a busy guild
   * produces thousands of rows a week, and the caller only ever wants a page of
   * them.
   */
  async topBySeconds(guildId: string, since: Date, limit: number): Promise<readonly { ign: string; seconds: number }[]> {
    const rows = await prisma.playSession.groupBy({
      by: ["ign"],
      where: { guildId, startedAt: { gte: since } },
      _sum: { seconds: true },
      orderBy: { _sum: { seconds: "desc" } },
      take: limit,
    });
    return rows.map((r) => ({ ign: r.ign, seconds: r._sum.seconds ?? 0 }));
  },

  /**
   * Drop sessions older than the retention window.
   *
   * Playtime is an activity signal with a short useful life; keeping a year of
   * per-session rows costs storage to answer a question nobody asks. Called by
   * the same job that prunes the other activity tables.
   */
  async prune(before: Date): Promise<number> {
    const { count } = await prisma.playSession.deleteMany({ where: { endedAt: { lt: before } } });
    return count;
  },
};

export type { PlaySession };
