/**
 * Shared builders for the ticket suites.
 *
 * A `.test.ts` file so it compiles under the same config as its callers and
 * never ships in the package's public surface. It declares no tests of its own.
 */
import type {
  TicketCategoryDTO,
  TicketDTO,
  TicketMessageDTO,
  TicketPanelDTO,
  TicketSettingsDTO,
  TicketTagDTO,
} from "@sbr/shared-types";
import { defaultSettings } from "./defaults.js";

export const GUILD = "g1";

export function category(over: Partial<TicketCategoryDTO> = {}): TicketCategoryDTO {
  return {
    id: "c1",
    guildId: GUILD,
    key: "SUPPORT",
    name: "Support",
    description: "General help.",
    emoji: null,
    position: 0,
    enabled: true,
    channelNameTemplate: "ticket-{num}",
    parentChannelId: null,
    staffRoleIds: [],
    requiredRoleIds: [],
    pingRoleIds: [],
    openingMessage: "",
    image: null,
    claiming: true,
    cooldownSeconds: null,
    memberLimit: 1,
    totalLimit: 50,
    slowModeSeconds: null,
    requireTopic: false,
    questions: [],
    ...over,
  };
}

export function settings(over: Partial<TicketSettingsDTO> = {}): TicketSettingsDTO {
  return { ...defaultSettings(GUILD), ...over };
}

export function ticket(over: Partial<TicketDTO> = {}): TicketDTO {
  return {
    id: "t1",
    guildId: GUILD,
    number: 7,
    openerDiscordId: "opener",
    assigneeDiscordId: null,
    categoryId: "c1",
    categoryKey: "SUPPORT",
    categoryName: "Support",
    status: "OPEN",
    channelId: "chan",
    subject: null,
    topic: null,
    claimedByDiscordId: null,
    claimedAt: null,
    closeRequestedByDiscordId: null,
    closeRequestedAt: null,
    lastMessageAt: null,
    firstStaffReplyAt: null,
    feedbackRating: null,
    transcriptReady: false,
    closeReason: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    closedAt: null,
    ...over,
  };
}

export function panel(over: Partial<TicketPanelDTO> = {}): TicketPanelDTO {
  return {
    id: "p1",
    guildId: GUILD,
    name: "Support",
    channelId: null,
    messageId: null,
    title: "Support",
    description: "Pick a category below.",
    image: null,
    thumbnail: null,
    style: "BUTTONS",
    categoryKeys: ["SUPPORT"],
    updatedAt: null,
    ...over,
  };
}

export function tag(over: Partial<TicketTagDTO> = {}): TicketTagDTO {
  return { id: "g1t", guildId: GUILD, name: "Welcome", content: "Hi!", autoPattern: null, enabled: true, ...over };
}

export function message(over: Partial<TicketMessageDTO> = {}): TicketMessageDTO {
  return {
    id: "m1",
    authorDiscordId: "opener",
    authorTag: "opener#0",
    content: "hello",
    attachments: [],
    editedAt: null,
    deletedAt: null,
    createdAt: "2026-08-01T00:01:00.000Z",
    ...over,
  };
}
