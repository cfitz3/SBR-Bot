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
  AttachmentBuilder,
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
import { VIEW_COLORS } from "@sbr/embed-kit";

/**
 * Discord's component limits, enforced here rather than trusted to call sites.
 *
 * Every current caller clamps its own lists — the role menus at 25, the ticket
 * panel at its category cap, the paginator at one nav row. This is the floor
 * under all of them, and it exists because of what going over costs: Discord
 * rejects the *whole* payload, so a twenty-sixth role does not drop a role, it
 * drops the message. Truncating is the lesser failure, and it is the one a
 * staffer can see and explain.
 */
const MAX_BUTTONS_PER_ROW = 5;
const MAX_SELECT_OPTIONS = 25;
const MAX_ROWS_PER_MESSAGE = 5;
const MAX_BUTTON_LABEL = 80;
const MAX_OPTION_LABEL = 100;
const MAX_OPTION_DESCRIPTION = 100;
const MAX_AUTHOR_NAME = 256;

/** Discord counts UTF-16 code units, which is what `String#slice` counts too. */
function clampText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

const STYLES = {
  PRIMARY: DiscordButtonStyle.Primary,
  SECONDARY: DiscordButtonStyle.Secondary,
  SUCCESS: DiscordButtonStyle.Success,
  DANGER: DiscordButtonStyle.Danger,
  LINK: DiscordButtonStyle.Link,
} as const;

export function toEmbed(view: EmbedView): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(VIEW_COLORS[view.color ?? "NEUTRAL"]);
  // The author row goes on first because that is the order it reads in: subject,
  // then what the card says about it. discord.js does not care, but a renderer
  // that builds the card in reading order is one you can check against a mock.
  if (view.author) {
    embed.setAuthor({
      name: clampText(view.author.name, MAX_AUTHOR_NAME),
      ...(view.author.iconUrl ? { iconURL: view.author.iconUrl } : {}),
      ...(view.author.url ? { url: view.author.url } : {}),
    });
  }
  if (view.title) embed.setTitle(view.title);
  if (view.description) embed.setDescription(view.description);
  if (view.url) embed.setURL(view.url);
  if (view.author) {
    embed.setAuthor({
      name: clampText(view.author.name, MAX_AUTHOR_NAME),
      ...(view.author.iconUrl ? { iconURL: view.author.iconUrl } : {}),
      ...(view.author.url ? { url: view.author.url } : {}),
    });
  }
  if (view.thumbnailUrl) embed.setThumbnail(view.thumbnailUrl);
  if (view.imageUrl) embed.setImage(view.imageUrl);
  if (view.footer) embed.setFooter({ text: view.footer });
  // An unparseable date makes discord.js throw, which would turn a cosmetic
  // problem into a failed reply. `timestamp.invalid` flags it in the gallery;
  // here it is simply dropped, because a card without an age still answers the
  // question the member asked.
  if (view.timestamp) {
    const at = Date.parse(view.timestamp);
    if (Number.isFinite(at)) embed.setTimestamp(new Date(at));
  }
  for (const field of view.fields ?? []) {
    embed.addFields({ name: field.name, value: field.value, inline: field.inline ?? false });
  }
  return embed;
}

function toButton(view: ButtonView): ButtonBuilder {
  const button = new ButtonBuilder()
    .setLabel(clampText(view.label, MAX_BUTTON_LABEL))
    .setStyle(STYLES[view.style]);
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
  if (view.disabled) menu.setDisabled(true);
  const options = view.options.slice(0, MAX_SELECT_OPTIONS);
  menu.addOptions(
    options.map((o) => {
      const option = new StringSelectMenuOptionBuilder()
        .setLabel(clampText(o.label, MAX_OPTION_LABEL))
        .setValue(o.value);
      if (o.description) option.setDescription(clampText(o.description, MAX_OPTION_DESCRIPTION));
      if (o.emoji) option.setEmoji(o.emoji);
      if (o.default) option.setDefault(true);
      return option;
    }),
  );
  // Both bounds are set after the options, and against the list that actually
  // survived truncation. A `maxValues` above the option count is rejected
  // outright, and a truncated list is exactly how that happens without anybody
  // having written it down.
  const ceiling = Math.max(1, options.length);
  if (view.minValues !== undefined) menu.setMinValues(Math.min(view.minValues, ceiling));
  if (view.maxValues !== undefined) menu.setMaxValues(Math.max(1, Math.min(view.maxValues, ceiling)));
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
  return row.addComponents(...view.buttons.slice(0, MAX_BUTTONS_PER_ROW).map(toButton));
}

/** The transport-agnostic reply shape both command packages return. */
export interface ReplyView {
  readonly text: string;
  readonly ephemeral: boolean;
  readonly embed?: EmbedView;
  readonly components?: readonly ActionRowView[];
  readonly pages?: readonly EmbedView[];
  /**
   * An attachment rendered from text — a ticket transcript, today.
   *
   * Text rather than bytes because everything the platform attaches is
   * generated here and now: a handler that wanted to forward arbitrary binary
   * would be doing something this shape should not quietly allow.
   */
  readonly file?: { readonly name: string; readonly content: string };
}

export interface DiscordReplyOptions {
  content?: string;
  embeds?: EmbedBuilder[];
  files?: AttachmentBuilder[];
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
  if (reply.components?.length) {
    options.components = reply.components.slice(0, MAX_ROWS_PER_MESSAGE).map(toActionRow);
  }
  if (reply.file) {
    options.files = [
      new AttachmentBuilder(Buffer.from(reply.file.content, "utf8"), { name: reply.file.name }),
    ];
    // An attachment with no words above it reads as a mystery file. The text is
    // kept even when an embed carried the same information.
    options.content = reply.text;
  }
  if (reply.ephemeral) options.flags = MessageFlags.Ephemeral;
  return options;
}
