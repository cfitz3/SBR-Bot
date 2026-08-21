/**
 * Prisma-backed GoalRepository (satisfies the @sbr/shared-types port).
 *
 * Split from `progression.ts` because the port is: goal storage is optional in
 * a way snapshot history is not, and a deployment that has not run the
 * migration should be able to leave this unwired without the charting half
 * noticing.
 *
 * Keyed by Minecraft UUID on the way in, like every other progression read —
 * that is what the command layer holds — and resolved to the internal account
 * id here so the foreign key can do its job.
 */
import type { GoalRepository, ProgressMetric, StoredGoalDTO } from "@sbr/shared-types";
import { prisma } from "../client.js";

/** BigInt columns exceed Number.MAX_SAFE_INTEGER only past ~9 quadrillion coins. */
function toNumber(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

type Row = {
  id: string;
  guildId: string;
  discordId: string | null;
  metric: string;
  target: bigint;
  startValue: bigint | null;
  createdAt: Date;
  achievedAt: Date | null;
  minecraftAccount: { uuid: string };
};

function toDTO(row: Row): StoredGoalDTO {
  return {
    id: row.id,
    guildId: row.guildId,
    minecraftUuid: row.minecraftAccount.uuid,
    discordId: row.discordId,
    // Written by the service from a `ProgressMetric`, and the column is a plain
    // string because Prisma enums and TypeScript unions drift independently.
    metric: row.metric as ProgressMetric,
    target: Number(row.target),
    startValue: toNumber(row.startValue),
    createdAt: row.createdAt.toISOString(),
    achievedAt: row.achievedAt?.toISOString() ?? null,
  };
}

const SELECT = {
  id: true,
  guildId: true,
  discordId: true,
  metric: true,
  target: true,
  startValue: true,
  createdAt: true,
  achievedAt: true,
  minecraftAccount: { select: { uuid: true } },
} as const;

export const goalRepository: GoalRepository = {
  async setGoal(input): Promise<StoredGoalDTO> {
    const account = await prisma.minecraftAccount.findUnique({
      where: { uuid: input.minecraftUuid },
      select: { id: true },
    });
    // Every caller reaches here through a verified link, which is what creates
    // the account row. Throwing rather than returning null keeps the port's
    // signature honest: this is a broken invariant, not a member-visible state.
    if (!account) throw new Error(`no Minecraft account for ${input.minecraftUuid}`);

    // The most recent verified link, so an announcement can name a Discord user
    // without resolving one later. Null for a member linked under an account
    // that has since been unlinked — the goal still works, it just goes unnamed.
    const link = await prisma.linkedAccount.findFirst({
      where: { minecraftAccountId: account.id, status: "VERIFIED" },
      orderBy: [{ isPrimary: "desc" }, { verifiedAt: "desc" }],
      select: { discordUserId: true },
    });

    const target = BigInt(Math.trunc(input.target));
    const startValue = input.startValue === null ? null : BigInt(Math.trunc(input.startValue));

    const row = await prisma.progressionGoal.upsert({
      where: {
        guildId_minecraftAccountId_metric: {
          guildId: input.guildId,
          minecraftAccountId: account.id,
          metric: input.metric,
        },
      },
      create: {
        guildId: input.guildId,
        minecraftAccountId: account.id,
        discordId: link?.discordUserId ?? null,
        metric: input.metric,
        target,
        startValue,
      },
      update: {
        target,
        startValue,
        discordId: link?.discordUserId ?? null,
        // Re-aiming an achieved goal makes it outstanding again. The record of
        // having reached the old one is the Milestone row, not this column.
        achievedAt: null,
      },
      select: SELECT,
    });
    return toDTO(row);
  },

  async listGoals(guildId: string, minecraftUuid: string): Promise<readonly StoredGoalDTO[]> {
    const rows = await prisma.progressionGoal.findMany({
      where: { guildId, minecraftAccount: { uuid: minecraftUuid } },
      orderBy: { createdAt: "asc" },
      select: SELECT,
    });
    return rows.map(toDTO);
  },

  async clearGoal(guildId: string, minecraftUuid: string, metric: ProgressMetric): Promise<boolean> {
    const { count } = await prisma.progressionGoal.deleteMany({
      where: { guildId, metric, minecraftAccount: { uuid: minecraftUuid } },
    });
    return count > 0;
  },

  async listUnachieved(limit: number, afterId?: string): Promise<readonly StoredGoalDTO[]> {
    const rows = await prisma.progressionGoal.findMany({
      where: { achievedAt: null, ...(afterId === undefined ? {} : { id: { gt: afterId } }) },
      // By id, matching the index and giving the caller a stable cursor. Ordering
      // by createdAt would let two rows share a key and repeat across pages.
      orderBy: { id: "asc" },
      take: limit,
      select: SELECT,
    });
    return rows.map(toDTO);
  },

  async markAchieved(ids: readonly string[], at: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await prisma.progressionGoal.updateMany({
      // `achievedAt: null` in the filter is what makes a double-run announce
      // once: the second pass matches nothing and reports zero rows changed.
      where: { id: { in: [...ids] }, achievedAt: null },
      data: { achievedAt: at },
    });
    return count;
  },
};
