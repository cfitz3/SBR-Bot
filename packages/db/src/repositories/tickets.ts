/**
 * Ticket rows and the transcript store.
 *
 * Two things here are worth knowing before reading:
 *
 * 1. **`number` is allocated, not auto-incremented.** It is per guild, so it
 *    cannot be a database sequence, and it is what members and staff call a
 *    ticket out loud — a cuid is unusable for that. Allocation reads the
 *    current maximum and retries on the unique violation, which is the correct
 *    behaviour under concurrency and needs no advisory lock.
 * 2. **Messages are never deleted.** An edit or a delete in Discord stamps the
 *    row; the content stays. A transcript that silently loses a deleted message
 *    is worse than no transcript, because it reads as a complete record of a
 *    conversation that did not happen that way.
 */
import type {
  TicketAttachmentDTO,
  TicketDTO,
  TicketMessageDTO,
  TicketStatus,
} from "@sbr/shared-types";
import type { TicketPatch } from "@sbr/community";
import { Prisma } from "@prisma/client";
import { prisma } from "../client.js";

/** The ticket columns every mapper needs, plus the category's display fields. */
export const TICKET_SELECT = {
  id: true,
  guildId: true,
  number: true,
  openerDiscordId: true,
  assigneeDiscordId: true,
  categoryId: true,
  status: true,
  channelId: true,
  subject: true,
  topic: true,
  claimedByDiscordId: true,
  claimedAt: true,
  closeRequestedByDiscordId: true,
  closeRequestedAt: true,
  lastMessageAt: true,
  firstStaffReplyAt: true,
  feedbackRating: true,
  transcriptReady: true,
  closeReason: true,
  createdAt: true,
  closedAt: true,
  category: { select: { key: true, name: true } },
} as const;

export type TicketRecord = {
  id: string;
  guildId: string;
  number: number;
  openerDiscordId: string;
  assigneeDiscordId: string | null;
  categoryId: string | null;
  status: string;
  channelId: string | null;
  subject: string | null;
  topic: string | null;
  claimedByDiscordId: string | null;
  claimedAt: Date | null;
  closeRequestedByDiscordId: string | null;
  closeRequestedAt: Date | null;
  lastMessageAt: Date | null;
  firstStaffReplyAt: Date | null;
  feedbackRating: number | null;
  transcriptReady: boolean;
  closeReason: string | null;
  createdAt: Date;
  closedAt: Date | null;
  category: { key: string; name: string } | null;
};

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function toTicketDTO(row: TicketRecord): TicketDTO {
  return {
    id: row.id,
    guildId: row.guildId,
    number: row.number,
    openerDiscordId: row.openerDiscordId,
    assigneeDiscordId: row.assigneeDiscordId,
    categoryId: row.categoryId,
    categoryKey: row.category?.key ?? null,
    categoryName: row.category?.name ?? null,
    status: row.status as TicketStatus,
    channelId: row.channelId,
    subject: row.subject,
    topic: row.topic,
    claimedByDiscordId: row.claimedByDiscordId,
    claimedAt: iso(row.claimedAt),
    closeRequestedByDiscordId: row.closeRequestedByDiscordId,
    closeRequestedAt: iso(row.closeRequestedAt),
    lastMessageAt: iso(row.lastMessageAt),
    firstStaffReplyAt: iso(row.firstStaffReplyAt),
    feedbackRating: row.feedbackRating,
    transcriptReady: row.transcriptReady,
    closeReason: row.closeReason,
    createdAt: row.createdAt.toISOString(),
    closedAt: iso(row.closedAt),
  };
}

function toAttachments(value: Prisma.JsonValue): readonly TicketAttachmentDTO[] {
  if (!Array.isArray(value)) return [];
  const out: TicketAttachmentDTO[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row["name"] !== "string" || typeof row["url"] !== "string") continue;
    out.push({
      name: row["name"],
      size: typeof row["size"] === "number" ? row["size"] : 0,
      contentType: typeof row["contentType"] === "string" ? row["contentType"] : null,
      url: row["url"],
    });
  }
  return out;
}

/** How many times allocation retries a colliding `number` before giving up. */
const NUMBER_ATTEMPTS = 5;

