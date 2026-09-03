/**
 * View model → Components V2 containers.
 *
 * The same `EmbedView` the embed renderer takes, rendered as a container
 * instead of an embed. Handlers do not know which one they got: this module
 * and `render.ts` are two spellings of one card, and everything above them
 * still returns a transport-agnostic view.
 *
 * The Operator rules decide the spelling:
 *
 * - colour marks the selected thing and nothing else. A container gets exactly
 *   one accent, taken from `view.color`, and nothing inside it is coloured.
 * - a hairline is the separator. Where an embed leaned on Discord's own field
 *   boxes, a container puts a divider between the header, the facts and the
 *   footer, and nothing else draws a box.
 * - mono is for anything machine-read. That is a decision the card content
 *   already made upstream, in `@sbr/embed-kit`; this module preserves the
 *   markdown it was given rather than restyling it.
 *
 * What V2 changes that callers must respect: a message carrying
 * `MessageFlags.IsComponentsV2` may not carry `content` or `embeds` at all, and
 * an edit that drops the flag drops the message body with it.
 */
import type { ActionRowView, EmbedFieldView, EmbedView } from "@sbr/shared-types";
import {
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from "discord.js";

import { VIEW_COLORS } from "@sbr/embed-kit";

import { toActionRow } from "./render.js";

/**
 * What one V2 message may hold.
 *
 * Both are hard rejections rather than truncations on Discord's side, and both
 * count everything in the message, nested components included. The renderer
 * spends them in reading order — header first, facts next, footer last — so
 * that a card which runs out of room loses its tail rather than its subject.
 */
export const V2_LIMITS = {
  /** Total components in the message, counting nesting. */
  components: 40,
  /** Total characters across every text display in the message. */
  characters: 4000,
} as const;

/** The flag that makes Discord read `components` as the whole message. */
export const V2_FLAG = MessageFlags.IsComponentsV2;

const MAX_AUTHOR_NAME = 256;

function clamp(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/** Discord's small grey text — the V2 stand-in for author and footer rows. */
function subtext(text: string): string {
  return text
    .split("\n")
    .map((line) => `-# ${line}`)
    .join("\n");
}

function hairline(): SeparatorBuilder {
  return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
}

function display(content: string): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(content);
}

/**
 * Author, title and description as one block.
 *
 * An embed drew three separate regions here; a container has only text, so the
 * hierarchy is markdown: the subject is subtext above the heading, the heading
 * is `##`, and the headline number stays a plain paragraph under it.
 */
export function headerContent(view: EmbedView): string {
  const lines: string[] = [];
  if (view.author) lines.push(subtext(clamp(view.author.name, MAX_AUTHOR_NAME)));
  if (view.title) lines.push(view.url ? `## [${view.title}](${view.url})` : `## ${view.title}`);
  else if (view.url) lines.push(view.url);
  if (view.description) lines.push(view.description);
  return lines.join("\n");
}

/**
 * One field as text.
 *
 * An inline field was a narrow column with its label above the value; the
 * closest honest V2 rendering is the label bolded on the same line, because a
 * container has no columns and faking them with padding breaks on mobile.
 */
export function fieldContent(field: EmbedFieldView): string {
  const name = field.name.trim();
  const value = field.value.trim();
  if (!value) return name;
  if (!name) return value;
  return field.inline ? `**${name}** ${value}` : `**${name}**\n${value}`;
}

/**
 * Fields as text displays: one per block field, one per run of inline ones.
 *
 * Merging the inline run is what keeps a card of eight facts from spending
 * eight of the forty component slots, and it reads the way the embed did — a
 * tight group of short facts, then a break.
 */
export function fieldBlocks(fields: readonly EmbedFieldView[]): string[] {
  const blocks: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length) blocks.push(run.join("\n"));
    run = [];
  };
  for (const field of fields) {
    const content = fieldContent(field);
    if (!content.trim()) continue;
    if (field.inline) run.push(content);
    else {
      flush();
      blocks.push(content);
    }
  }
  flush();
  return blocks;
}

