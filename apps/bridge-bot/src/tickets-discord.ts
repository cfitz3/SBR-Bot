/**
 * The discord.js half of the ticket system.
 *
 * `tickets.ts` decides everything and knows nothing about Discord; this file is
 * the other side of that line. It holds the three port implementations — the
 * config store, the transcript store, and the gateway connection itself — plus
 * the interaction routing that turns a button press into a gateway call.
 *
 * Two things are deliberate and easy to undo by accident:
 *
 * - **Mentions are opt-in per message.** `OutboundMessage` carries the exact
 *   user and role ids that may ping, and `toMessageOptions` passes them as
 *   `allowedMentions` with no `parse`. Almost every string in a ticket message
 *   was typed by an admin into a settings page; an `@everyone` in an opening
 *   message must not become a server-wide ping the first time somebody opens a
 *   ticket.
 * - **A ticket channel is built deny-first.** `@everyone` loses `ViewChannel`
 *   and the opener plus the category's staff roles get it back. Creating the
 *   channel first and restricting it afterwards would leave a window in which a
 *   ban appeal is world-readable, and that window is exactly as long as the
 *   next API call takes.
 */
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ContainerBuilder,
  FileBuilder,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type Client,
  type GuildMember,
  type Message,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type OverwriteResolvable,
  type PermissionOverwrites,
  type TextBasedChannel,
} from "discord.js";
import { ticketConfigRepository, ticketRepository } from "@sbr/db";
import { TICKET_NAMESPACE } from "@sbr/tickets";
import { V2_FLAG, toActionRow, toContainer, toTextContainer, type ComponentRouter } from "@sbr/discord-kit";
import type { Logger } from "@sbr/observability";
import type { TicketCategoryDTO } from "@sbr/shared-types";
import type {
  CapturedMessage,
  NewChannelRequest,
  OutboundMessage,
  TicketArchivePort,
  TicketConfigPort,
  TicketDiscordPort,
  TicketGateway,
} from "./tickets.js";

/** Discord's own caps, spelled once so a long template fails soft. */
const MAX_CHANNEL_NAME = 100;
const MAX_TOPIC = 1024;
/** A modal holds five inputs. `@sbr/tickets` caps questions at the same number. */
const MAX_MODAL_INPUTS = 5;

/** What a ticket channel's viewers may do in it. */
const VIEWER = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
] as const;

// ── stores ───────────────────────────────────────────────────────────────────

/**
 * Ticket configuration, straight off the panel's own tables.
 *
 * `panel()` filters a list rather than reading one row because the repository
 * has no by-id read and a guild has a handful of panels, not thousands. If that
 * ever stops being true it is one query to add, and this is the only caller.
 */
export function ticketConfigPort(): TicketConfigPort {
  return {
    settings: (guildId) => ticketConfigRepository.getSettings(guildId),
    categories: (guildId) => ticketConfigRepository.listCategories(guildId),
    async panel(guildId, panelId) {
      const panels = await ticketConfigRepository.listPanels(guildId);
      return panels.find((p) => p.id === panelId) ?? null;
    },
    recordPanelMessage: (guildId, panelId, channelId, messageId) =>
      ticketConfigRepository.setPostedMessage(guildId, panelId, channelId, messageId),
  };
}

/** The transcript store and the two ticket writes the community service lacks. */
export function ticketArchivePort(): TicketArchivePort {
  return {
    record: (input, fromStaff) => ticketRepository.recordMessage(input, fromStaff),
    markEdited: (id, content, at) => ticketRepository.markMessageEdited(id, content, at),
    markDeleted: (id, at) => ticketRepository.markMessageDeleted(id, at),
    messages: (ticketId) => ticketRepository.listMessages(ticketId),
    bindChannel: (ticketId, channelId) => ticketRepository.bindChannel(ticketId, channelId),
    recent: (guildId, limit) => ticketRepository.listRecent(guildId, limit),
    countSince: (ticketId, since) => ticketRepository.countMessagesSince(ticketId, since),
  };
}

// ── the gateway connection ───────────────────────────────────────────────────

type SendableChannel = Extract<TextBasedChannel, { send: unknown; messages: unknown }>;

