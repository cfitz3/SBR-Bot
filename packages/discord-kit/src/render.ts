/**
 * View model → discord.js objects.
 *
 * Handlers return transport-agnostic `EmbedView`/`ActionRowView` values (see
 * @sbr/shared-types/views) so the same command can render as a Discord card here
 * and as a single ~256-char line in guild chat. This module is the only place
 * that knows about `EmbedBuilder`.
 */
import type { ActionRowView, ButtonView, EmbedView, SelectMenuView } from "@sbr/shared-types";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle as DiscordButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type MessageActionRowComponentBuilder,
} from "discord.js";

// The palette lives in one place — `brand/theme.ts`, re-exported by `style.ts`.
// This module used to keep its own private copy of the same five numbers.
import { VIEW_COLORS } from "./style.js";

const STYLES = {
  PRIMARY: DiscordButtonStyle.Primary,
  SECONDARY: DiscordButtonStyle.Secondary,
  SUCCESS: DiscordButtonStyle.Success,
  DANGER: DiscordButtonStyle.Danger,
  LINK: DiscordButtonStyle.Link,
} as const;

export function toEmbed(view: EmbedView): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(VIEW_COLORS[view.color ?? "NEUTRAL"]);
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

function toSelect(view: SelectMenuView): StringSelectMenuBuilder {
  const menu = new StringSelectMenuBuilder().setCustomId(view.customId);
  if (view.placeholder) menu.setPlaceholder(view.placeholder);
  if (view.minValues !== undefined) menu.setMinValues(view.minValues);
  if (view.maxValues !== undefined) menu.setMaxValues(view.maxValues);
  if (view.disabled) menu.setDisabled(true);
  menu.addOptions(
    view.options.map((o) => {
      const option = new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.value);
      if (o.description) option.setDescription(o.description);
      if (o.emoji) option.setEmoji(o.emoji);
      if (o.default) option.setDefault(true);
      return option;
    }),
  );
  return menu;
}

/**
 * A row of buttons, or a row holding one select menu.
 *
 * Discord forbids mixing the two in a row, so the view model's `select` field
 * decides which this is rather than the two being merged.
 */
export function toActionRow(view: ActionRowView): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>();
  if (view.select) return row.addComponents(toSelect(view.select));
  return row.addComponents(...view.buttons.map(toButton));
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
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
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
