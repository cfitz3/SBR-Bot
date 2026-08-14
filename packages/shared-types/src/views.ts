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
  readonly name: string;
  readonly value: string;
  readonly inline?: boolean;
}

export interface EmbedView {
  readonly title?: string;
  readonly description?: string;
  readonly fields?: readonly EmbedFieldView[];
  /** Usually the staleness note — see `stalenessFooter`. */
  readonly footer?: string;
  readonly color?: ViewColor;
  readonly thumbnailUrl?: string;
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

/**
 * The documented "as of Xm ago" note. STALE data says so explicitly — serving
 * old numbers silently is worse than serving them with a caveat.
 */
export function stalenessFooter<T>(envelope: DataEnvelope<T>, now: number = Date.now()): string {
  const age = describeAge(envelope.fetchedAt, now);
  if (envelope.freshness === "STALE") return `⚠ cached data — as of ${age}`;
  return envelope.source === "LIVE" ? `as of ${age}` : `cached — as of ${age}`;
}
