/**
 * Transport-agnostic presentation types.
 *
 * The same command logic has to render three ways: a rich Discord embed, a
 * single ~256-character line in Minecraft guild chat, and plain JSON for the web
 * panel (COMMANDS.md §17). So handlers return a *view model* and each transport
 * renders it — a handler that built `EmbedBuilder` directly could only ever
 * serve Discord.
 *
 * Colours and button styles are semantic rather than hex/enum values for the
 * same reason: `DANGER` means something in guild chat too, `0xED4245` does not.
 */
import type { DataEnvelope } from "./common.js";

export type ViewColor = "NEUTRAL" | "INFO" | "SUCCESS" | "WARNING" | "DANGER";

export interface EmbedFieldView {
  /**
   * A stable label. Never the data itself: a name that reads `Combat 60 ✦`
   * changes shape as the numbers move, so nothing can be scanned down a column
   * and a card's structure is different for every member. The label goes here,
   * the variable part goes in `value`.
   */
  readonly name: string;
  readonly value: string;
  readonly inline?: boolean;
}

/**
 * Who the card is about.
 *
 * Player identity belongs here and in `thumbnailUrl`, not in the title — a card
 * titled `Aria's skills` spends its most prominent line on a name Discord will
 * render again in the author row anyway, and leaves nowhere for the card's
 * actual subject to go.
 */
export interface EmbedAuthorView {
  readonly name: string;
  /** Small round icon beside the name — a player head, usually. */
  readonly iconUrl?: string;
  readonly url?: string;
}

export interface EmbedView {
  readonly title?: string;
  /** The headline number or insight. Never buried in a field. */
  readonly description?: string;
  readonly fields?: readonly EmbedFieldView[];
  /**
   * A genuinely static caption, and only that.
   *
   * Anything time-relative belongs in `timestamp`, which Discord renders and
   * keeps correct on its own. A footer reading "as of 13d ago" was written once
   * and is wrong from the second it was sent — see `staleness`.
   */
  readonly footer?: string;
  readonly color?: ViewColor;
  readonly author?: EmbedAuthorView;
  readonly thumbnailUrl?: string;
  /** Full-width image below the fields — a graph, or the link-help GIF. */
  readonly imageUrl?: string;
  /** ISO-8601. Discord renders it in the reader's own locale and tense. */
  readonly timestamp?: string;
  readonly url?: string;
}

export type ButtonStyle = "PRIMARY" | "SECONDARY" | "SUCCESS" | "DANGER" | "LINK";

export interface ButtonView {
  readonly label: string;
  readonly style: ButtonStyle;
  /**
   * Routed by the transport's component router. Encode all the state the handler
   * needs (`rsvp:<eventId>:GOING`) rather than holding it in memory — buttons
   * outlive the process that sent them.
   */
  readonly customId?: string;
  /** LINK buttons carry a url instead of a customId. */
  readonly url?: string;
  readonly emoji?: string;
  readonly disabled?: boolean;
}

export interface SelectOptionView {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
  readonly emoji?: string;
  readonly default?: boolean;
}

/**
 * A dropdown. Same routing contract as `ButtonView.customId` — all state in the
 * id, because a menu outlives the process that sent it.
 *
 * Ticket panels are why this exists: Discord caps a row at five buttons, so a
 * guild offering more than five categories has to be given a menu rather than a
 * truncated set of buttons.
 */
export interface SelectMenuView {
  readonly customId: string;
  readonly placeholder?: string;
  readonly options: readonly SelectOptionView[];
  readonly minValues?: number;
  readonly maxValues?: number;
  readonly disabled?: boolean;
}

/**
 * One row of components. A row holds buttons *or* a select menu, never both —
 * that is Discord's rule, not ours — so `select` being set means `buttons` is
 * empty and the transport renders the menu.
 */
export interface ActionRowView {
  readonly buttons: readonly ButtonView[];
  readonly select?: SelectMenuView;
}

