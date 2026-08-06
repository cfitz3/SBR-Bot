/**
 * Small Prisma-backed adapters: role resolution, guild id resolution, and the
 * worker job-log sink. Satisfy the RoleResolver / RankResolver (moderation,
 * commands-admin, panel-core) and JobLogSink (jobs) ports.
 */
import type { MemberRole } from "@sbr/shared-types";
import { prisma } from "../client.js";

/** getRole(internalGuildId, discordId) → platform role (defaults MEMBER). */
export const rankResolver = {
  async getRole(guildId: string, discordId: string): Promise<MemberRole> {
    const member = await prisma.guildMember.findFirst({
      where: { guildId, discordUser: { discordId } },
      select: { role: true },
    });
    return (member?.role as MemberRole | undefined) ?? "MEMBER";
  },
};

/** Resolve a Discord guild snowflake to the internal Guild.id. */
export const guildRepository = {
  async resolveInternalId(discordGuildId: string): Promise<string | null> {
    const guild = await prisma.guild.findUnique({ where: { discordGuildId }, select: { id: true } });
    return guild?.id ?? null;
  },
};

export interface WorkerJobLogEntry {
  queue: string;
  type: string;
  status: string;
  attempts: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  error?: string;
}

/** JobLogSink — persists a WorkerJobLog row on job completion/failure. */
export const workerJobLogSink = {
  async record(entry: WorkerJobLogEntry): Promise<void> {
    await prisma.workerJobLog.create({
      data: {
        queue: entry.queue,
        type: entry.type,
        status: entry.status as "COMPLETED" | "FAILED",
        attempts: entry.attempts,
        startedAt: new Date(entry.startedAt),
        finishedAt: new Date(entry.finishedAt),
        durationMs: entry.durationMs,
        error: entry.error ?? null,
      },
    });
  },
};