/**
 * Every side effect that needs a live client.
 *
 * Nothing here throws: each method answers null or false instead, because the
 * caller has already decided what a failure means — a ticket that could not be
 * greeted is still a ticket, and a transcript that could not be DMed is still
 * on the panel.
 */
export function ticketDiscordPort(client: Client, log: Logger): TicketDiscordPort {
  async function textChannel(channelId: string): Promise<SendableChannel | null> {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return null;
    return channel as SendableChannel;
  }

  async function member(discordGuildId: string, discordId: string): Promise<GuildMember | null> {
    const guild = await client.guilds.fetch(discordGuildId).catch(() => null);
    if (guild === null) return null;
    return guild.members.fetch(discordId).catch(() => null);
  }

  return {
    async memberRoles(discordGuildId, discordId) {
      const found = await member(discordGuildId, discordId);
      // Null rather than an empty list: "they hold no roles" and "I could not
      // read them" decide staff-ness differently, and only one of the two is
      // safe to treat as "not staff" silently.
      return found === null ? null : found.roles.cache.map((r) => r.id);
    },

    async memberNames(discordGuildId, discordId) {
      const found = await member(discordGuildId, discordId);
      if (found === null) return null;
      return { username: found.user.username, nickname: found.nickname ?? found.user.username };
    },

    async userTag(discordId) {
      const user = await client.users.fetch(discordId).catch(() => null);
      return user === null ? null : user.tag;
    },

    async createChannel(request: NewChannelRequest) {
      const guild = await client.guilds.fetch(request.discordGuildId).catch(() => null);
      if (guild === null) return null;

      const overwrites: OverwriteResolvable[] = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        ...request.viewerUserIds.map((id) => ({ id, allow: [...VIEWER] })),
        ...request.viewerRoleIds.map((id) => ({
          id,
          allow: [...VIEWER, PermissionFlagsBits.ManageMessages],
        })),
      ];
      // Us, explicitly. An administrator bot does not need this, and a
      // least-privilege one that was only given "manage channels" does — it
      // would otherwise create a channel it cannot then post the greeting in.
      if (client.user !== null) overwrites.push({ id: client.user.id, allow: [...VIEWER] });

      const created = await guild.channels
        .create({
          name: request.name.slice(0, MAX_CHANNEL_NAME),
          type: ChannelType.GuildText,
          parent: request.parentId,
          topic: request.topic.slice(0, MAX_TOPIC),
          ...(request.slowModeSeconds === null ? {} : { rateLimitPerUser: request.slowModeSeconds }),
          permissionOverwrites: overwrites,
        })
        .catch((error: unknown) => {
          log.error("could not create a ticket channel", {
            guild: request.discordGuildId,
            parent: request.parentId,
            error: String(error),
          });
          return null;
        });
      return created?.id ?? null;
    },

    async post(channelId, message) {
      const channel = await textChannel(channelId);
      if (channel === null) return null;
      const sent = await channel.send(toMessageOptions(message)).catch((error: unknown) => {
        log.warn("could not post a ticket message", { channelId, error: String(error) });
        return null;
      });
      return sent?.id ?? null;
    },

    async edit(channelId, messageId, message) {
      const channel = await textChannel(channelId);
      if (channel === null) return false;
      const edited = await channel.messages.edit(messageId, toMessageOptions(message)).catch(() => null);
      return edited !== null;
    },

    async dm(discordId, message) {
      const user = await client.users.fetch(discordId).catch(() => null);
      if (user === null) return false;
      // Closed DMs are the ordinary case here, not an error: `deliverTranscript`
      // turns a false into a log line and a note in the staff channel.
      const sent = await user.send(toMessageOptions(message)).catch(() => null);
      return sent !== null;
    },

    async disposeChannel(channelId, archive) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel === null || channel.isDMBased() || !("edit" in channel)) return;

      if (!archive) {
        await channel.delete("ticket closed").catch((error: unknown) => {
          log.warn("could not delete a closed ticket channel", { channelId, error: String(error) });
        });
        return;
      }

      // Archiving is a rename and a lock, not a Discord thread archive: the
      // channel stays where staff can find it, and nobody can add to a
      // conversation whose transcript has already been sent.
      const name = (channel.name.startsWith("closed-") ? channel.name : `closed-${channel.name}`).slice(
        0,
        MAX_CHANNEL_NAME,
      );
      const failed = (error: unknown): void => {
        log.warn("could not archive a closed ticket channel", { channelId, error: String(error) });
      };

      // A thread has no overwrites of its own — locking it is the same idea
      // spelled differently, and a ticket that somehow became one still ends up
      // renamed and unwritable rather than silently left open.
      if (!("permissionOverwrites" in channel)) {
        await channel.edit({ name, locked: true }).catch(failed);
        return;
      }

      await channel
        .edit({
          name,
          permissionOverwrites: channel.permissionOverwrites.cache.map((o: PermissionOverwrites) => ({
            id: o.id,
            allow: o.allow.remove(PermissionFlagsBits.SendMessages),
            deny: o.deny.add(PermissionFlagsBits.SendMessages),
          })),
        })
        .catch(failed);
    },
  };
}

