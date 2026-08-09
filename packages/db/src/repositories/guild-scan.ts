/**
 * Persistence for the in-game roster cache, the GEXP series, and the scan audit
 * trail. Consumed by the `guild-scan` job to write, and by everything that would
 * otherwise call Hypixel — perms, leaderboards, XP — to read.
 */
import { Prisma } from "@prisma/client";
import type { GexpDailyWrite, GuildScanResult, MemberCacheWrite } from "@sbr/jobs";
import { prisma } from "../client.js";

export interface CachedGuildMemberRow {
  readonly uuid: string;
  readonly ign: string | null;
  readonly guildRank: string | null;
  readonly joinedAt: Date | null;
  readonly weeklyGexp: number;
  readonly refreshedAt: Date;
}

/** Chunk size for the multi-row upserts. Keeps one statement well inside Postgres'
 *  parameter limit while still cutting a 125-member guild to a couple of round trips. */
const CHUNK = 100;

function chunk<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export const guildScanRepository = {
  /** The cache as it stands, newest refresh first. Stale rows are returned too —
   *  staleness is the caller's decision, not a reason to hide the roster. */
  async listCache(guildId: string): Promise<readonly CachedGuildMemberRow[]> {
    const rows = await prisma.guildMemberCache.findMany({
      where: { guildId },
      orderBy: { weeklyGexp: "desc" },
      select: { uuid: true, ign: true, guildRank: true, joinedAt: true, weeklyGexp: true, refreshedAt: true },
    });
    return rows;
  },

  /** Newest `refreshedAt` in the guild's cache, or null if it has never been scanned. */
  async lastRefreshedAt(guildId: string): Promise<Date | null> {
    const row = await prisma.guildMemberCache.findFirst({
      where: { guildId },
      orderBy: { refreshedAt: "desc" },
      select: { refreshedAt: true },
    });
    return row?.refreshedAt ?? null;
  },

  /**
   * Upsert the roster.
   *
   * Written as raw SQL with a multi-row `ON CONFLICT` rather than a loop of
   * Prisma upserts: a 125-member guild is 125 round trips the naive way, every
   * six hours, for data that changes by a handful of rows. `createdAt` is left
   * alone on conflict so it keeps meaning "first seen in this guild".
   */
  async upsertMembers(guildId: string, rows: readonly MemberCacheWrite[]): Promise<void> {
    for (const batch of chunk(rows, CHUNK)) {
      const values = batch.map(
        (r) => Prisma.sql`(gen_random_uuid()::text, ${guildId}, ${r.uuid}, ${r.ign}, ${r.guildRank},
          ${r.joinedAt}, ${r.weeklyGexp}, ${r.refreshedAt}, ${r.refreshedAt})`,
      );
      await prisma.$executeRaw`
        INSERT INTO "GuildMemberCache"
          ("id", "guildId", "uuid", "ign", "guildRank", "joinedAt", "weeklyGexp", "refreshedAt", "createdAt")
        VALUES ${Prisma.join(values)}
        ON CONFLICT ("guildId", "uuid") DO UPDATE SET
          -- A resolved name is never overwritten with null: the scan sends what
          -- it knows, and a Mojang lookup it skipped this run is not evidence
          -- that the member lost their name.
          "ign"         = COALESCE(EXCLUDED."ign", "GuildMemberCache"."ign"),
          "guildRank"   = EXCLUDED."guildRank",
          "joinedAt"    = COALESCE(EXCLUDED."joinedAt", "GuildMemberCache"."joinedAt"),
          "weeklyGexp"  = EXCLUDED."weeklyGexp",
          "refreshedAt" = EXCLUDED."refreshedAt"
      `;
    }
  },

  async removeMembers(guildId: string, uuids: readonly string[]): Promise<void> {
    if (uuids.length === 0) return;
    await prisma.guildMemberCache.deleteMany({ where: { guildId, uuid: { in: [...uuids] } } });
  },

  /**
   * Upsert the daily GEXP series. Returns rows touched.
   *
   * Overwriting on conflict is the whole design: today's value climbs all day,
   * so the last scan of the day is the true one. Summing here would multiply a
   * day's GEXP by the number of times it was observed.
   */
  async writeGexp(guildId: string, rows: readonly GexpDailyWrite[]): Promise<number> {
    let written = 0;
    for (const batch of chunk(rows, CHUNK)) {
      const values = batch.map(
        (r) => Prisma.sql`(gen_random_uuid()::text, ${guildId}, ${r.uuid}, ${r.day}::date, ${r.gexp})`,
      );
      written += await prisma.$executeRaw`
        INSERT INTO "GuildGexpDaily" ("id", "guildId", "uuid", "day", "gexp")
        VALUES ${Prisma.join(values)}
        ON CONFLICT ("guildId", "uuid", "day") DO UPDATE SET "gexp" = EXCLUDED."gexp"
      `;
    }
    return written;
  },

  /** Total GEXP for a member over the last `days` days — the tenure/activity input. */
  async sumGexp(guildId: string, uuid: string, days: number): Promise<number> {
    const since = new Date(Date.now() - days * 24 * 60 * 60_000);
    const agg = await prisma.guildGexpDaily.aggregate({
      where: { guildId, uuid, day: { gte: since } },
      _sum: { gexp: true },
    });
    return agg._sum.gexp ?? 0;
  },

  async recordScan(guildId: string, result: GuildScanResult, error: string | null): Promise<void> {
    const now = new Date();
    await prisma.guildScan.create({
      data: {
        guildId,
        startedAt: now,
        finishedAt: now,
        memberCount: result.memberCount,
        joined: [...result.joined],
        left: [...result.left],
        error,
      },
    });
  },

  /** Most recent scans, newest first — what the panel's health view reads. */
  async recentScans(guildId: string, limit: number): Promise<readonly { startedAt: Date; memberCount: number; error: string | null }[]> {
    return prisma.guildScan.findMany({
      where: { guildId },
      orderBy: { startedAt: "desc" },
      take: limit,
      select: { startedAt: true, memberCount: true, error: true },
    });
  },
};
