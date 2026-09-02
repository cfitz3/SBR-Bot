/**
 * Prisma-backed ProgressionRepository (satisfies the @sbr/progression port).
 *
 * Both reads are keyed by Minecraft UUID rather than the internal account id —
 * that is what the command layer has in hand, and it keeps callers from needing
 * a second lookup just to ask a question about a player.
 */
import type { MilestoneDTO, ProfileSummaryDTO, ProgressionRepository } from "@sbr/shared-types";
import { SAVED_SNAPSHOT_LIMIT } from "@sbr/shared-types";
import { prisma } from "../client.js";
import { unpackJsonMetrics } from "./snapshot-metrics.js";

/** BigInt columns exceed Number.MAX_SAFE_INTEGER only past ~9 quadrillion coins. */
function toNumber(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

export const progressionRepository: ProgressionRepository = {
  async listMilestones(minecraftUuid: string, limit: number): Promise<readonly MilestoneDTO[]> {
    const rows = await prisma.milestone.findMany({
      where: { minecraftAccount: { uuid: minecraftUuid } },
      orderBy: { achievedAt: "desc" },
      take: limit,
      include: { definition: { select: { label: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      minecraftUuid,
      type: r.type as MilestoneDTO["type"],
      metric: r.metric,
      thresholdValue: Number(r.thresholdValue),
      achievedAt: r.achievedAt.toISOString(),
      // Null for anything detected from the built-in defaults, and for a row
      // whose definition was since deleted. The renderer already formats a
      // metric and a threshold, so a missing label costs nothing.
      label: r.definition?.label ?? null,
    }));
  },

  /**
   * The member's own saved markers inside the window, oldest first.
   *
   * `USER_SAVED` only, and that filter is the whole point rather than a detail:
   * this is the series `/progression` charts, and it may only contain
   * readings a member asked for. Event boundaries live in the same table and are
   * deliberately excluded — a member should not find a chart of themselves
   * appearing because they RSVP'd to something.
   */
  async listSnapshots(minecraftUuid: string, since: Date) {
    const rows = await prisma.profileSnapshot.findMany({
      where: {
        minecraftAccount: { uuid: minecraftUuid },
        source: "USER_SAVED",
        capturedAt: { gte: since },
      },
      orderBy: { capturedAt: "asc" },
      select: {
        capturedAt: true,
        label: true,
        skyblockLevel: true,
        networth: true,
        skillAverage: true,
        catacombsLevel: true,
        slayerXp: true,
        senitherWeight: true,
        metrics: true,
      },
    });
    return rows.map((r) => ({
      capturedAt: r.capturedAt.toISOString(),
      label: r.label,
      skyblockLevel: r.skyblockLevel,
      networth: toNumber(r.networth),
      skillAverage: r.skillAverage,
      catacombsLevel: r.catacombsLevel,
      slayerXp: toNumber(r.slayerXp),
      senitherWeight: r.senitherWeight,
      // Same rule as `latestSnapshot`: the widened readings ride in JSON and are
      // spread last, so a marker saved before a metric existed omits it rather
      // than claiming a null we never measured.
      ...unpackJsonMetrics(r.metrics),
    }));
  },

  /**
   * The current reading, off `ProfileCurrent` rather than off a series.
   *
   * Where a member has more than one profile the newest wins, which is the same
   * rule the worker-side repository applies — a member's numbers are whichever
   * profile they last played.
   */
  async latestSnapshot(minecraftUuid: string) {
    const row = await prisma.profileCurrent.findFirst({
      where: { minecraftAccount: { uuid: minecraftUuid } },
      orderBy: { capturedAt: "desc" },
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
    if (!row) return null;
    return {
      capturedAt: row.capturedAt.toISOString(),
      skyblockLevel: row.skyblockLevel,
      networth: toNumber(row.networth),
      skillAverage: row.skillAverage,
      catacombsLevel: row.catacombsLevel,
      slayerXp: toNumber(row.slayerXp),
      senitherWeight: row.senitherWeight,
      // Spread last so a row captured before the widened catalog existed simply
      // omits those keys — `undefined` reads as "never measured", which is true.
      ...unpackJsonMetrics(row.metrics),
    };
  },

  async saveSnapshot(minecraftUuid: string, savedBy: string, label: string | null) {
    const account = await prisma.minecraftAccount.findUnique({
      where: { uuid: minecraftUuid },
      select: { id: true },
    });
    if (!account) return { kind: "NO_READING" as const };

    // The value being pinned is the one the refresh job already holds. No
    // Hypixel call happens on this path, by construction rather than by policy
    // check — see docs/HYPIXEL_COMPLIANCE.md §1.
    const current = await prisma.profileCurrent.findFirst({
      where: { minecraftAccountId: account.id },
      orderBy: { capturedAt: "desc" },
    });
    if (!current) return { kind: "NO_READING" as const };

    const own = { minecraftAccountId: account.id, source: "USER_SAVED" as const };
    const newest = await prisma.profileSnapshot.findFirst({
      where: own,
      orderBy: { capturedAt: "desc" },
      select: { capturedAt: true },
    });
    // Same instant, same numbers: a second copy would chart as a flat segment
    // the member did not earn, and would spend one of their twenty-four slots
    // saying nothing.
    if (newest && newest.capturedAt.getTime() === current.capturedAt.getTime()) {
      return { kind: "ALREADY_SAVED" as const, capturedAt: newest.capturedAt.toISOString() };
    }

    const savedCount = await prisma.$transaction(async (tx) => {
      await tx.profileSnapshot.create({
        data: {
          minecraftAccountId: account.id,
          profileId: current.profileId,
          // The refresh's timestamp, not now: the row must say when the numbers
          // were true, or a pace computed across two saves is measured against
          // the wrong span.
          capturedAt: current.capturedAt,
          source: "USER_SAVED",
          eventId: null,
          savedBy,
          label,
          skyblockLevel: current.skyblockLevel,
          networth: current.networth,
          skillAverage: current.skillAverage,
          catacombsLevel: current.catacombsLevel,
          slayerXp: current.slayerXp,
          senitherWeight: current.senitherWeight,
          metrics: current.metrics ?? {},
        },
      });

      // Trim here rather than in the maintenance sweep, so the cap holds from
      // the moment it is exceeded rather than until the next nightly run.
      const excess = await tx.profileSnapshot.findMany({
        where: own,
        orderBy: { capturedAt: "desc" },
        skip: SAVED_SNAPSHOT_LIMIT,
        select: { id: true },
      });
      if (excess.length > 0) {
        await tx.profileSnapshot.deleteMany({ where: { id: { in: excess.map((r) => r.id) } } });
      }
      return tx.profileSnapshot.count({ where: own });
    });

    return { kind: "SAVED" as const, capturedAt: current.capturedAt.toISOString(), savedCount };
  },

  async getSelectedProfileId(minecraftUuid: string): Promise<string | null> {
    const row = await prisma.selectedSkyblockProfile.findFirst({
      where: { minecraftAccount: { uuid: minecraftUuid }, guildId: null, isActive: true },
      select: { profileId: true },
    });
    return row?.profileId ?? null;
  },

  async setSelectedProfile(minecraftUuid: string, profile: ProfileSummaryDTO): Promise<void> {
    // The account must already exist — every caller reaches here via a verified
    // link, which is what creates it.
    const account = await prisma.minecraftAccount.findUnique({
      where: { uuid: minecraftUuid },
      select: { id: true },
    });
    if (!account) return;

    const data = {
      profileId: profile.profileId,
      cuteName: profile.cuteName,
      gameMode: profile.gameMode,
      isActive: true,
    };
    // guildId null = the member's global choice, which is what `/setprofile` sets.
    // Prisma can't target a compound unique through a nullable column, so this is
    // a find-then-write rather than an upsert.
    const existing = await prisma.selectedSkyblockProfile.findFirst({
      where: { minecraftAccountId: account.id, guildId: null },
      select: { id: true },
    });
    if (existing) {
      await prisma.selectedSkyblockProfile.update({ where: { id: existing.id }, data });
    } else {
      await prisma.selectedSkyblockProfile.create({
        data: { minecraftAccountId: account.id, guildId: null, ...data },
      });
    }
  },
};