/**
 * One outbound message, as discord.js wants it.
 *
 * Components V2, like every other card the platform sends: the message *is*
 * its containers, so the opening line, the cards, the controls and the
 * transcript file all live inside them. `content` is not merely unused here —
 * Discord rejects a V2 payload that carries it.
 *
 * `allowedMentions` is always present and always explicit. Omitting it would
 * fall back to Discord's default, which parses everything in the message —
 * which is the bug this shape exists to make impossible.
 */
function toMessageOptions(message: OutboundMessage): {
  components: ContainerBuilder[];
  flags: number;
  files?: AttachmentBuilder[];
  allowedMentions: { users: string[]; roles: string[] };
} {
  const rows = message.components ?? [];
  const cards = message.embeds ?? [];
  const containers: ContainerBuilder[] = cards.map((embed, i) =>
    toContainer(embed, i === cards.length - 1 ? rows : [], {
      lead: i === 0 ? (message.content ?? null) : null,
    }),
  );
  if (containers.length === 0) {
    // A ticket message with no card is still a sentence somebody has to read,
    // and V2 has no `content` to put it in.
    const container = toTextContainer(message.content ?? "");
    for (const row of rows) container.addActionRowComponents(toActionRow(row));
    containers.push(container);
  }

  // Under V2 an attachment nothing points at is uploaded and invisible.
  if (message.file !== undefined) {
    containers[containers.length - 1]!.addFileComponents(
      new FileBuilder().setURL(`attachment://${message.file.name}`),
    );
  }

  return {
    components: containers,
    flags: V2_FLAG,
    ...(message.file === undefined
      ? {}
      : {
          files: [
            new AttachmentBuilder(Buffer.from(message.file.content, "utf8"), { name: message.file.name }),
          ],
        }),
    allowedMentions: {
      users: [...(message.mentionUsers ?? [])],
      roles: [...(message.mentionRoles ?? [])],
    },
  };
}

// ── capture ──────────────────────────────────────────────────────────────────

/**
 * A gateway message, as the transcript wants it.
 *
 * Attachments record what was attached rather than the bytes: Discord signs CDN
 * links now, so the URL expires and a transcript claiming to hold the file
 * would be lying by the time anybody read it.
 */
export function capturedFrom(message: Message): CapturedMessage {
  return {
    channelId: message.channelId,
    discordMessageId: message.id,
    authorDiscordId: message.author.id,
    authorTag: message.author.tag,
    content: message.content,
    attachments: [...message.attachments.values()].map((a) => ({
      name: a.name,
      size: a.size,
      contentType: a.contentType,
      url: a.url,
    })),
    createdAt: message.createdAt,
    fromBot: message.author.bot,
  };
}

// ── routing ──────────────────────────────────────────────────────────────────

export interface TicketRoutingDeps {
  readonly gateway: TicketGateway;
  /** Discord server id → platform guild id. Null when it is not registered. */
  readonly resolveGuild: (discordGuildId: string) => Promise<string | null>;
  readonly log: Logger;
}

