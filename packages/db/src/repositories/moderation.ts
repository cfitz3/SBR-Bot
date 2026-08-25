/**
 * Prisma-backed ModerationRepository (satisfies the @sbr/moderation port).
 * `guildId` here is the internal Guild.id (cuid); the composition layer resolves
 * a Discord guild id to it via guildRepository.
 */
import type {
  AuditQuery,
  EnforcementStatus,
  InfractionDTO,
  ModActionType,
  ModerationActionDTO,
  ModerationSurface,
} from "@sbr/shared-types";
import { prisma } from "../client.js";

interface NewActionRecord {
  guildId: string;
  infractionId: string | null;
  type: ModActionType;
  actorDiscordId: string;
  targetDiscordId: string | null;
  targetMinecraftUuid: string | null;
  reason: string;
  durationSeconds: number | null;
  expiresAt: string | null;
  surfaces: readonly ModerationSurface[];
  active: boolean;
  /** Defaults to DISCORD; only the bridge writes INGAME. Mirrors `@sbr/moderation`'s port. */
  sourceContext?: "BRIDGE" | "DISCORD" | "INGAME";
}

type InfractionRow = {
  id: string;
  guildId: string;
  targetDiscordId: string | null;
  type: string;
  severity: string;
  reason: string;
  createdAt: Date;
};

type ActionRow = {
  id: string;
  guildId: string;
  type: string;
  actorDiscordId: string;
  targetDiscordId: string | null;
  reason: string;
  durationSeconds: number | null;
  expiresAt: Date | null;
  surfaces: string[];
  active: boolean;
  enforcement: string;
  enforcementDetail: string | null;
  createdAt: Date;
};

function mapInfraction(r: InfractionRow): InfractionDTO {
  return {
    id: r.id,
    guildId: r.guildId,
    targetDiscordId: r.targetDiscordId,
    type: r.type as InfractionDTO["type"],
    severity: r.severity as InfractionDTO["severity"],
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  };
}

function mapAction(r: ActionRow): ModerationActionDTO {
  return {
    id: r.id,
    guildId: r.guildId,
    type: r.type as ModerationActionDTO["type"],
    actorDiscordId: r.actorDiscordId,
    targetDiscordId: r.targetDiscordId,
    reason: r.reason,
    durationSeconds: r.durationSeconds,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    surfaces: r.surfaces as ModerationSurface[],
    active: r.active,
    enforcement: r.enforcement as EnforcementStatus,
    enforcementDetail: r.enforcementDetail,
    createdAt: r.createdAt.toISOString(),
  };
}

export const moderationRepository = {
  async createInfraction(input: Omit<InfractionDTO, "id" | "createdAt">): Promise<InfractionDTO> {
    const row = await prisma.infraction.create({
      data: {
        guildId: input.guildId,
        targetDiscordId: input.targetDiscordId,
        type: input.type,
        severity: input.severity,
        reason: input.reason,
      },
    });
    return mapInfraction(row);
  },

  async createAction(input: NewActionRecord): Promise<ModerationActionDTO> {
    const row = await prisma.moderationAction.create({
      data: {
        guildId: input.guildId,
        infractionId: input.infractionId,
        type: input.type,
        actorDiscordId: input.actorDiscordId,
        targetDiscordId: input.targetDiscordId,
        reason: input.reason,
        durationSeconds: input.durationSeconds,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        surfaces: [...input.surfaces],
        active: input.active,
        sourceContext: input.sourceContext ?? "DISCORD",
        // Born PENDING on purpose. The service stamps the verdict once both
        // surfaces have answered, so a process that dies mid-enforcement leaves
        // a row that says so rather than one that looks finished.
        enforcement: "PENDING",
      },
    });
    return mapAction(row);
  },

  async listInfractions(guildId: string, discordId: string): Promise<readonly InfractionDTO[]> {
    const rows = await prisma.infraction.findMany({
      where: { guildId, targetDiscordId: discordId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(mapInfraction);
  },

  async listRecentInfractions(guildId: string, limit: number): Promise<readonly InfractionDTO[]> {
    const rows = await prisma.infraction.findMany({
      where: { guildId },
      orderBy: { createdAt: "desc" },
      // Clamped here as well as at the caller: this is the one query on the
      // table with no target narrowing it, so an unbounded limit reaching it
      // would be a full scan of every infraction the guild has ever recorded.
      take: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map(mapInfraction);
  },

  /**
   * `/audit`. Filters are additive and each is applied only when supplied, so
   * an officer opening the log with no arguments sees everything recent.
   */
  async listActions(query: AuditQuery): Promise<readonly ModerationActionDTO[]> {
    const where: Record<string, unknown> = { guildId: query.guildId };
    if (query.actorDiscordId) where.actorDiscordId = query.actorDiscordId;
    if (query.targetDiscordId) where.targetDiscordId = query.targetDiscordId;
    if (query.type) where.type = query.type;
    if (query.sinceDays && query.sinceDays > 0) {
      where.createdAt = { gte: new Date(Date.now() - query.sinceDays * 24 * 60 * 60 * 1000) };
    }
    if (query.inForceOnly) {
      // Time-filtered here rather than after the fact: `take` would otherwise
      // spend its budget on rows that are about to be dropped, and a page of
      // "still in force" could come back half empty.
      where.active = true;
      where.type = query.type ?? { in: ["MUTE", "BAN"] };
      where.OR = [{ expiresAt: null }, { expiresAt: { gt: new Date() } }];
    }
    const rows = await prisma.moderationAction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(query.limit ?? 100, 500),
    });
    return rows.map(mapAction);
  },

  /**
   * The expiry sweep. Only rows that hold enforcement are touched: a kick is
   * flagged active forever because nothing lifts one, and clearing that flag
   * would rewrite history to say somebody did.
   */
  async deactivateExpired(guildId: string | null, now: Date): Promise<number> {
    const result = await prisma.moderationAction.updateMany({
      where: {
        ...(guildId === null ? {} : { guildId }),
        active: true,
        type: { in: ["MUTE", "BAN"] },
        expiresAt: { not: null, lte: now },
      },
      data: { active: false },
    });
    return result.count;
  },

  async setEnforcement(actionId: string, status: EnforcementStatus, detail: string | null): Promise<void> {
    await prisma.moderationAction.update({
      where: { id: actionId },
      data: { enforcement: status, enforcementDetail: detail },
    });
  },

  /**
   * Rows the expiry sweep has to *reverse* rather than merely un-flag.
   *
   * `deactivateExpired` clears the flag in one statement and returns a count,
   * which is right for bookkeeping and useless for lifting: a temp-banned member
   * whose row flipped to inactive is still banned on Discord. The sweep needs
   * the rows themselves to know who to unban, so it reads them first and clears
   * the flag per row as each reversal lands.
   */
  async listExpiredActive(
    guildId: string | null,
    now: Date,
    limit: number,
  ): Promise<readonly ModerationActionDTO[]> {
    const rows = await prisma.moderationAction.findMany({
      where: {
        ...(guildId === null ? {} : { guildId }),
        active: true,
        type: { in: ["MUTE", "BAN"] },
        expiresAt: { not: null, lte: now },
      },
      orderBy: { expiresAt: "asc" },
      take: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map(mapAction);
  },

  async findAction(guildId: string, actionId: string): Promise<ModerationActionDTO | null> {
    const row = await prisma.moderationAction.findFirst({ where: { id: actionId, guildId } });
    return row === null ? null : mapAction(row);
  },
};
