/**
 * Prisma-backed ProgressionRepository (satisfies the @sbr/progression port).
 *
 * Both reads are keyed by Minecraft UUID rather than the internal account id —
 * that is what the command layer has in hand, and it keeps callers from needing
 * a second lookup just to ask a question about a player.
 */
import type { MilestoneDTO, ProfileSummaryDTO, ProgressionRepository } from "@sbr/shared-types";
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

  async listSnapshots(minecraftUuid: string, since: Date) {
    const rows = await prisma.profileSnapshot.findMany({
      where: { minecraftAccount: { uuid: minecraftUuid }, captureDate: { gte: since } },
      orderBy: [{ captureDate: "asc" }, { seq: "asc" }],
      select: {
        captureDate: true,
        skyblockLevel: true,
        networth: true,
        skillAverage: true,
        catacombsLevel: true,
      },
    });
    return rows.map((r) => ({
      // Date-only column: the ISO day is the whole meaning of the bucket.
      captureDate: r.captureDate.toISOString().slice(0, 10),
      skyblockLevel: r.skyblockLevel,
      networth: toNumber(r.networth),
      skillAverage: r.skillAverage,
      catacombsLevel: r.catacombsLevel,
    }));
  },

  async latestSnapshot(minecraftUuid: string) {
    // Newest by capture time, not by day bucket: the event-tracked cohort writes
    // several rows per day and the last one is the current reading.
    const row = await prisma.profileSnapshot.findFirst({
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