/** Modal ids. Separate from the button namespace because modals route apart. */
const QUESTION_MODAL = `${TICKET_NAMESPACE}:q`;
const CLOSE_MODAL = `${TICKET_NAMESPACE}:cr`;
const CLOSE_REASON_FIELD = "reason";

/**
 * Everything a member or staffer can press on a ticket.
 *
 * All of it is stateless: `tkt:new:<key>` carries the category, and everything
 * else is answered from the channel the press arrived in. A panel posted last
 * month still works, which is the whole reason these ids are built rather than
 * collected.
 */
export function registerTicketComponents(router: ComponentRouter, deps: TicketRoutingDeps): void {
  router.register(TICKET_NAMESPACE, async (interaction, segments) => {
    const guildId = interaction.guildId === null ? null : await deps.resolveGuild(interaction.guildId);
    if (guildId === null || interaction.guildId === null) {
      await ephemeral(interaction, "This server isn't set up on the platform yet.");
      return;
    }

    const action = segments[0] ?? "";
    switch (action) {
      case "new":
        await beginOpen(interaction, deps, guildId, segments[1] ?? "");
        return;
      case "pick": {
        // The menu carries the panel; the chosen category arrives as a value.
        const chosen = interaction.isStringSelectMenu() ? interaction.values[0] : undefined;
        await beginOpen(interaction, deps, guildId, chosen ?? "");
        return;
      }
      case "claim":
      case "release":
      case "closereq": {
        await interaction.deferReply();
        const result =
          action === "claim"
            ? await deps.gateway.claim(interaction.channelId, interaction.user.id, interaction.guildId)
            : action === "release"
              ? await deps.gateway.release(interaction.channelId, interaction.user.id, interaction.guildId)
              : await deps.gateway.requestClose(interaction.channelId, interaction.user.id, interaction.guildId);
        // The note is deliberately public: a claim nobody else can see is how
        // two staff end up answering the same ticket.
        await interaction
          .editReply({
            content: result.ok ? result.note : result.detail,
            allowedMentions: { users: [interaction.user.id], roles: [] },
          })
          .catch(() => {});
        return;
      }
      case "close": {
        // A modal instead of an immediate close: it is the confirmation step
        // *and* the only place a close reason can be typed, and the transcript
        // is worth one extra press.
        await interaction.showModal(closeModal()).catch(() => {});
        return;
      }
      default:
        await ephemeral(interaction, "That control is no longer in use.");
    }
  });
}

/**
 * A press on a panel control: ask the questions, or open straight away.
 *
 * The modal has to be the *first* response to the interaction — Discord will
 * not accept one after a defer — so the category lookup happens before any
 * acknowledgement, and the whole path is two reads inside the three-second
 * budget.
 */
