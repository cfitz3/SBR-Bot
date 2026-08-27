/**
 * The card builder — the house embed style as a function rather than a habit.
 *
 * `style.ts` already wrote the style down and could tell you when a card broke
 * it. That caught drift after the fact, which is better than nothing and is
 * still not enough: the checker runs in tests, and a renderer written on Friday
 * against no shared builder will break the same rules the same way every time,
 * because the easiest thing to write is whatever the last renderer did.
 *
 * So the principles that can be *structural* are structural here, and the ones
 * that can only be judged stay warnings in `style.ts`:
 *
 *  - identity goes in `author` + `thumbnailUrl`, freeing the title for the
 *    card's actual subject — `player()` builds both from one uuid;
 *  - the headline goes in `description`, because `card()` takes it as
 *    `headline` and there is no other place to put a sentence;
 *  - freshness goes in the native `timestamp`, because `card()` takes a
 *    `StalenessView` and refuses to route the age anywhere else;
 *  - one progress bar and one marker glyph, both read from the theme, so
 *    "which bar does this command use" stops being a question;
 *  - empty fields are dropped rather than sent, because one of them fails the
 *    whole message;
 *  - the last inline row is padded, so a data-dependent field count cannot
 *    leave a lone stretched field at the bottom.
 *
 * Deliberately discord.js-free, like the rest of this file's neighbours: it
 * returns an `EmbedView`, which the panel and the guild-chat flattener consume
 * too.
 */
import { theme } from "@sbr/brand";
import {
  padInlineRow,
  type EmbedAuthorView,
  type EmbedFieldView,
  type EmbedView,
  type StalenessView,
  type ViewColor,
} from "@sbr/shared-types";

const GLYPHS = theme.embed.glyphs;
const AVATARS = theme.embed.avatars;
const SEPARATOR = theme.embed.style.separator;

/**
 * `▰▰▰▱▱▱▱▱▱▱` — the one progress bar.
 *
 * There were two before this: `▰▱` in the standing card and `█░` in goals and
 * achievements, both ten wide, both meaning progress, and a member could see
 * both in the same channel within a minute. The glyphs come from the theme so
 * changing them is one edit rather than a grep.
 *
 * The fraction is clamped rather than trusted. Callers derive it from a division
 * — `intoLevel / levelSpan` — and both a zero span and an over-cap XP total are
 * real states that would otherwise produce a bar of `NaN` repeats, which throws.
 */
export function progressBar(fraction: number, width: number = GLYPHS.barWidth): string {
  const safe = clampFraction(fraction);
  const filled = Math.round(safe * width);
  return GLYPHS.barFilled.repeat(filled) + GLYPHS.barEmpty.repeat(width - filled);
}

/** A bar with its own percentage, for the cards that showed one anyway. */
export function progressLine(fraction: number, width: number = GLYPHS.barWidth): string {
  const safe = clampFraction(fraction);
  return `${progressBar(safe, width)} ${Math.round(safe * 100)}%`;
}

/**
 * Only NaN falls to empty. An infinite fraction is what an over-cap XP total
 * divided by a zero span produces, and "past the end" is a full bar, not a blank
 * one — reporting no progress for someone who finished would be the wrong lie.
 */
function clampFraction(fraction: number): number {
  return Number.isNaN(fraction) ? 0 : Math.min(1, Math.max(0, fraction));
}

/**
 * Whether a value has reached its cap.
 *
 * A function rather than an inline `>=` because the caps themselves are the
 * thing that has been wrong: Hunting was checked against 50 when it stops at 25,
 * Foraging against 57 when it stops at 60, so one skill could never be marked
 * and another was marked three levels early. A single predicate means a wrong
 * cap is one wrong number in a table, not a wrong comparison in a renderer.
 *
 * An unknown value is not capped. It is also not *un*-capped, but a card has to
 * print something, and claiming somebody maxed a skill we could not read is the
 * worse of the two errors.
 */
export function isCapped(value: number | null | undefined, cap: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= cap;
}

/**
 * The qualifying mark, or nothing.
 *
 * Every card that flags an entry calls this, so the flag cannot mean one thing
 * on `/skills` and another on `/slayers`, and cannot be applied to some rows and
 * forgotten on others — the old `/skills` marked the name string it happened to
 * be building at the time, which is precisely the per-field drift this replaces.
 */
export function marker(qualifies: boolean): string {
  return qualifies ? GLYPHS.marker : "";
}

/** `marker(isCapped(...))`, which is how nearly every caller wants it. */
export function capMarker(value: number | null | undefined, cap: number): string {
  return marker(isCapped(value, cap));
}

/** One labelled fact on its own line inside a consolidated field. */
export interface Fact {
  readonly label: string;
  readonly value: string | number | null | undefined;
}

/**
 * Several small facts as one multi-line field value.
 *
 * Six one-word facts as six inline fields wrap into a ragged block on a phone
 * and waste two thirds of the card on labels. As one field they read as a list,
 * which is what they are.
 *
 * An unknown value prints as the theme's unknown marker rather than being
 * dropped: a missing line and a line reading `—` say different things, and
 * "we could not read this" is usually the more useful of the two. A caller that
 * genuinely wants a fact gone omits it before calling.
 */