/**
 * The separator between facts on a flattened line.
 *
 * This used to be a hardcoded `" | "` — the string the platform's own embed style
 * checker flags as wrong. It is declared here rather than read from `@sbr/brand`
 * because `@sbr/brand` depends on this package, so importing it back would be a
 * cycle. `packages/discord-kit/src/style.test.ts` asserts this default and
 * `theme.embed.style.separator` agree, so the two cannot drift apart again.
 */
export const FLATTEN_SEPARATOR = " · ";

/**
 * Render an embed down to one line, for guild chat and plain-text fallbacks.
 *
 * `separator` is defaulted rather than fixed so a caller that has the resolved
 * theme in scope — every renderer in `discord-kit` does — can pass the operator's
 * choice through.
 */
export function flattenEmbed(embed: EmbedView, maxLength = 256, separator = FLATTEN_SEPARATOR): string {
  const parts: string[] = [];
  // The author row carries the identity that used to sit in the title, so a flat
  // line that skipped it would no longer say who it was about.
  if (embed.author) parts.push(embed.author.name);
  if (embed.title) parts.push(embed.title);
  if (embed.description) parts.push(embed.description);
  for (const field of embed.fields ?? []) parts.push(`${field.name} ${field.value}`);

  const line = parts.join(separator).replace(/\s+/g, " ").trim();
  return line.length <= maxLength ? line : `${line.slice(0, maxLength - 1)}…`;
}

/**
 * Discord packs inline fields three to a row. Declared here for the same reason
 * as `FLATTEN_SEPARATOR` — the renderers that need it live in packages that
 * cannot import `@sbr/brand` — and asserted against `theme.embed.style.inlineRow`
 * in `packages/discord-kit/src/style.test.ts`.
 */
export const INLINE_ROW = 3;

/** A field that occupies a column without claiming anything is in it. */
const SPACER: EmbedFieldView = { name: "​", value: "​", inline: true };

/**
 * Complete the final inline row with spacers.
 *
 * A run of four inline fields renders as three in a row and one alone on the
 * next, stretched across the width — the single most common reason our cards
 * look unfinished, and the thing `inline.ragged` flags. Padding keeps the last
 * field in its column instead.
 *
 * Only trailing inline fields are padded, and a run that already fills its row
 * is returned untouched, so this is safe to wrap any field list in. The spacer
 * is a zero-width space rather than an empty string: Discord rejects an empty
 * field value and would fail the whole message.
 */
export function padInlineRow(fields: readonly EmbedFieldView[], width = INLINE_ROW): readonly EmbedFieldView[] {
  let run = 0;
  for (let i = fields.length - 1; i >= 0 && fields[i]?.inline === true; i -= 1) run += 1;
  if (run === 0) return fields;
  const short = run % width;
  if (short === 0) return fields;
  return [...fields, ...Array.from({ length: width - short }, () => SPACER)];
}

/** "4m", "2h", "3d" — compact enough for an embed footer or a chat line. */
export function describeAge(fetchedAt: string, now: number = Date.now()): string {
  const ms = now - Date.parse(fetchedAt);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The two card fields an envelope's freshness decides. */
export interface StalenessView {
  /** ISO-8601 — Discord renders the age, and re-renders it as it grows. */
  readonly timestamp: string;
  /** Present only when there is a caveat; the age alone is not one. */
  readonly footer?: string;
}

/**
 * How old a reading is, split into the part Discord should own and the part we
 * should say.
 *
 * This used to be one string — `"as of 4m ago"` in the footer — and it was wrong
 * within minutes of being sent, because a footer is baked at send time while the
 * card stays on screen. Anyone scrolling back through `/skills` was reading an
 * "as of" that had drifted by however long they had been away. The age is now a
 * native `timestamp`, which Discord recomputes on every render.
 *
 * What survives as a footer is the part that *is* static: STALE means we served
 * numbers we could not refresh, and that claim does not decay. `LIVE` says
 * nothing at all, because the timestamp already did.
 */
export function staleness<T>(envelope: DataEnvelope<T>): StalenessView {
  if (envelope.freshness === "STALE") return { timestamp: envelope.fetchedAt, footer: "⚠ cached — refresh failed" };
  if (envelope.source === "CACHE") return { timestamp: envelope.fetchedAt, footer: "served from cache" };
  return { timestamp: envelope.fetchedAt };
}
