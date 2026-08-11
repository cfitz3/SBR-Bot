/**
 * Ticket configuration: the panel a guild posts, and the types it offers.
 *
 * As with milestone definitions, the built-in types in `@sbr/community` are the
 * baseline and a guild's rows are layered over them by key — so a guild that has
 * configured nothing stores nothing, and a built-in added later reaches every
 * guild rather than only the ones set up after the change. The merge itself
 * lives in the domain package, where it is testable without a database.
 */
import type {
  TicketPanelConfigDTO,
  TicketPanelConfigInput,
  TicketTypeDTO,
  TicketTypeInput,
} from "@sbr/shared-types";
import { resolveTicketTypes, type StoredTicketType } from "@sbr/community";
import type { TicketCategory } from "@prisma/client";
import { prisma } from "../client.js";

const TYPE_SELECT = {
  id: true,
  key: true,
  label: true,
  emoji: true,
  category: true,
  parentChannelId: true,
  staffRoleIds: true,
  prompt: true,
  position: true,
  enabled: true,
} as const;

type TypeRow = {
  id: string;
  key: string;
  label: string;
  emoji: string | null;
  category: TicketCategory;
  parentChannelId: string | null;
  staffRoleIds: string[];
  prompt: string | null;
  position: number;
  enabled: boolean;
};

function toStored(row: TypeRow): StoredTicketType {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    emoji: row.emoji,
    category: row.category,
    parentChannelId: row.parentChannelId,
    staffRoleIds: row.staffRoleIds,
    prompt: row.prompt,
    position: row.position,
    enabled: row.enabled,
  };
}

export const ticketConfigRepository = {
  /**
   * Every type in effect for a guild, defaults included, in menu order.
   *
   * Disabled entries are included and flagged; filtering them is the caller's
   * job, because the panel needs to render the switch it can turn back on.
   */
  async listTypes(guildId: string): Promise<readonly TicketTypeDTO[]> {
    const rows = await prisma.ticketTypeConfig.findMany({ where: { guildId }, select: TYPE_SELECT });
    return resolveTicketTypes(guildId, rows.map(toStored));
  },

  /** Create or update by `(guildId, key)`. Editing a built-in shadows it. */
  async upsertType(guildId: string, input: TicketTypeInput): Promise<TicketTypeDTO> {
    const data = {
      label: input.label,
      emoji: input.emoji,
      category: input.category as TicketCategory,
      parentChannelId: input.parentChannelId,
      staffRoleIds: [...input.staffRoleIds],
      prompt: input.prompt,
      position: input.position,
      enabled: input.enabled,
    };
    const row = await prisma.ticketTypeConfig.upsert({
      where: { guildId_key: { guildId, key: input.key } },
      create: { guildId, key: input.key, ...data },
      update: data,
      select: TYPE_SELECT,
    });
    // Resolved through the same merge so the returned row is ordered and
    // labelled exactly as the list the panel just refreshed.
    const merged = resolveTicketTypes(guildId, [toStored(row)]);
    return merged.find((t) => t.key === input.key) as TicketTypeDTO;
  },

  /**
   * Drop a guild's row. A shadowed built-in reverts to its default; a purely
   * custom type disappears from the menu. Tickets already opened under it keep
   * their category — the enum is on the ticket, not a reference to this row.
   */
  async removeType(guildId: string, key: string): Promise<boolean> {
    const { count } = await prisma.ticketTypeConfig.deleteMany({ where: { guildId, key } });
    return count > 0;
  },

  /**
   * The panel, or its defaults when a guild has never configured one. Null is
   * never returned: "no panel yet" and "a panel with nothing filled in" are the
   * same thing to the editor, and an absent row would make it render empty.
   */
  async getPanel(guildId: string): Promise<TicketPanelConfigDTO> {
    const row = await prisma.ticketPanelConfig.findUnique({
      where: { guildId },
      select: { channelId: true, messageId: true, title: true, description: true, updatedAt: true },
    });
    return {
      guildId,
      channelId: row?.channelId ?? null,
      messageId: row?.messageId ?? null,
      title: row?.title ?? "Support",
      description: row?.description ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  },

  /**
   * Save the panel's content.
   *
   * Changing the channel clears `messageId`: the recorded message lives in the
   * old channel, and editing it there after an admin moved the panel would put
   * the update somewhere nobody is looking.
   */
  async savePanel(guildId: string, input: TicketPanelConfigInput): Promise<TicketPanelConfigDTO> {
    const existing = await prisma.ticketPanelConfig.findUnique({
      where: { guildId },
      select: { channelId: true, messageId: true },
    });
    const messageId = existing !== null && existing.channelId === input.channelId ? existing.messageId : null;
    const data = {
      channelId: input.channelId,
      messageId,
      title: input.title,
      description: input.description,
    };
    const row = await prisma.ticketPanelConfig.upsert({
      where: { guildId },
      create: { guildId, ...data },
      update: data,
      select: { channelId: true, messageId: true, title: true, description: true, updatedAt: true },
    });
    return {
      guildId,
      channelId: row.channelId,
      messageId: row.messageId,
      title: row.title,
      description: row.description,
      updatedAt: row.updatedAt.toISOString(),
    };
  },

  /** Record where the panel was posted, so the next post edits it in place. */
  async setPostedMessage(guildId: string, channelId: string, messageId: string): Promise<void> {
    await prisma.ticketPanelConfig.upsert({
      where: { guildId },
      create: { guildId, channelId, messageId },
      update: { channelId, messageId },
    });
  },
};
