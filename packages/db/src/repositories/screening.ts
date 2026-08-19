/**
 * Persistence for join screening.
 *
 * Three adapters live here, because all three read the same table or its
 * neighbours: the screening store itself, the applicant-history source the
 * policy consults, and the policy source that reads `screening.policy` out of
 * `GuildSetting`.
 *
 * Note what history does *not* do: it never treats "no rows" as reassurance.
 * An applicant with no history is simply an applicant we have not met, and the
 * policy is told exactly that.
 */
import { Prisma } from "@prisma/client";
import { SCREENING_POLICY_KEY } from "@sbr/screening";
import type {
  ApplicantHistory,
  ApplicantHistorySource,
  ApplicantStats,
  ScammerFinding,
  Screening,
  ScreeningOutcome,
  ScreeningPolicySource,
  ScreeningRecord,
  ScreeningReason,
  ScreeningRepository,
  ScreeningVerdict,
} from "@sbr/screening";
import { prisma } from "../client.js";

/**
 * Where the per-guild policy lives. Panel-editable, never in `.env`.
 *
 * Re-exported rather than redeclared: the panel writes this key and this file
 * reads it, and two spellings of the same constant is a bug that presents as
 * "the policy I saved has no effect".
 */
export { SCREENING_POLICY_KEY } from "@sbr/screening";

/** The row shape we select, so the mapper is checked rather than cast. */
type Row = Prisma.GuildJoinScreeningGetPayload<Record<string, never>>;

function toScammer(row: Row): ScammerFinding {
  if (row.scammer === null) return { status: "UNKNOWN", detail: null };
  if (!row.scammer) return { status: "CLEAR" };
  return {
    status: "FLAGGED",
    reason: row.scammerReason,
    source: row.scammerSource === "DISCORD" ? "DISCORD" : "UUID",
  };
}

function toStats(row: Row): ApplicantStats {
  const extra = (row.metrics ?? {}) as Record<string, unknown>;
  return {
    profileName: row.profileName,
    skyblockLevel: row.skyblockLevel,
    skillAverage: row.skillAverage,
    catacombsLevel: row.catacombsLevel,
    senitherWeight: row.senitherWeight,
    networth: row.networth,
    firstLoginAt: row.firstLoginAt,
    lastLoginAt: row.lastLoginAt,
    currentGuild: typeof extra["currentGuild"] === "string" ? (extra["currentGuild"] as string) : null,
    apiDisabled: extra["apiDisabled"] === true,
    unreadable: extra["unreadable"] === true,
    extra,
  };
}

function toRecord(row: Row): ScreeningRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    uuid: row.uuid,
    ign: row.ign,
    discordId: row.discordId,
    requestedAt: row.requestedAt,
    verdict: row.verdict as ScreeningVerdict,
    riskScore: row.riskScore,
    reasons: row.reasons as ScreeningReason[],
    scammer: toScammer(row),
    stats: toStats(row),
    // History is a point-in-time input, not an output worth re-deriving on
    // read; the reason codes already record what it changed.
    history: {
      recentAttempts: 0,
      priorDenial: row.reasons.includes("PRIOR_DENIAL"),
      priorExpulsion: row.reasons.includes("PRIOR_EXPULSION"),
      expulsionReason: null,
    },
    error: row.error,
    outcome: row.outcome as ScreeningOutcome,
    decidedAt: row.decidedAt,
    decidedBy: row.decidedBy,
  };
}