/** Discord's relative-time tag, which stays correct after the send. */
export function timestampTag(iso: string): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return `<t:${Math.floor(at / 1000)}:R>`;
}

/** Footer and age on one subtext line, joined the way the style guide joins. */
export function footerContent(view: EmbedView): string {
  const parts: string[] = [];
  if (view.footer) parts.push(view.footer);
  if (view.timestamp) {
    const tag = timestampTag(view.timestamp);
    if (tag) parts.push(tag);
  }
  return parts.length ? subtext(parts.join(" · ")) : "";
}

/**
 * A budget over both limits at once.
 *
 * Every addition asks first. A card that would go over stops adding rather
 * than being rejected whole by Discord — the same trade the embed renderer
 * makes when it truncates a select menu.
 */
class Budget {
  private components = 1; // the container itself
  private characters = 0;

  take(content: string, slots: number): boolean {
    if (this.components + slots > V2_LIMITS.components) return false;
    if (this.characters + content.length > V2_LIMITS.characters) return false;
    this.components += slots;
    this.characters += content.length;
    return true;
  }
}

/**
 * One card as a container.
 *
 * Built in reading order, so a budget that runs out drops the least important
 * end. The thumbnail rides as a section accessory beside the header, which is
 * where an embed put it; with no thumbnail the header is a plain text display,
 * because a section without an accessory is not a legal component.
 */
export function toContainer(
  view: EmbedView,
  rows: readonly ActionRowView[] = [],
  options: { readonly lead?: string | null } = {},
): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(VIEW_COLORS[view.color ?? "NEUTRAL"]);
  const budget = new Budget();

  // The lead is the ping line an announcement used to put in `content`. V2 has
  // no `content`, so it becomes the first line inside the card — which is also
  // where it read from, above the thing it is announcing.
  if (options.lead && budget.take(options.lead, 1)) {
    container.addTextDisplayComponents(display(options.lead));
  }

  const header = headerContent(view);
  const thumbnail = view.thumbnailUrl ?? view.author?.iconUrl;
  if (header) {
    if (thumbnail && budget.take(header, 3)) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(display(header))
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnail)),
      );
    } else if (budget.take(header, 1)) {
      container.addTextDisplayComponents(display(header));
    }
  }

  const blocks = fieldBlocks(view.fields ?? []);
  if (blocks.length && budget.take("", 1)) container.addSeparatorComponents(hairline());
  for (const block of blocks) {
    if (!budget.take(block, 1)) break;
    container.addTextDisplayComponents(display(block));
  }

  if (view.imageUrl) {
    const url = view.imageUrl;
    if (budget.take("", 2)) {
      container.addMediaGalleryComponents((gallery) => gallery.addItems((item) => item.setURL(url)));
    }
  }

  const footer = footerContent(view);
  if (footer && budget.take(footer, 2)) {
    container.addSeparatorComponents(hairline());
    container.addTextDisplayComponents(display(footer));
  }

  // The controls live inside the container rather than under it: a button that
  // acts on this card belongs to the card, and a container edge drawn above a
  // detached row reads as two messages.
  for (const row of rows) {
    // A row is one component plus its children; five buttons is the row cap.
    if (!budget.take("", 1 + (row.select ? 1 : Math.max(1, row.buttons.length)))) break;
    container.addActionRowComponents(toActionRow(row));
  }

  return container;
}

/**
 * A plain sentence as a container.
 *
 * V2 forbids `content`, so a reply that carried only text still needs a
 * component to say it in. Same accent rule: one colour, on the container.
 */
export function toTextContainer(
  text: string,
  color: EmbedView["color"] = "NEUTRAL",
): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(VIEW_COLORS[color ?? "NEUTRAL"])
    .addTextDisplayComponents(display(clamp(text, V2_LIMITS.characters)));
}
