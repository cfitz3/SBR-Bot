/**
 * Persistence for XP: the ledger, the balances, per-source policy, and the
 * activity counters everything is derived from.
 *
 * Three of the reads (`gexpForDay`, `tenureForDay`, `eventsForDay`) are joins
 * the domain package has no business knowing about — GEXP is keyed by uuid,
 * tenure lives on `GuildMember`, attendance on `EventRSVP` — so they are
 * resolved to Discord snowflakes here and `@sbr/xp` sees one flat shape.
 */
import type {
  ActivityRow,
  ActivitySink,
  BalanceRow,
  LedgerRow,
  XpRepository,
  XpSource,
  XpSourcePolicy,
} from "@sbr/xp";
import { prisma } from "../client.js";

/** `YYYY-MM-DD` → the midnight-UTC Date a `@db.Date` column stores. */
function toDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function fromDay(day: Date): string {
  return day.toISOString().slice(0, 10);
}

/**
 * `bySource` is stored as JSON, so it comes back as `unknown`. Anything that
 * isn't a number is dropped rather than coerced: a corrupted key should read as
 * a missing source, not as `NaN` XP.
 */
function toBySource(value: unknown): Readonly<Partial<Record<XpSource, number>>> {
  if (value === null || typeof value !== "object") return {};
  const out: Partial<Record<XpSource, number>> = {};
  for (const [key, n] of Object.entries(value as Record<string, unknown>)) {
    if (typeof n === "number" && Number.isFinite(n)) out[key as XpSource] = n;
  }
  return out;
}

/** uuid → Discord snowflake, for the verified links only. */
async function linkedSnowflakes(uuids: readonly string[]): Promise<Map<string, string>> {
  if (uuids.length === 0) return new Map();
  const links = await prisma.linkedAccount.findMany({
    where: { status: "VERIFIED", minecraftAccount: { uuid: { in: [...uuids] } } },
    select: { discordUser: { select: { discordId: true } }, minecraftAccount: { select: { uuid: true } } },
  });
  return new Map(links.map((l) => [l.minecraftAccount.uuid, l.discordUser.discordId]));
}