export function facts(entries: readonly Fact[]): string {
  return entries
    .map(({ label, value }) => {
      const printed =
        value === null || value === undefined || value === "" ? theme.embed.style.unknown : String(value);
      return `**${label}** ${printed}`;
    })
    .join("\n");
}

/** Several facts on one line — `cata 42 · sa 51.3`. */
export function inlineFacts(entries: readonly Fact[]): string {
  return entries
    .map(({ label, value }) => {
      const printed =
        value === null || value === undefined || value === "" ? theme.embed.style.unknown : String(value);
      return `${label} ${printed}`;
    })
    .join(SEPARATOR);
}

/**
 * The author row and thumbnail for a Minecraft player, from one uuid.
 *
 * Both halves together, because the split is the point: the name and a small
 * head go in the author row, the larger render goes in the thumbnail, and the
 * title is then free to say what the card is actually about. A renderer that
 * called two helpers could set one and forget the other.
 *
 * A caller with no uuid still gets an author row. An unlinked or unresolved
 * player has a name worth printing, and a card that dropped the identity because
 * it could not draw a face would be strictly worse.
 */
export function player(name: string, uuid?: string | null): {
  readonly author: EmbedAuthorView;
  readonly thumbnailUrl?: string;
} {
  if (!uuid) return { author: { name } };
  const id = uuid.replace(/-/g, "");
  return {
    author: { name, iconUrl: AVATARS.head.replace("{uuid}", id) },
    thumbnailUrl: AVATARS.body.replace("{uuid}", id),
  };
}

/**
 * A field, or nothing.
 *
 * Discord rejects the entire message for one empty field value, so a card built
 * from data that might be absent — a rank with nobody online, a category with no
 * items — has to decide per field whether it exists at all. Returning `null` and
 * letting `card()` filter is how that decision stays one word at the call site.
 */
export function field(name: string, value: string, inline = false): EmbedFieldView | null {
  return value.trim() === "" ? null : { name, value, inline };
}

export interface CardSpec {
  /** Required. A tone is a choice; leaving it out was only ever an oversight. */
  readonly tone: ViewColor;
  /** What the card is about — not who it is about. Identity goes in `subject`. */
  readonly title?: string;
  /** The headline number or insight, in the reader's first line. */
  readonly headline?: string;
  /** Identity: the `player()` result, or an author row built by hand. */
  readonly subject?: { readonly author: EmbedAuthorView; readonly thumbnailUrl?: string };
  readonly thumbnailUrl?: string;
  readonly imageUrl?: string;
  readonly url?: string;
  /** `null` entries are dropped — see `field()`. */
  readonly fields?: readonly (EmbedFieldView | null | undefined)[];
  /** A static caption only. Anything time-relative belongs in `freshness`. */
  readonly footer?: string;
  /** Freshness as `staleness(envelope)` returns it: a timestamp, and a caveat. */
  readonly freshness?: StalenessView;
  /** An explicit timestamp, for cards with no envelope behind them. */
  readonly timestamp?: string;
}

/**
 * Build a card.
 *
 * Everything here is either a rule that can be enforced without judgement, or a
 * shape that makes the judgement call obvious. What it deliberately does *not*
 * do is second-guess the field count: four to six is the budget, `style.ts`
 * warns when a card misses it, and a renderer that has a real reason to carry
 * nine says so by ignoring the rule by id rather than by being silently trimmed
 * to six. Dropping a member's data to satisfy a taste constant is not a fix.
 */
export function card(spec: CardSpec): EmbedView {
  const fields = (spec.fields ?? []).filter((f): f is EmbedFieldView => f != null && f.value.trim() !== "");
  const footers = [spec.footer, spec.freshness?.footer].filter((f): f is string => !!f && f.trim() !== "");
  const view: {
    -readonly [K in keyof EmbedView]: EmbedView[K];
  } = { color: spec.tone };

  if (spec.title) view.title = spec.title;
  if (spec.headline) view.description = spec.headline;
  if (spec.subject) {
    view.author = spec.subject.author;
    if (spec.subject.thumbnailUrl) view.thumbnailUrl = spec.subject.thumbnailUrl;
  }
  if (spec.thumbnailUrl) view.thumbnailUrl = spec.thumbnailUrl;
  if (spec.imageUrl) view.imageUrl = spec.imageUrl;
  if (spec.url) view.url = spec.url;
  if (fields.length) view.fields = padInlineRow(fields);
  if (footers.length) view.footer = footers.join(SEPARATOR);

  // One timestamp, and the envelope's own reading wins over a caller's guess at
  // "now" — the age of the data is a fact about the data, not about the send.
  const timestamp = spec.freshness?.timestamp ?? spec.timestamp;
  if (timestamp) view.timestamp = timestamp;

  return view;
}