export const screeningRepository: ScreeningRepository = {
  async record(guildId: string, s: Screening): Promise<string> {
    const row = await prisma.guildJoinScreening.create({
      data: {
        guildId,
        uuid: s.uuid,
        ign: s.ign,
        discordId: s.discordId,
        requestedAt: s.requestedAt,
        verdict: s.verdict,
        riskScore: s.riskScore,
        reasons: [...s.reasons],
        // Three-valued: undefined-as-null is the "could not check" case, and
        // the column is nullable precisely so it stays distinguishable.
        scammer: s.scammer.status === "UNKNOWN" ? null : s.scammer.status === "FLAGGED",
        scammerReason: s.scammer.status === "FLAGGED" ? s.scammer.reason : null,
        scammerSource: s.scammer.status === "FLAGGED" ? s.scammer.source : null,
        networth: s.stats.networth,
        skillAverage: s.stats.skillAverage,
        catacombsLevel: s.stats.catacombsLevel,
        senitherWeight: s.stats.senitherWeight,
        skyblockLevel: s.stats.skyblockLevel,
        profileName: s.stats.profileName,
        firstLoginAt: s.stats.firstLoginAt,
        lastLoginAt: s.stats.lastLoginAt,
        metrics: {
          ...s.stats.extra,
          currentGuild: s.stats.currentGuild,
          apiDisabled: s.stats.apiDisabled,
          unreadable: s.stats.unreadable,
        } as Prisma.InputJsonValue,
        // An ACCEPT that the guild has not enabled auto-accept for still lands
        // as PENDING; the caller marks it ACCEPTED once `/g accept` is sent.
        outcome: "PENDING",
        error: s.error,
      },
      select: { id: true },
    });
    return row.id;
  },

  async decide(id: string, outcome: ScreeningOutcome, by: string): Promise<void> {
    await prisma.guildJoinScreening.update({
      where: { id },
      data: { outcome, decidedBy: by, decidedAt: new Date() },
    });
  },

  async pending(guildId: string, limit: number): Promise<readonly ScreeningRecord[]> {
    const rows = await prisma.guildJoinScreening.findMany({
      where: { guildId, outcome: "PENDING" },
      orderBy: { requestedAt: "asc" },
      take: limit,
    });
    return rows.map(toRecord);
  },

  async forPlayer(guildId: string, uuid: string, limit: number): Promise<readonly ScreeningRecord[]> {
    const rows = await prisma.guildJoinScreening.findMany({
      where: { guildId, uuid },
      orderBy: { requestedAt: "desc" },
      take: limit,
    });
    return rows.map(toRecord);
  },

  async findPending(guildId: string, uuid: string): Promise<ScreeningRecord | null> {
    const row = await prisma.guildJoinScreening.findFirst({
      where: { guildId, uuid, outcome: "PENDING" },
      orderBy: { requestedAt: "desc" },
    });
    return row ? toRecord(row) : null;
  },

  async findLatestByIgn(guildId: string, ign: string): Promise<ScreeningRecord | null> {
    const row = await prisma.guildJoinScreening.findFirst({
      // Minecraft names are case-insensitive to their owner, and the casing we
      // stored came from whichever source answered first.
      where: { guildId, ign: { equals: ign, mode: "insensitive" } },
      orderBy: { requestedAt: "desc" },
    });
    return row ? toRecord(row) : null;
  },

  async expireStale(guildId: string, before: Date): Promise<number> {
    const { count } = await prisma.guildJoinScreening.updateMany({
      where: { guildId, outcome: "PENDING", requestedAt: { lt: before } },
      data: { outcome: "EXPIRED", decidedAt: new Date(), decidedBy: "AUTO" },
    });
    return count;
  },
};

export const screeningHistorySource: ApplicantHistorySource = {
  async read(guildId: string, uuid: string, discordId: string | null, windowDays: number): Promise<ApplicantHistory> {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60_000);

    const [recentAttempts, priorDenial, expulsion] = await Promise.all([
      prisma.guildJoinScreening.count({ where: { guildId, uuid, requestedAt: { gte: since } } }),
      prisma.guildJoinScreening
        .count({ where: { guildId, uuid, outcome: "DENIED" } })
        .then((n) => n > 0),
      // A kick or ban recorded against either identity. The Minecraft side is
      // matched through the account row, because moderation stores an account
      // id and screening only ever knows a uuid.
      prisma.moderationAction.findFirst({
        where: {
          guildId,
          type: { in: ["KICK", "BAN", "GUILD_EXPEL"] },
          OR: [
            { targetMinecraftAccountId: { in: await accountIdsFor(uuid) } },
            ...(discordId ? [{ targetDiscordId: discordId }] : []),
          ],
        },
        orderBy: { createdAt: "desc" },
        select: { reason: true },
      }),
    ]);

    return {
      recentAttempts,
      priorDenial,
      priorExpulsion: expulsion !== null,
      expulsionReason: expulsion?.reason ?? null,
    };
  },
};

/** Account ids for a uuid — empty when the platform has never seen them. */
async function accountIdsFor(uuid: string): Promise<string[]> {
  const account = await prisma.minecraftAccount.findUnique({ where: { uuid }, select: { id: true } });
  return account ? [account.id] : [];
}

export const screeningPolicySource: ScreeningPolicySource = {
  async read(guildId: string): Promise<unknown> {
    const row = await prisma.guildSetting.findUnique({
      where: { guildId_key: { guildId, key: SCREENING_POLICY_KEY } },
      select: { value: true },
    });
    return row?.value ?? null;
  },
};
