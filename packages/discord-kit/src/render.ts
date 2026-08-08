/**
 * View model → discord.js objects.
 *
 * Handlers return transport-agnostic `EmbedView`/`ActionRowView` values (see
 * @sbr/shared-types/views) so the same command can render as a Discord card here
 * and as a single ~256-char line in guild chat. This module is the only place
 * that knows about `EmbedBuilder`.
 */
import type { ActionRowView, ButtonView, EmbedView, ViewColor } from "@sbr/shared-types";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle as DiscordButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";

/** Semantic colour → hex. Central so every embed in the platform agrees. */
const COLORS: Record<ViewColor, number> = {
  NEUTRAL: 0x2b2d31,
  INFO: 0x5865f2,
  SUCCESS: 0x57f287,
  WARNING: 0xfee75c,
  DANGER: 0xed4245,
};

const STYLES = {
  PRIMARY: DiscordButtonStyle.Primary,
  SECONDARY: DiscordButtonStyle.Secondary,
  SUCCESS: DiscordButtonStyle.Success,
  DANGER: DiscordButtonStyle.Danger,
  LINK: DiscordButtonStyle.Link,
} as const;

export function toEmbed(view: EmbedView): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(COLORS[view.color ?? "NEUTRAL"]);
  if (view.title) embed.setTitle(view.title);
  if (view.description) embed.setDescription(view.description);
  if (view.url) embed.setURL(view.url);
  if (view.thumbnailUrl) embed.setThumbnail(view.thumbnailUrl);
  if (view.footer) embed.setFooter({ text: view.footer });
  for (const field of view.fields ?? []) {
    embed.addFields({ name: field.name, value: field.value, inline: field.inline ?? false });
  }
  return embed;
}

function toButton(view: ButtonView): ButtonBuilder {
  const button = new ButtonBuilder().setLabel(view.label).setStyle(STYLES[view.style]);
  // A link button carries a URL and no customId; every other style is the
  // reverse. Discord rejects the payload if both or neither is set.
  if (view.style === "LINK") button.setURL(view.url ?? "https://discord.com");
  else button.setCustomId(view.customId ?? view.label.toLowerCase().replace(/\W+/g, "-"));
  if (view.emoji) button.setEmoji(view.emoji);
  if (view.disabled) button.setDisabled(true);
  return button;
}

export function toActionRow(view: ActionRowView): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...view.buttons.map(toButton));
}

/** The transport-agnostic reply shape both command packages return. */
export interface ReplyView {
  readonly text: string;
  readonly ephemeral: boolean;
  readonly embed?: EmbedView;
  readonly components?: readonly ActionRowView[];
  readonly pages?: readonly EmbedView[];
}

export interface DiscordReplyOptions {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: ActionRowBuilder<ButtonBuilder>[];
  flags?: MessageFlags.Ephemeral;
  allowedMentions?: { parse: [] };
}

/**
 * Render a reply for `interaction.reply()`.
 *
 * `text` is dropped when an embed carries the same information — repeating it
 * above the card reads as a duplicate. It is kept when there is no embed, which
 * is also the accessible fallback path.
 *
 * Nothing the platform renders needs to ping anyone: replies address the caller,
 * who is already looking at them. Suppressing mentions centrally means a handler
 * that interpolates a player-supplied IGN, guild name, or application answer
 * can't turn it into a notification, without every handler having to remember.
 */
export function replyOptions(reply: ReplyView): DiscordReplyOptions {
  const embedView = reply.embed ?? reply.pages?.[0];
  const options: DiscordReplyOptions = { allowedMentions: { parse: [] } };
  if (embedView) options.embeds = [toEmbed(embedView)];
  else options.content = reply.text;
  if (reply.components?.length) options.components = reply.components.map(toActionRow);
  if (reply.ephemeral) options.flags = MessageFlags.Ephemeral;
  return options;
}