async function beginOpen(
  interaction: MessageComponentInteraction,
  deps: TicketRoutingDeps,
  guildId: string,
  categoryKey: string,
): Promise<void> {
  const category = categoryKey === "" ? null : await deps.gateway.categoryFor(guildId, categoryKey);
  if (category === null) {
    await ephemeral(interaction, "That kind of ticket isn't available any more.");
    return;
  }

  if (category.questions.length > 0) {
    await interaction.showModal(questionModal(category)).catch((error: unknown) => {
      deps.log.warn("could not raise the ticket questions", { category: category.key, error: String(error) });
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await finishOpen(interaction, deps, guildId, category.key, {});
}

/**
 * Modal submissions, which do not come through the component router.
 *
 * Returns false when the id belongs to something else, so the caller can keep
 * its own modals without this one having to know about them.
 */
export async function handleTicketModal(
  interaction: ModalSubmitInteraction,
  deps: TicketRoutingDeps,
): Promise<boolean> {
  const id = interaction.customId;
  if (!id.startsWith(`${TICKET_NAMESPACE}:`)) return false;

  const guildId = interaction.guildId === null ? null : await deps.resolveGuild(interaction.guildId);
  if (guildId === null || interaction.guildId === null) {
    await ephemeral(interaction, "This server isn't set up on the platform yet.");
    return true;
  }

  if (id === CLOSE_MODAL) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const typed = fieldValue(interaction, CLOSE_REASON_FIELD).trim();
    const result = await deps.gateway.close(
      interaction.channelId ?? "",
      interaction.user.id,
      interaction.guildId,
      typed === "" ? null : typed,
    );
    // The channel is very often gone by now — archived or deleted — so the
    // reply is best-effort. The close itself already happened.
    await interaction
      .editReply({ content: result.ok ? result.note : result.detail })
      .catch(() => {});
    return true;
  }

  if (id.startsWith(`${QUESTION_MODAL}:`)) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const categoryKey = id.slice(`${QUESTION_MODAL}:`.length);
    const category = await deps.gateway.categoryFor(guildId, categoryKey);
    if (category === null) {
      await interaction.editReply({ content: "That kind of ticket isn't available any more." }).catch(() => {});
      return true;
    }
    const answers: Record<string, string> = {};
    for (const question of category.questions.slice(0, MAX_MODAL_INPUTS)) {
      const value = fieldValue(interaction, question.id).trim();
      if (value !== "") answers[question.id] = value;
    }
    await finishOpen(interaction, deps, guildId, category.key, answers);
    return true;
  }

  await ephemeral(interaction, "That form is no longer in use.");
  return true;
}

/** Open the ticket and tell the member where it went. Already deferred. */
async function finishOpen(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  deps: TicketRoutingDeps,
  guildId: string,
  categoryKey: string,
  answers: Readonly<Record<string, string>>,
): Promise<void> {
  const result = await deps.gateway.open({
    guildId,
    discordGuildId: interaction.guildId ?? "",
    categoryKey,
    opener: {
      discordId: interaction.user.id,
      username: interaction.user.username,
      nickname: nicknameOf(interaction),
      roleIds: roleIdsOf(interaction),
    },
    answers,
  });

  const content = result.ok
    ? result.channelId === null
      ? `Opened ticket #${result.ticket.number}.`
      : `Opened ticket #${result.ticket.number} — <#${result.channelId}>.`
    : result.detail;
  await interaction.editReply({ content }).catch(() => {});
}

// ── modals ───────────────────────────────────────────────────────────────────

function questionModal(category: TicketCategoryDTO): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`${QUESTION_MODAL}:${category.key}`)
    // Discord caps a modal title at 45 characters, and a category name is free
    // text an admin can make as long as they like.
    .setTitle(category.name.slice(0, 45));

  for (const question of category.questions.slice(0, MAX_MODAL_INPUTS)) {
    const input = new TextInputBuilder()
      .setCustomId(question.id)
      .setLabel(question.label.slice(0, 45))
      .setStyle(question.style === "PARAGRAPH" ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(question.required);
    if (question.placeholder !== null) input.setPlaceholder(question.placeholder.slice(0, 100));
    if (question.maxLength !== null) input.setMaxLength(question.maxLength);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }
  return modal;
}

function closeModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(CLOSE_MODAL)
    .setTitle("Close this ticket")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(CLOSE_REASON_FIELD)
          .setLabel("Reason (optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500),
      ),
    );
}

// ── interaction helpers ──────────────────────────────────────────────────────

/**
 * A field's value, or "".
 *
 * `getTextInputValue` throws when the input is not in the submission, which an
 * optional field legitimately is not — and a question an admin removed between
 * the modal opening and it being submitted definitely is not.
 */
function fieldValue(interaction: ModalSubmitInteraction, customId: string): string {
  try {
    return interaction.fields.getTextInputValue(customId);
  } catch {
    return "";
  }
}

function roleIdsOf(interaction: MessageComponentInteraction | ModalSubmitInteraction): readonly string[] {
  const member = interaction.member;
  if (member === null) return [];
  // Uncached interactions hand back the raw API member, whose roles are already
  // a list of ids; a cached one hands back a manager.
  return Array.isArray(member.roles) ? member.roles : member.roles.cache.map((r) => r.id);
}

function nicknameOf(interaction: MessageComponentInteraction | ModalSubmitInteraction): string {
  const member = interaction.member;
  if (member === null) return interaction.user.username;
  if ("nickname" in member) return member.nickname ?? interaction.user.username;
  return member.nick ?? interaction.user.username;
}

async function ephemeral(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  content: string,
): Promise<void> {
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ content }).catch(() => {});
    return;
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
}
