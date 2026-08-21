/**
 * Ticket configuration: settings, categories, panels and tags.
 *
 * Four small tables rather than the one config row this file used to hold. The
 * shapes are ports of discord-tickets' model, so the reasoning behind the odd
 * numbers (50 channels to a Discord category, 5 inputs to a modal, 25 options
 * to a select) lives in `@sbr/tickets`, next to the code that enforces it.
 *
 * Nothing here decides anything: ordering, seeding and validation are pure
 * functions in `@sbr/tickets`, which is why they can be tested without a
 * database. This file maps rows to DTOs and back, and nothing else.
 */
import type {
  TicketCategoryDTO,
  TicketCategoryInput,
  TicketPanelDTO,
  TicketPanelInput,
  TicketPanelStyle,
  TicketQuestionDTO,
  TicketSettingsDTO,
  TicketSettingsInput,
  TicketTagDTO,
  TicketTagInput,
  TicketWorkingHoursDTO,
  ViewColor,
} from "@sbr/shared-types";
import { defaultSettings, orderCategories } from "@sbr/tickets";
import { Prisma } from "@prisma/client";
import { prisma } from "../client.js";

const VIEW_COLORS = new Set<string>(["NEUTRAL", "INFO", "SUCCESS", "WARNING", "DANGER"]);

/**
 * Colours are stored as text, so a hand-edited row can hold anything. An
 * unknown value falls back rather than reaching a renderer that would key into
 * the palette with it and produce `undefined`.
 */
function toColor(value: string, fallback: ViewColor): ViewColor {
  return VIEW_COLORS.has(value) ? (value as ViewColor) : fallback;
}

/**
 * `questions` and `workingHours` are Json columns, so the shape is a promise
 * this file cannot keep on its own. Both readers drop anything malformed
 * instead of handing a half-parsed object to a modal builder.
 */
function toQuestions(value: Prisma.JsonValue): readonly TicketQuestionDTO[] {
  if (!Array.isArray(value)) return [];
  const out: TicketQuestionDTO[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row["id"] !== "string" || typeof row["label"] !== "string") continue;
    out.push({
      id: row["id"],
      label: row["label"],
      placeholder: typeof row["placeholder"] === "string" ? row["placeholder"] : null,
      style: row["style"] === "PARAGRAPH" ? "PARAGRAPH" : "SHORT",
      required: row["required"] !== false,
      maxLength: typeof row["maxLength"] === "number" ? row["maxLength"] : null,
    });
  }
  return out;
}

function toWorkingHours(value: Prisma.JsonValue): TicketWorkingHoursDTO {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, { open: string; close: string }> = {};
  for (const [day, entry] of Object.entries(value)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row["open"] !== "string" || typeof row["close"] !== "string") continue;
    out[day] = { open: row["open"], close: row["close"] };
  }
  return out;
}

type SettingsRow = {
  guildId: string;
  archiveEnabled: boolean;
  logChannelId: string | null;
  blocklistRoleIds: string[];
  primaryColor: string;
  successColor: string;
  errorColor: string;
  footer: string | null;
  staleAfterMinutes: number | null;
  autoCloseAfterMinutes: number;
  closeButton: boolean;
  claimButton: boolean;
  workingHours: Prisma.JsonValue;
  updatedAt: Date;
};