export interface TicketInsert {
  readonly guildId: string;
  readonly openerDiscordId: string;
  readonly categoryId: string | null;
  readonly topic: string | null;
  readonly answers: Readonly<Record<string, string>>;
  readonly channelId: string | null;
}

export interface TicketMessageInsert {
  readonly ticketId: string;
  readonly discordMessageId: string;
  readonly authorDiscordId: string;
  readonly authorTag: string;
  readonly content: string;
  readonly attachments: readonly TicketAttachmentDTO[];
  readonly createdAt: Date;
}

export const ticketRepository = {
  /**
   * Insert with the next per-guild `number`.
   *
   * Two members clicking the same panel button in the same second race for the
   * same number; the loser sees a unique violation and takes the next one. That
   * is cheaper and less deadlock-prone than serialising every ticket creation
   * in a guild behind a lock.
   */
  async create(input: TicketInsert): Promise<TicketDTO> {
    for (let attempt = 0; attempt < NUMBER_ATTEMPTS; attempt += 1) {
      const highest = await prisma.ticket.findFirst({
        where: { guildId: input.guildId },
        orderBy: { number: "desc" },
        select: { number: true },
      });
      const number = (highest?.number ?? 0) + 1;
      try {
        const row = await prisma.ticket.create({
          data: {
            guildId: input.guildId,
            number,
            openerDiscordId: input.openerDiscordId,
            categoryId: input.categoryId,
            topic: input.topic,
            answers: input.answers as unknown as Prisma.InputJsonValue,
            channelId: input.channelId,
          },
          select: TICKET_SELECT,
        });
        return toTicketDTO(row);
      } catch (error) {
        const collided =
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
        if (!collided || attempt === NUMBER_ATTEMPTS - 1) throw error;
      }
    }
    // Unreachable: the loop either returns or rethrows on its final attempt.
    throw new Error("ticket number allocation exhausted");
  },

  async byId(ticketId: string): Promise<TicketDTO | null> {
    const row = await prisma.ticket.findUnique({ where: { id: ticketId }, select: TICKET_SELECT });
    return row === null ? null : toTicketDTO(row);
  },

  /** The most recent ticket bound to a channel — channels are reused after a purge. */
  async byChannel(channelId: string): Promise<TicketDTO | null> {
    const row = await prisma.ticket.findFirst({
      where: { channelId },
      orderBy: { createdAt: "desc" },
      select: TICKET_SELECT,
    });
    return row === null ? null : toTicketDTO(row);
  },

  /**
   * Apply a patch. Absent fields are left alone — the patch is built by
   * `@sbr/tickets`, which has already decided the transition is allowed.
   */
  async patch(ticketId: string, patch: TicketPatch): Promise<TicketDTO | null> {
    const data: Prisma.TicketUpdateInput = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.assigneeDiscordId !== undefined) data.assigneeDiscordId = patch.assigneeDiscordId;
    if (patch.claimedByDiscordId !== undefined) data.claimedByDiscordId = patch.claimedByDiscordId;
    if (patch.claimedAt !== undefined) data.claimedAt = patch.claimedAt;
    if (patch.closeRequestedByDiscordId !== undefined) {
      data.closeRequestedByDiscordId = patch.closeRequestedByDiscordId;
    }
    if (patch.closeRequestedAt !== undefined) data.closeRequestedAt = patch.closeRequestedAt;
    if (patch.topic !== undefined) data.topic = patch.topic;
    if (patch.closeReason !== undefined) data.closeReason = patch.closeReason;
    if (patch.closedAt !== undefined) data.closedAt = patch.closedAt;
    if (patch.lastMessageAt !== undefined) data.lastMessageAt = patch.lastMessageAt;
    if (patch.firstStaffReplyAt !== undefined) data.firstStaffReplyAt = patch.firstStaffReplyAt;
    if (patch.transcriptReady !== undefined) data.transcriptReady = patch.transcriptReady;

    const row = await prisma.ticket
      .update({ where: { id: ticketId }, data, select: TICKET_SELECT })
      .catch(() => null);
    return row === null ? null : toTicketDTO(row);
  },

  /** Bind a freshly created Discord channel to the ticket it was made for. */
  async bindChannel(ticketId: string, channelId: string): Promise<void> {
    await prisma.ticket.update({ where: { id: ticketId }, data: { channelId } }).catch(() => null);
  },

  /** Open tickets, newest first. `openerDiscordId` narrows it to one member's. */
  async listOpen(guildId: string, openerDiscordId?: string, limit = 25): Promise<readonly TicketDTO[]> {
    const rows = await prisma.ticket.findMany({
      where: {
        guildId,
        status: { in: ["OPEN", "PENDING"] },
        ...(openerDiscordId === undefined ? {} : { openerDiscordId }),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: TICKET_SELECT,
    });
    return rows.map(toTicketDTO);
  },

  /** Every ticket a member has ever opened — the panel's member card. */
  async listByOpener(guildId: string, openerDiscordId: string, limit = 50): Promise<readonly TicketDTO[]> {
    const rows = await prisma.ticket.findMany({
      where: { guildId, openerDiscordId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: TICKET_SELECT,
    });
    return rows.map(toTicketDTO);
  },

  /**
   * Tickets the sweep should consider: everything still open in the guild.
   *
   * The decision itself is `sweep()` in `@sbr/tickets` — this only narrows the
   * set, because "which tickets are stale" is a rule and rules do not live in
   * SQL where they cannot be tested.
   */
  async listSweepable(guildId: string, limit = 200): Promise<readonly TicketDTO[]> {
    const rows = await prisma.ticket.findMany({
      where: { guildId, status: { in: ["OPEN", "PENDING"] } },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: TICKET_SELECT,
    });
    return rows.map(toTicketDTO);
  },

  // ── transcript ────────────────────────────────────────────────────────────

  /**
   * Record a message, and stamp the ticket's clocks in the same call.
   *
   * `firstStaffReplyAt` is only ever set once, and only by a non-opener: it is
   * the input to `{avgResponseTime}`, and a second write would make a long wait
   * look short.
   */
  async recordMessage(input: TicketMessageInsert, fromStaff: boolean): Promise<void> {
    await prisma.ticketMessage.upsert({
      where: {
        ticketId_discordMessageId: {
          ticketId: input.ticketId,
          discordMessageId: input.discordMessageId,
        },
      },
      create: {
        ticketId: input.ticketId,
        discordMessageId: input.discordMessageId,
        authorDiscordId: input.authorDiscordId,
        authorTag: input.authorTag,
        content: input.content,
        attachments: input.attachments as unknown as Prisma.InputJsonValue,
        createdAt: input.createdAt,
      },
      update: { content: input.content, editedAt: input.createdAt },
    });

    await prisma.ticket.update({ where: { id: input.ticketId }, data: { lastMessageAt: input.createdAt } });
    if (fromStaff) {
      // Conditional on the column still being null, so the *first* reply wins
      // even if two staff answer at once.
      await prisma.ticket.updateMany({
        where: { id: input.ticketId, firstStaffReplyAt: null },
        data: { firstStaffReplyAt: input.createdAt },
      });
    }
  },

  async markMessageEdited(discordMessageId: string, content: string, at: Date): Promise<void> {
    await prisma.ticketMessage.updateMany({
      where: { discordMessageId },
      data: { content, editedAt: at },
    });
  },

  async markMessageDeleted(discordMessageId: string, at: Date): Promise<void> {
    await prisma.ticketMessage.updateMany({ where: { discordMessageId }, data: { deletedAt: at } });
  },

  /** The transcript, oldest first — deleted messages included and flagged. */
  async listMessages(ticketId: string, limit = 2000): Promise<readonly TicketMessageDTO[]> {
    const rows = await prisma.ticketMessage.findMany({
      where: { ticketId },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      authorDiscordId: r.authorDiscordId,
      authorTag: r.authorTag,
      content: r.content,
      attachments: toAttachments(r.attachments),
      editedAt: iso(r.editedAt),
      deletedAt: iso(r.deletedAt),
      createdAt: r.createdAt.toISOString(),
    }));
  },

  /** Messages captured since a close request — the "conversation resumed" count. */
  async countMessagesSince(ticketId: string, since: Date): Promise<number> {
    return prisma.ticketMessage.count({ where: { ticketId, createdAt: { gt: since } } });
  },
};
