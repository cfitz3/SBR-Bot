/**
 * Milestone definitions: what a guild has chosen to recognise.
 *
 * The built-in defaults in `@sbr/jobs` are the baseline, and a guild's rows are
 * layered over them by key — so this repository never stores the thirty
 * defaults, and a guild that has configured nothing has no rows at all. That
 * matters for upgrades: adding a default later reaches every guild, instead of
 * only the ones seeded after the change.
 */
import type {
  MilestoneAnnouncerPort,
  MilestoneDefinitionDTO,
  MilestoneDefinitionInput,
  MilestoneType,
  PendingMilestoneDTO,
} from "@sbr/shared-types";
import {
  DEFAULT_MILESTONE_DEFINITIONS,
  isMilestoneMetric,
  type MilestoneDefinition,
} from "@sbr/jobs";
import { prisma } from "../client.js";

/** A stored row as the detector wants it. */
function toDefinition(row: {
  id: string;
  key: string;
  label: string;
  type: string;
  metric: string;
  threshold: bigint;
  xpReward: number;
  announce: boolean;
  enabled: boolean;
}): MilestoneDefinition | null {
  // A metric the detector does not know can never fire, and silently keeping it
  // in the resolved set would make it look configured. Dropped here, where the
  // untrusted string crosses back into typed code.
  if (!isMilestoneMetric(row.metric)) return null;
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    type: row.type as MilestoneDefinition["type"],
    metric: row.metric,
    threshold: Number(row.threshold),
    xpReward: row.xpReward,
    announce: row.announce,
    enabled: row.enabled,
  };
}

const SELECT = {
  id: true,
  key: true,
  label: true,
  description: true,
  type: true,
  metric: true,
  threshold: true,
  xpReward: true,
  announce: true,
  enabled: true,
} as const;

export const milestoneDefinitionRepository = {
  /**
   * A guild's own rows, for the detector. The caller passes these to
   * `resolveDefinitions`, which is what applies them over the defaults — the
   * merge lives in the domain package so it is testable without a database.
   */
  async listForDetection(guildId: string): Promise<readonly MilestoneDefinition[]> {
    const rows = await prisma.milestoneDefinition.findMany({ where: { guildId }, select: SELECT });
    return rows.map(toDefinition).filter((d): d is MilestoneDefinition => d !== null);
  },

  /**
   * Everything in effect, defaults included, for the panel.
   *
   * Disabled rows are kept and flagged rather than filtered: the panel has to
   * render the switch it can turn back on, and a default a guild has switched
   * off would otherwise reappear as if it were still active.
   */
  async list(guildId: string): Promise<readonly MilestoneDefinitionDTO[]> {
    const rows = await prisma.milestoneDefinition.findMany({
      where: { guildId },
      select: SELECT,
      orderBy: { key: "asc" },
    });
    const stored = new Map(rows.map((r) => [r.key, r]));

    const out: MilestoneDefinitionDTO[] = [];
    for (const d of DEFAULT_MILESTONE_DEFINITIONS) {
      const row = stored.get(d.key);
      out.push(
        row === undefined
          ? {
              id: null,
              guildId,
              key: d.key,
              label: d.label,
              description: null,
              type: d.type,
              metric: d.metric,
              threshold: d.threshold,
              xpReward: d.xpReward,
              announce: d.announce,
              enabled: d.enabled,
              source: "DEFAULT",
            }
          : rowToDto(guildId, row),
      );
      stored.delete(d.key);
    }
    // Whatever is left is a guild's own invention, listed after the defaults.
    for (const row of stored.values()) out.push(rowToDto(guildId, row));
    return out;
  },

  /** Create or update by `(guildId, key)`. Editing a default shadows it. */
  async upsert(guildId: string, input: MilestoneDefinitionInput): Promise<MilestoneDefinitionDTO> {
    const data = {
      label: input.label,
      description: input.description ?? null,
      type: input.type as MilestoneType,
      metric: input.metric,
      threshold: BigInt(Math.round(input.threshold)),
      xpReward: input.xpReward,
      announce: input.announce,
      enabled: input.enabled,
    };
    const row = await prisma.milestoneDefinition.upsert({
      where: { guildId_key: { guildId, key: input.key } },
      create: { guildId, key: input.key, ...data },
      update: data,
      select: SELECT,
    });
    return rowToDto(guildId, row);
  },

  /**
   * Drop a guild's row. A shadowed default reverts to the built-in; a purely
   * custom definition disappears. Recorded milestones survive either way — the
   * FK is SET NULL, because deleting the definition does not unmake the fact
   * that someone reached it.
   */
  async remove(guildId: string, key: string): Promise<boolean> {
    const { count } = await prisma.milestoneDefinition.deleteMany({ where: { guildId, key } });
    return count > 0;
  },
};

/**
 * The announcement queue.
 *
 * Rows detected against a built-in default carry no `definitionId`, so their
 * label is recovered from the defaults by `(metric, threshold)` — the same pair
 * the unique constraint uses. A row that matches nothing (a definition deleted
 * after detection, a threshold since edited) falls back to a plain description
 * rather than being skipped: something was achieved, and saying it awkwardly
 * beats never saying it.
 */
export const milestoneAnnouncementRepository: MilestoneAnnouncerPort = {
  async listPending(limit: number, excludeGuildIds: readonly string[] = []): Promise<readonly PendingMilestoneDTO[]> {
    const rows = await prisma.milestone.findMany({
      // Guild-less rows have nowhere to be posted. They stay unannounced rather
      // than being marked done, so linking the account later can still surface
      // them if we ever choose to. The exclusion list is the same idea for
      // guilds that have a home but have not bound a channel to it.
      where: {
        announced: false,
        guildId: excludeGuildIds.length === 0 ? { not: null } : { not: null, notIn: [...excludeGuildIds] },
      },
      orderBy: { achievedAt: "asc" },
      take: limit,
      select: {
        id: true,
        guildId: true,
        discordId: true,
        type: true,
        metric: true,
        thresholdValue: true,
        achievedAt: true,
        definition: { select: { label: true } },
        minecraftAccount: { select: { currentIgn: true } },
      },
    });

    return rows.map((row) => {
      const threshold = Number(row.thresholdValue);
      const fallback = DEFAULT_MILESTONE_DEFINITIONS.find(
        (d) => d.metric === row.metric && d.threshold === threshold,
      );
      return {
        id: row.id,
        guildId: row.guildId as string,
        discordId: row.discordId,
        ign: row.minecraftAccount.currentIgn,
        label: row.definition?.label ?? fallback?.label ?? `${row.metric} ${threshold.toLocaleString("en-US")}`,
        type: row.type as MilestoneType,
        metric: row.metric,
        thresholdValue: threshold,
        achievedAt: row.achievedAt.toISOString(),
      };
    });
  },

  async markAnnounced(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await prisma.milestone.updateMany({
      where: { id: { in: [...ids] } },
      data: { announced: true },
    });
    return count;
  },
};

function rowToDto(
  guildId: string,
  row: {
    id: string;
    key: string;
    label: string;
    description: string | null;
    type: string;
    metric: string;
    threshold: bigint;
    xpReward: number;
    announce: boolean;
    enabled: boolean;
  },
): MilestoneDefinitionDTO {
  return {
    id: row.id,
    guildId,
    key: row.key,
    label: row.label,
    description: row.description,
    type: row.type as MilestoneType,
    metric: row.metric,
    threshold: Number(row.threshold),
    xpReward: row.xpReward,
    announce: row.announce,
    enabled: row.enabled,
    source: "GUILD",
  };
}