function toSettingsDTO(row: SettingsRow): TicketSettingsDTO {
  return {
    guildId: row.guildId,
    archiveEnabled: row.archiveEnabled,
    logChannelId: row.logChannelId,
    blocklistRoleIds: row.blocklistRoleIds,
    primaryColor: toColor(row.primaryColor, "INFO"),
    successColor: toColor(row.successColor, "SUCCESS"),
    errorColor: toColor(row.errorColor, "DANGER"),
    footer: row.footer,
    staleAfterMinutes: row.staleAfterMinutes,
    autoCloseAfterMinutes: row.autoCloseAfterMinutes,
    closeButton: row.closeButton,
    claimButton: row.claimButton,
    workingHours: toWorkingHours(row.workingHours),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type CategoryRow = {
  id: string;
  guildId: string;
  key: string;
  name: string;
  description: string;
  emoji: string | null;
  position: number;
  enabled: boolean;
  channelNameTemplate: string;
  parentChannelId: string | null;
  staffRoleIds: string[];
  requiredRoleIds: string[];
  pingRoleIds: string[];
  openingMessage: string;
  image: string | null;
  claiming: boolean;
  cooldownSeconds: number | null;
  memberLimit: number;
  totalLimit: number;
  slowModeSeconds: number | null;
  requireTopic: boolean;
  questions: Prisma.JsonValue;
};

const CATEGORY_SELECT = {
  id: true,
  guildId: true,
  key: true,
  name: true,
  description: true,
  emoji: true,
  position: true,
  enabled: true,
  channelNameTemplate: true,
  parentChannelId: true,
  staffRoleIds: true,
  requiredRoleIds: true,
  pingRoleIds: true,
  openingMessage: true,
  image: true,
  claiming: true,
  cooldownSeconds: true,
  memberLimit: true,
  totalLimit: true,
  slowModeSeconds: true,
  requireTopic: true,
  questions: true,
} as const;

function toCategoryDTO(row: CategoryRow): TicketCategoryDTO {
  return {
    id: row.id,
    guildId: row.guildId,
    key: row.key,
    name: row.name,
    description: row.description,
    emoji: row.emoji,
    position: row.position,
    enabled: row.enabled,
    channelNameTemplate: row.channelNameTemplate,
    parentChannelId: row.parentChannelId,
    staffRoleIds: row.staffRoleIds,
    requiredRoleIds: row.requiredRoleIds,
    pingRoleIds: row.pingRoleIds,
    openingMessage: row.openingMessage,
    image: row.image,
    claiming: row.claiming,
    cooldownSeconds: row.cooldownSeconds,
    memberLimit: row.memberLimit,
    totalLimit: row.totalLimit,
    slowModeSeconds: row.slowModeSeconds,
    requireTopic: row.requireTopic,
    questions: toQuestions(row.questions),
  };
}

function categoryData(input: TicketCategoryInput) {
  return {
    name: input.name,
    description: input.description,
    emoji: input.emoji,
    position: input.position,
    enabled: input.enabled,
    channelNameTemplate: input.channelNameTemplate,
    parentChannelId: input.parentChannelId,
    staffRoleIds: [...input.staffRoleIds],
    requiredRoleIds: [...input.requiredRoleIds],
    pingRoleIds: [...input.pingRoleIds],
    openingMessage: input.openingMessage,
    image: input.image,
    claiming: input.claiming,
    cooldownSeconds: input.cooldownSeconds,
    memberLimit: input.memberLimit,
    totalLimit: input.totalLimit,
    slowModeSeconds: input.slowModeSeconds,
    requireTopic: input.requireTopic,
    questions: input.questions as unknown as Prisma.InputJsonValue,
  };
}

type PanelRow = {
  id: string;
  guildId: string;
  name: string;
  channelId: string | null;
  messageId: string | null;
  title: string;
  description: string | null;
  image: string | null;
  thumbnail: string | null;
  style: string;
  categoryKeys: string[];
  updatedAt: Date;
};

const PANEL_SELECT = {
  id: true,
  guildId: true,
  name: true,
  channelId: true,
  messageId: true,
  title: true,
  description: true,
  image: true,
  thumbnail: true,
  style: true,
  categoryKeys: true,
  updatedAt: true,
} as const;

function toPanelDTO(row: PanelRow): TicketPanelDTO {
  return {
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    channelId: row.channelId,
    messageId: row.messageId,
    title: row.title,
    description: row.description,
    image: row.image,
    thumbnail: row.thumbnail,
    style: row.style === "SELECT" ? "SELECT" : "BUTTONS",
    categoryKeys: row.categoryKeys,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const ticketConfigRepository = {
  /**
   * A guild's settings, or the defaults when it has never saved any.
   *
   * Null is never returned: "no row yet" and "a row with everything at its
   * default" are the same thing to every caller, and an absent row would make
   * the editor render empty controls over live behaviour.
   */
  async getSettings(guildId: string): Promise<TicketSettingsDTO> {
    const row = await prisma.ticketSettings.findUnique({ where: { guildId } });
    return row === null ? defaultSettings(guildId) : toSettingsDTO(row);
  },

  async saveSettings(guildId: string, input: TicketSettingsInput): Promise<TicketSettingsDTO> {
    const data = {
      archiveEnabled: input.archiveEnabled,
      logChannelId: input.logChannelId,
      blocklistRoleIds: [...input.blocklistRoleIds],
      primaryColor: input.primaryColor,
      successColor: input.successColor,
      errorColor: input.errorColor,
      footer: input.footer,
      staleAfterMinutes: input.staleAfterMinutes,
      autoCloseAfterMinutes: input.autoCloseAfterMinutes,
      closeButton: input.closeButton,
      claimButton: input.claimButton,
      workingHours: input.workingHours as unknown as Prisma.InputJsonValue,
    };
    const row = await prisma.ticketSettings.upsert({
      where: { guildId },
      create: { guildId, ...data },
      update: data,
    });
    return toSettingsDTO(row);
  },

  /**
   * Every category, in menu order, disabled ones included.
   *
   * Filtering the disabled is the caller's job — the panel has to render the
   * switch it can turn back on, and `openableCategories` in `@sbr/tickets` is
   * the one place a member-facing list is narrowed.
   */
  async listCategories(guildId: string): Promise<readonly TicketCategoryDTO[]> {
    const rows = await prisma.ticketCategory.findMany({ where: { guildId }, select: CATEGORY_SELECT });
    return orderCategories(rows.map(toCategoryDTO));
  },

  /** Create or update by `(guildId, key)`. `key` identifies; everything else is editable. */
  async upsertCategory(guildId: string, input: TicketCategoryInput): Promise<TicketCategoryDTO> {
    const data = categoryData(input);
    const row = await prisma.ticketCategory.upsert({
      where: { guildId_key: { guildId, key: input.key } },
      create: { guildId, key: input.key, ...data },
      update: data,
      select: CATEGORY_SELECT,
    });
    return toCategoryDTO(row);
  },

  /**
   * Delete a category. Tickets opened under it survive with `categoryId` null —
   * the relation is `SetNull`, because losing a support conversation because
   * somebody tidied up the menu would be the worse failure.
   */
  async removeCategory(guildId: string, key: string): Promise<boolean> {
    const { count } = await prisma.ticketCategory.deleteMany({ where: { guildId, key } });
    return count > 0;
  },

  async listPanels(guildId: string): Promise<readonly TicketPanelDTO[]> {
    const rows = await prisma.ticketPanel.findMany({
      where: { guildId },
      orderBy: { createdAt: "asc" },
      select: PANEL_SELECT,
    });
    return rows.map(toPanelDTO);
  },

  /**
   * Save a panel's content.
   *
   * Changing the channel clears `messageId`: the recorded message lives in the
   * old channel, and editing it there after an admin moved the panel would put
   * the update somewhere nobody is looking.
   */
  async upsertPanel(guildId: string, input: TicketPanelInput, id?: string): Promise<TicketPanelDTO> {
    const style: TicketPanelStyle = input.style;
    const data = {
      name: input.name,
      channelId: input.channelId,
      title: input.title,
      description: input.description,
      image: input.image,
      thumbnail: input.thumbnail,
      style,
      categoryKeys: [...input.categoryKeys],
    };
    if (id === undefined) {
      const created = await prisma.ticketPanel.create({ data: { guildId, ...data }, select: PANEL_SELECT });
      return toPanelDTO(created);
    }
    const existing = await prisma.ticketPanel.findFirst({
      where: { id, guildId },
      select: { channelId: true, messageId: true },
    });
    const messageId = existing !== null && existing.channelId === input.channelId ? existing.messageId : null;
    const row = await prisma.ticketPanel.update({
      where: { id },
      data: { ...data, messageId },
      select: PANEL_SELECT,
    });
    return toPanelDTO(row);
  },

  async removePanel(guildId: string, id: string): Promise<boolean> {
    const { count } = await prisma.ticketPanel.deleteMany({ where: { id, guildId } });
    return count > 0;
  },

  /**
   * Record where a panel was posted, so the next publish edits it in place.
   * A null `messageId` un-records it, which is what a failed edit reports.
   */
  async setPostedMessage(
    guildId: string,
    id: string,
    channelId: string,
    messageId: string | null,
  ): Promise<void> {
    await prisma.ticketPanel.updateMany({ where: { id, guildId }, data: { channelId, messageId } });
  },

  async listTags(guildId: string): Promise<readonly TicketTagDTO[]> {
    const rows = await prisma.ticketTag.findMany({ where: { guildId }, orderBy: { name: "asc" } });
    return rows.map((r) => ({
      id: r.id,
      guildId: r.guildId,
      name: r.name,
      content: r.content,
      autoPattern: r.autoPattern,
      scope: r.scope,
      enabled: r.enabled,
    }));
  },

  /** Create or update by `(guildId, name)`. The name is how staff call it. */
  async upsertTag(guildId: string, input: TicketTagInput): Promise<TicketTagDTO> {
    const data = {
      content: input.content,
      autoPattern: input.autoPattern,
      scope: input.scope,
      enabled: input.enabled,
    };
    const row = await prisma.ticketTag.upsert({
      where: { guildId_name: { guildId, name: input.name } },
      create: { guildId, name: input.name, ...data },
      update: data,
    });
    return {
      id: row.id,
      guildId: row.guildId,
      name: row.name,
      content: row.content,
      autoPattern: row.autoPattern,
      scope: row.scope,
      enabled: row.enabled,
    };
  },

  async removeTag(guildId: string, name: string): Promise<boolean> {
    const { count } = await prisma.ticketTag.deleteMany({ where: { guildId, name } });
    return count > 0;
  },
};
