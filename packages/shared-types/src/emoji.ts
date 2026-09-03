/**
 * What Discord will accept where a component asks for an emoji.
 *
 * The failure this exists to close:
 *
 * ```
 * DiscordAPIError[50035]: Invalid Form Body
 * components[0].components[0].emoji.name[COMPONENT_INVALID_EMOJI]
 * ```
 *
 * A staffer typed something emoji-ish into the ticket category editor — a `:)`,
 * a pasted `:tada:` shortcode, half a flag, a stray letter — and it was stored
 * verbatim and handed to `setEmoji`. Discord rejects the *whole message* over
 * it, so one bad glyph on one category took down the entire ticket panel, and
 * the error named a component index rather than the category.
 *
 * Two rules follow from that, and both are implemented here:
 *
 * 1. **Nothing unvalidated reaches a payload.** The renderer normalises every
 *    emoji it is handed and drops what it cannot vouch for, because dropping
 *    one glyph is a smaller failure than dropping the message it was on.
 * 2. **The editor says no first.** A panel that accepts `:)` and silently
 *    renders nothing is a bug report waiting to happen; the save is refused
 *    with a sentence naming what is wrong.
 *
 * Deliberately in shared-types rather than in the renderer: the validator and
 * the renderer must agree exactly, and two copies of a regex this fiddly would
 * not stay in agreement.
 */

/** A custom emoji, in the form the gateway reports it. */
export interface CustomEmoji {
  readonly kind: "custom";
  /** `star` in `<:star:123>`. Discord uses it only as a label. */
  readonly name: string;
  /** The snowflake, which is the part that identifies the emoji. */
  readonly id: string;
  readonly animated: boolean;
}

/** A Unicode emoji, as one grapheme cluster. */
export interface UnicodeEmoji {
  readonly kind: "unicode";
  readonly value: string;
}

export type ParsedEmoji = CustomEmoji | UnicodeEmoji;

/**
 * A Unicode emoji, or a sequence that renders as one.
 *
 * Built from the pieces rather than from a list, because a list of emoji goes
 * out of date every Unicode release and Discord accepts whatever the client can
 * render. In order: a flag (two regional indicators), or a keycap (a digit or
 * `#`/`*`, a variation selector, the keycap mark), or a pictograph with its
 * optional skin-tone modifier and variation selector, followed by any number of
 * zero-width-joined pictographs — which is what a family, a profession or a
 * flag-with-a-symbol actually is.
 *
 * `Extended_Pictographic` rather than `Emoji`: the latter matches bare digits
 * and `#`, which Discord does not accept on their own, and which is one of the
 * ways a staffer's typo became a rejected payload.
 */
/** Variation selectors (emoji and text presentation) and the keycap mark. */
const VS16 = "\\uFE0F";
const VS15 = "\\uFE0E";
const KEYCAP = "\\u20E3";
const ZWJ = "\\u200D";

const PICTOGRAPH = `\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|${VS16}|${VS15})*`;
const UNICODE_EMOJI = new RegExp(
  "^(?:" +
    "\\p{Regional_Indicator}\\p{Regional_Indicator}" +
    `|[0-9#*]${VS16}?${KEYCAP}` +
    `|${PICTOGRAPH}(?:${ZWJ}${PICTOGRAPH})*` +
    ")$",
  "u",
);

/** Whether a single character is emoji-ish, for the "that was two emoji" hint. */
const PICTOGRAPH_CHAR = /\p{Extended_Pictographic}/u;

/** `<a:name:id>`, `<:name:id>`, or the stored `name:id` the gateway reports. */
const CUSTOM_EMOJI =
  /^(?:<(a?):([A-Za-z0-9_]{2,32}):([0-9]{15,25})>|(a?):?([A-Za-z0-9_]{2,32}):([0-9]{15,25}))$/;

/**
 * Read an emoji, whatever form it was typed in.
 *
 * Null for anything this cannot vouch for — a shortcode Discord never expands
 * outside its own client (`:tada:`), an ASCII face, a word, a lone letter, or
 * an emoji with something else stuck to it. Null is the whole point: it is what
 * lets both callers do the right thing instead of hoping.
 */
export function parseEmoji(raw: string | null | undefined): ParsedEmoji | null {
  const text = (raw ?? "").trim();
  if (text === "") return null;

  const custom = CUSTOM_EMOJI.exec(text);
  if (custom !== null) {
    const animated = (custom[1] ?? custom[4] ?? "") === "a";
    const name = custom[2] ?? custom[5] ?? "";
    const id = custom[3] ?? custom[6] ?? "";
    return { kind: "custom", name, id, animated };
  }

  return UNICODE_EMOJI.test(text) ? { kind: "unicode", value: text } : null;
}

/**
 * The form the platform stores and the gateway reports.
 *
 * A custom emoji is stored `name:id` rather than `<:name:id>` because that is
 * what a reaction event carries, and storing the other form is how a trigger
 * rule can look correct and never match.
 */
export function formatEmoji(emoji: ParsedEmoji): string {
  return emoji.kind === "unicode"
    ? emoji.value
    : `${emoji.animated ? "a:" : ""}${emoji.name}:${emoji.id}`;
}

/**
 * What discord.js `setEmoji` is given.
 *
 * A custom emoji is identified by its id; the name rides along as the label
 * Discord shows if the emoji is later deleted. A Unicode emoji is a name and
 * nothing else — passing an id for one is the other half of the 50035 above.
 */
export function emojiPayload(emoji: ParsedEmoji): {
  name?: string;
  id?: string;
  animated?: boolean;
} {
  return emoji.kind === "unicode"
    ? { name: emoji.value }
    : { id: emoji.id, name: emoji.name, animated: emoji.animated };
}

/**
 * Normalise for storage, or say what is wrong with it in one sentence.
 *
 * The sentence is for a person editing a ticket category, so it names what they
 * typed rather than a component index, and it says what would work.
 */
export function normalizeEmoji(
  raw: string | null | undefined,
): { ok: true; value: string | null } | { ok: false; reason: string } {
  const text = (raw ?? "").trim();
  if (text === "") return { ok: true, value: null };

  const parsed = parseEmoji(text);
  if (parsed !== null) return { ok: true, value: formatEmoji(parsed) };

  // The two near-misses worth naming, because they are what people actually
  // paste: a Discord shortcode, and more than one emoji in the box.
  if (/^:[A-Za-z0-9_]+:$/.test(text)) {
    return {
      ok: false,
      reason: `“${text}” is a Discord shortcode, which only works while you are typing in Discord. Paste the emoji itself, or a custom one as <:name:id>.`,
    };
  }
  if (Array.from(text).some((character) => PICTOGRAPH_CHAR.test(character))) {
    return {
      ok: false,
      reason: `“${text}” is more than one emoji, or an emoji with other characters attached. Use exactly one.`,
    };
  }
  return {
    ok: false,
    reason: `“${text}” is not an emoji. Use one emoji, or a custom one as <:name:id>.`,
  };
}