export const xpRepository: XpRepository = {
  async policy(guildId): Promise<readonly XpSourcePolicy[]> {
    const rows = await prisma.xpSourceConfig.findMany({ where: { guildId } });
    return rows.map((r) => ({
      source: r.source as XpSource,
      enabled: r.enabled,
      weight: r.weight,
      dailyCap: r.dailyCap,
      cooldownSec: r.cooldownSec,
      minLength: r.minLength,
    }));
  },

  async setSourcePolicy(guildId, policy): Promise<XpSourcePolicy> {
    const data = {
      enabled: policy.enabled,
      weight: policy.weight,
      dailyCap: policy.dailyCap,
      cooldownSec: policy.cooldownSec,
      minLength: policy.minLength,
    };
    const row = await prisma.xpSourceConfig.upsert({
      where: { guildId_source: { guildId, source: policy.source } },
      create: { guildId, source: policy.source, ...data },
      update: data,
    });
    return {
      source: row.source as XpSource,
      enabled: row.enabled,
      weight: row.weight,
      dailyCap: row.dailyCap,
      cooldownSec: row.cooldownSec,
      minLength: row.minLength,
    };
  },

  async activityForDay(guildId, day): Promise<readonly ActivityRow[]> {
    const rows = await prisma.activityDaily.findMany({ where: { guildId, day: toDay(day) } });
    return rows.map((r) => ({
      discordId: r.discordId,
      day: fromDay(r.day),
      counters: {
        discordMessages: r.discordMessages,
        guildChatMessages: r.guildChatMessages,
        commandsUsed: r.commandsUsed,
        presenceSamples: r.presenceSamples,
      },
    }));
  },

  async gexpForDay(guildId, day) {
    const rows = await prisma.guildGexpDaily.findMany({
      where: { guildId, day: toDay(day) },
      select: { uuid: true, gexp: true },
    });
    const byUuid = await linkedSnowflakes(rows.map((r) => r.uuid));
    // An unlinked IGN earns nothing: XP is attributed to a platform member, and
    // a uuid alone cannot name one (PLATFORM_EXPANSION_PLAN.md assumption 4).
    const out: { discordId: string; gexp: number }[] = [];
    for (const row of rows) {
      const discordId = byUuid.get(row.uuid);
      if (discordId !== undefined) out.push({ discordId, gexp: row.gexp });
    }
    return out;
  },

  async tenureForDay(guildId, day) {
    const asOf = toDay(day);
    const members = await prisma.guildMember.findMany({
      where: { guildId, status: "ACTIVE", joinedAt: { not: null, lte: asOf } },
      select: { joinedAt: true, discordUser: { select: { discordId: true } } },
    });
    return members.map((m) => ({
      discordId: m.discordUser.discordId,
      days: Math.max(0, Math.floor((asOf.getTime() - (m.joinedAt?.getTime() ?? asOf.getTime())) / 86_400_000)),
    }));
  },

  async eventsForDay(guildId, day) {
    const start = toDay(day);
    const end = new Date(start.getTime() + 86_400_000);
    // Attendance is the RSVP that survived the event, so this counts GOING on
    // events that actually started that day — an RSVP to next week's raid is not
    // attendance yet.
    const rsvps = await prisma.eventRSVP.findMany({
      where: { state: "GOING", event: { guildId, startsAt: { gte: start, lt: end } } },
      select: { discordId: true },
    });
    const counts = new Map<string, number>();
    for (const r of rsvps) counts.set(r.discordId, (counts.get(r.discordId) ?? 0) + 1);
    return [...counts].map(([discordId, count]) => ({ discordId, count }));
  },

  async recordAwards(guildId, awards): Promise<void> {
    for (const award of awards) {
      const data = {
        guildId,
        discordId: award.discordId,
        source: award.source,
        amount: award.amount,
        rawValue: award.rawValue,
        day: toDay(award.day),
        meta: (award.meta ?? {}) as object,
      };
      if (award.dedupeKey === null) {
        await prisma.xpEvent.create({ data });
        continue;
      }
      // Upsert, not create-or-skip: today's counters keep climbing, so a re-run
      // has to overwrite this morning's partial figure rather than ignore it.
      await prisma.xpEvent.upsert({
        where: { dedupeKey: award.dedupeKey },
        create: { ...data, dedupeKey: award.dedupeKey },
        update: { amount: award.amount, rawValue: award.rawValue, meta: data.meta },
      });
    }
  },

  async ledger(guildId): Promise<readonly LedgerRow[]> {
    const rows = await prisma.xpEvent.findMany({
      where: { guildId },
      select: { discordId: true, source: true, amount: true, rawValue: true, day: true, createdAt: true },
    });
    return rows.map((r) => ({
      discordId: r.discordId,
      source: r.source as XpSource,
      amount: r.amount,
      rawValue: r.rawValue,
      day: fromDay(r.day),
      createdAt: r.createdAt,
    }));
  },

  async saveBalances(guildId, balances): Promise<void> {
    for (const b of balances) {
      const data = {
        totalXp: b.totalXp,
        level: b.level,
        bySource: b.bySource as object,
        tenureDays: b.tenureDays,
        lastAwardAt: b.lastAwardAt,
      };
      await prisma.xpBalance.upsert({
        where: { guildId_discordId: { guildId, discordId: b.discordId } },
        create: { guildId, discordId: b.discordId, ...data },
        update: data,
      });
    }
  },

  async balance(guildId, discordId): Promise<BalanceRow | null> {
    const row = await prisma.xpBalance.findUnique({ where: { guildId_discordId: { guildId, discordId } } });
    if (row === null) return null;
    return {
      discordId: row.discordId,
      totalXp: row.totalXp,
      level: row.level,
      bySource: toBySource(row.bySource),
      tenureDays: row.tenureDays,
      lastAwardAt: row.lastAwardAt,
    };
  },

  async rank(guildId, discordId): Promise<number | null> {
    const mine = await prisma.xpBalance.findUnique({
      where: { guildId_discordId: { guildId, discordId } },
      select: { totalXp: true },
    });
    if (mine === null) return null;
    // Count who is strictly ahead rather than paging the board: rank is a single
    // indexed count, and ties share a position instead of being ordered
    // arbitrarily by row id.
    const ahead = await prisma.xpBalance.count({ where: { guildId, totalXp: { gt: mine.totalXp } } });
    return ahead + 1;
  },

  async top(guildId, limit): Promise<readonly BalanceRow[]> {
    const rows = await prisma.xpBalance.findMany({
      where: { guildId },
      orderBy: { totalXp: "desc" },
      take: limit,
    });
    return rows.map((row) => ({
      discordId: row.discordId,
      totalXp: row.totalXp,
      level: row.level,
      bySource: toBySource(row.bySource),
      tenureDays: row.tenureDays,
      lastAwardAt: row.lastAwardAt,
    }));
  },
};

/**
 * The counter sink, straight to Postgres.
 *
 * Deployments with Redis wire a buffering sink in front of this (see
 * `@sbr/redis`); this implementation is the drain behind it and the whole thing
 * for single-instance setups. An upsert per message is affordable at guild
 * scale — it is one indexed write against one row per member per day.
 */
export const activitySink: ActivitySink = {
  async bump(guildId, discordId, day, field, by): Promise<void> {
    await prisma.activityDaily.upsert({
      where: { guildId_discordId_day: { guildId, discordId, day: toDay(day) } },
      create: { guildId, discordId, day: toDay(day), [field]: by },
      update: { [field]: { increment: by } },
    });
  },
};
