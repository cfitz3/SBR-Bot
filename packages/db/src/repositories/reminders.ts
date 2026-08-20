/**
 * Reminder storage.
 *
 * Every write is scoped by `(guildId, discordId)` rather than by id alone. Ids
 * are handed to the member who owns the reminder and are guessable enough that
 * "cancel by id" without an owner check would let one typo cancel somebody
 * else's note to themselves.
 */
import type { ReminderDTO, ReminderPort } from "@sbr/shared-types";
import { prisma } from "../client.js";

interface Row {
  readonly id: string;
  readonly guildId: string;
  readonly discordId: string;
  readonly channelId: string;
  readonly text: string;
  readonly dueAt: Date;
}

function toDTO(row: Row): ReminderDTO {
  return {
    id: row.id,
    guildId: row.guildId,
    discordId: row.discordId,
    channelId: row.channelId,
    text: row.text,
    dueAt: row.dueAt.toISOString(),
  };
}

export const reminderRepository: ReminderPort = {
  async create(input): Promise<ReminderDTO> {
    const row = await prisma.reminder.create({
      data: {
        guildId: input.guildId,
        discordId: input.discordId,
        channelId: input.channelId,
        text: input.text,
        dueAt: input.dueAt,
      },
    });
    return toDTO(row);
  },

  async listDue(now: Date, limit: number): Promise<readonly ReminderDTO[]> {
    const rows = await prisma.reminder.findMany({
      where: { delivered: false, dueAt: { lte: now } },
      orderBy: { dueAt: "asc" },
      take: limit,
    });
    return rows.map(toDTO);
  },

  async markDelivered(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await prisma.reminder.updateMany({
      where: { id: { in: [...ids] } },
      data: { delivered: true },
    });
    return count;
  },

  async listPendingFor(guildId: string, discordId: string): Promise<readonly ReminderDTO[]> {
    const rows = await prisma.reminder.findMany({
      where: { guildId, discordId, delivered: false },
      orderBy: { dueAt: "asc" },
    });
    return rows.map(toDTO);
  },

  async cancel(guildId: string, discordId: string, id: string): Promise<boolean> {
    // Deleted rather than flagged delivered: a cancelled reminder is not one
    // that fired, and leaving it in the table would make the two indistinguishable.
    const { count } = await prisma.reminder.deleteMany({
      where: { id, guildId, discordId, delivered: false },
    });
    return count > 0;
  },

  async countPendingFor(guildId: string, discordId: string): Promise<number> {
    return prisma.reminder.count({ where: { guildId, discordId, delivered: false } });
  },
};
