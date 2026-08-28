/**
 * The house embed style, written down as data and as a checker.
 *
 * Every embed the platform sends is an `EmbedView`, and until now the only thing
 * enforcing what one should look like was whoever wrote the renderer. That is
 * why the cards drift: `/skills` grew a ragged inline row, `/audit` grew a
 * paragraph nobody reads, and neither is visible in a diff.
 *
 * So the style lives here, in two halves:
 *
 *  - **Limits** — what Discord itself rejects. Not negotiable, and violating one
 *    means the reply fails at send time rather than looking untidy.
 *  - **Style** — what *we* have decided a good card looks like. Negotiable, and
 *    meant to be edited: when the operator shows us a specimen they like (see
 *    `design/embeds/`, and docs/EMBED_STYLE.md for the loop), the outcome of
 *    that conversation is a changed constant or a changed rule in this file.
 *
 * Deliberately pure and discord.js-free: the checker runs in unit tests, in the
 * `npm run embeds` CLI, and could run in the panel, none of which want a gateway
 * client in scope.
 */
import { theme } from "@sbr/brand";
import type { EmbedFieldView, EmbedView, ViewColor } from "@sbr/shared-types";

/**
 * Semantic colour → hex. Central so every embed in the platform agrees, and so
 * an imported specimen's raw hex can be matched back to a name — a card whose
 * colour is a literal has escaped the palette, which is the drift we are trying
 * to catch.
 *
 * Now a re-export of the resolved theme rather than a list of its own. It used to
 * be a second copy of the same five numbers, with `render.ts` holding a third;
 * they agreed only because nobody had edited one of them yet.
 */
export const VIEW_COLORS: Readonly<Record<ViewColor, number>> = theme.embed.colors;

/** Discord's own caps. Exceeding one is a rejected message, not a style opinion. */
export const EMBED_LIMITS = {
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  /** Sum of every text length in a single embed. */
  total: 6000,
} as const;

/**
 * The house style. These are the numbers to argue about — each one is a taste
 * judgement, not a platform constraint, which is exactly why they are overridable
 * from `brand/theme.ts` while `EMBED_LIMITS` above is not.
 */
export const EMBED_STYLE: EmbedStyle = theme.embed.style;

export interface EmbedStyle {
  /** Past this the description is an essay; move it into fields or a page. */
  readonly descriptionLines: number;
  /** Past this the card is a wall; paginate with `paginate()` instead. */
  readonly fields: number;
  /** Discord packs inline fields three to a row. */
  readonly inlineRow: number;
  /** A footer is a caption, not a second description. */
  readonly footer: number;
  /** The separator between facts on one line: `cata 42 · sa 51.3`. */
  readonly separator: string;
  /** What an unknown value prints as. Never "N/A", never a silent zero. */
  readonly unknown: string;
  /** Below this a grid of fields was a sentence in disguise. */
  readonly minFields: number;
  /** Above this the reader is scanning, not reading. */
  readonly maxFields: number;
}

export type StyleSeverity = "error" | "warning";

export interface StyleIssue {
  /** Stable id, so docs and ignore-lists can name a rule. */
  readonly rule: string;
  readonly severity: StyleSeverity;
  /** Which part of the card — `title`, `description`, `field[3].value`, … */
  readonly where: string;
  readonly detail: string;
}

export interface CheckOptions {
  /** Rule ids to skip, for the handful of cards that break a rule on purpose. */
  readonly ignore?: readonly string[];
}

/**
 * Ids that a mention/timestamp/emoji syntax wraps are fine; a bare snowflake is
 * not. The house rule is that a member always reads as a person — the leaderboard
 * DTO even documents "never a raw id" — so this catches the renderer that forgot.
 */
const WRAPPED_ID = /<(?:@!?|@&|#|t:|a?:\w+:)\d{15,21}>/g;

/**
 * A link is an address, not a printed id.
 *
 * Discord's own URLs are built out of snowflakes — `/events/<guild>/<event>`,
 * `/channels/<guild>/<channel>/<message>` — and a card that links to one is
 * doing the opposite of what this rule guards against: the reader clicks it and
 * never sees the number. Stripped before the scan so the rule keeps catching
 * the renderer that printed an id it should have wrapped.
 */
const URL_TEXT = /https?:\/\/\S+/g;
const BARE_ID = /\b\d{17,20}\b/g;

/** Values that mean "we don't know" in some other project's dialect. */
const PLACEHOLDERS = new Set(["n/a", "na", "null", "undefined", "tbd", "???", "-", "--"]);

const SEPARATORS = [" | ", " -- ", " – "];

/**
 * Time-relative phrasing, which is only ever correct at the instant it is sent.
 *
 * A footer is baked into the message; the card stays on screen and gets scrolled
 * back to. "as of 4m ago" on a card someone opens tomorrow is not stale styling,
 * it is a false statement, and it was ours rather than Discord's. The native
 * `timestamp` field re-renders on every read, so it is the only correct place
 * for an age.
 */
const TIME_RELATIVE = /\b(?:ago|as of|just now|moments? ago|last updated|updated \d)\b/i;

/**
 * A field name carrying its own data.
 *
 * Two digits or more, because a real label can hold one — `F7`, `Top 5`, `Tier 4`
 * are labels and stay labels for every member. `Combat 60`, `Level 100` and
 * `1,240 MP` are the card describing this particular reading in the place that
 * is supposed to be the same on every card, which is what makes a column
 * unscannable.
 */
const DATA_IN_NAME = /\d{2,}/;

function textLength(view: EmbedView): number {
  let n = (view.title?.length ?? 0) + (view.description?.length ?? 0) + (view.footer?.length ?? 0);
  // The author name counts against Discord's 6000 too. It was not counted here
  // before only because the view model had nowhere to put one.
  n += view.author?.name.length ?? 0;
  for (const f of view.fields ?? []) n += f.name.length + f.value.length;
  return n;
}

/** Bare snowflakes left after every wrapped mention has been removed. */
function bareIds(text: string): readonly string[] {
  return text.replace(URL_TEXT, " ").replace(WRAPPED_ID, " ").match(BARE_ID) ?? [];
}

function checkText(text: string, where: string, out: StyleIssue[]): void {
  for (const id of bareIds(text)) {
    out.push({
      rule: "raw-id",
      severity: "warning",
      where,
      detail: `\`${id}\` is a bare snowflake — wrap it (<@id>, <#id>) or resolve it to a name.`,
    });
  }
  if (PLACEHOLDERS.has(text.trim().toLowerCase())) {
    out.push({
      rule: "placeholder",
      severity: "warning",
      where,
      detail: `unknown prints as "${EMBED_STYLE.unknown}", not "${text.trim()}".`,
    });
  }
  for (const sep of SEPARATORS) {
    if (text.includes(sep)) {
      out.push({
        rule: "separator",
        severity: "warning",
        where,
        detail: `facts on one line are joined with "${EMBED_STYLE.separator}", not "${sep}".`,
      });
      break;
    }
  }
}

/**
 * Discord renders inline fields three to a row, so a run of four leaves one
 * field alone on a second row with two empty columns beside it. That ragged
 * edge is the single most common reason our cards look unfinished.
 */
function checkInlineRuns(fields: readonly EmbedFieldView[], out: StyleIssue[]): void {
  let start = 0;
  let run = 0;
  const flush = (): void => {
    if (run > 1 && run % EMBED_STYLE.inlineRow === 1) {
      out.push({
        rule: "inline.ragged",
        severity: "warning",
        where: `field[${start}..${start + run - 1}]`,
        detail: `${run} inline fields leave a lone field on its own row — use a multiple of ${EMBED_STYLE.inlineRow}, or a spacer field.`,
      });
    }
    run = 0;
  };
  fields.forEach((field, i) => {
    if (field.inline === true) {
      if (run === 0) start = i;
      run += 1;
    } else flush();
  });
  flush();
}

/**
 * Check one card against the limits above and the style below them.
 *
 * Returns every issue rather than the first: a card is reviewed as a whole, and
 * fixing them one build at a time is how a five-minute tidy becomes an hour.
 */
export function checkEmbed(view: EmbedView, options: CheckOptions = {}): readonly StyleIssue[] {
  const out: StyleIssue[] = [];
  const limit = (rule: string, where: string, actual: number, max: number): void => {
    if (actual > max) {
      out.push({ rule, severity: "error", where, detail: `${actual} characters, Discord allows ${max}.` });
    }
  };

  if (view.title !== undefined) limit("limit.title", "title", view.title.length, EMBED_LIMITS.title);
  if (view.description !== undefined) {
    limit("limit.description", "description", view.description.length, EMBED_LIMITS.description);
  }
  if (view.footer !== undefined) limit("limit.footer", "footer", view.footer.length, EMBED_LIMITS.footer);

  const fields = view.fields ?? [];
  if (fields.length > EMBED_LIMITS.fields) {
    out.push({
      rule: "limit.fields",
      severity: "error",
      where: "fields",
      detail: `${fields.length} fields, Discord allows ${EMBED_LIMITS.fields} — paginate().`,
    });
  }
  limit("limit.total", "embed", textLength(view), EMBED_LIMITS.total);

  fields.forEach((field, i) => {
    limit("limit.field-name", `field[${i}].name`, field.name.length, EMBED_LIMITS.fieldName);
    limit("limit.field-value", `field[${i}].value`, field.value.length, EMBED_LIMITS.fieldValue);
    if (field.name.trim() === "" || field.value.trim() === "") {
      out.push({
        rule: "field.empty",
        severity: "error",
        where: `field[${i}]`,
        detail: "Discord rejects an empty field name or value — use a zero-width space deliberately, or drop the field.",
      });
    }
    checkText(field.name, `field[${i}].name`, out);
    checkText(field.value, `field[${i}].value`, out);
    if (DATA_IN_NAME.test(field.name) || field.name.includes(theme.embed.glyphs.marker)) {
      out.push({
        rule: "field.name-data",
        severity: "warning",
        where: `field[${i}].name`,
        detail: `"${field.name}" puts the reading in the label — a field name is a stable heading, the data belongs in its value.`,
      });
    }
  });

  // ── Style ──────────────────────────────────────────────────────────────────

  if (view.title === undefined && view.description === undefined && fields.length === 0) {
    out.push({
      rule: "empty",
      severity: "error",
      where: "embed",
      detail: "nothing to render — this posts as a bare coloured bar.",
    });
  }
  if (view.color === undefined) {
    out.push({
      rule: "color.missing",
      severity: "warning",
      where: "color",
      detail: "every card states a tone; NEUTRAL is a choice, absence is an oversight.",
    });
  }
  for (const url of [view.url, view.thumbnailUrl, view.imageUrl, view.author?.iconUrl, view.author?.url]) {
    if (url !== undefined && !url.startsWith("https://")) {
      out.push({ rule: "url.scheme", severity: "error", where: "url", detail: `"${url}" is not https.` });
    }
  }
  if (view.timestamp !== undefined && !Number.isFinite(Date.parse(view.timestamp))) {
    out.push({
      rule: "timestamp.invalid",
      severity: "error",
      where: "timestamp",
      detail: `"${view.timestamp}" is not a date Discord can parse — it wants ISO-8601.`,
    });
  }

  if (view.title !== undefined) {
    checkText(view.title, "title", out);
    if (/[.!]$/.test(view.title.trim())) {
      out.push({
        rule: "title.punctuation",
        severity: "warning",
        where: "title",
        detail: "a title is a label, not a sentence — drop the trailing punctuation.",
      });
    }
    const letters = view.title.replace(/[^A-Za-z]/g, "");
    if (letters.length > 3 && letters === letters.toUpperCase()) {
      out.push({
        rule: "title.shouting",
        severity: "warning",
        where: "title",
        detail: "titles are sentence case; the colour carries the urgency.",
      });
    }
  }

  if (view.description !== undefined) {
    checkText(view.description, "description", out);
    const lines = view.description.split("\n").length;
    if (lines > EMBED_STYLE.descriptionLines) {
      out.push({
        rule: "description.lines",
        severity: "warning",
        where: "description",
        detail: `${lines} lines — past ${EMBED_STYLE.descriptionLines} this belongs in fields or a second page.`,
      });
    }
    if (/^#{1,3} /m.test(view.description)) {
      out.push({
        rule: "markdown.heading",
        severity: "warning",
        where: "description",
        detail: "headings inside a card compete with its title — use **bold** for emphasis.",
      });
    }
  }

  if (fields.length > EMBED_STYLE.fields) {
    out.push({
      rule: "field.count",
      severity: "warning",
      where: "fields",
      detail: `${fields.length} fields reads as a wall — past ${EMBED_STYLE.fields}, paginate().`,
    });
  }
  // The readability budget, distinct from `field.count` above: that one is where
  // a card stops being readable at all, this one is where it stops being a good
  // card. A card with no fields is a sentence and is exempt — plenty of replies
  // are one line and should stay one line.
  if (fields.length > 0 && (fields.length < EMBED_STYLE.minFields || fields.length > EMBED_STYLE.maxFields)) {
    out.push({
      rule: "field.budget",
      severity: "warning",
      where: "fields",
      detail:
        fields.length < EMBED_STYLE.minFields
          ? `${fields.length} fields — under ${EMBED_STYLE.minFields} this reads better as a sentence in the description, or consolidated with facts().`
          : `${fields.length} fields — past ${EMBED_STYLE.maxFields} consolidate related ones into a multi-line field with facts(), or paginate().`,
    });
  }
  checkInlineRuns(fields, out);

  if (view.footer !== undefined) {
    checkText(view.footer, "footer", out);
    if (TIME_RELATIVE.test(view.footer)) {
      out.push({
        rule: "footer.time-relative",
        severity: "warning",
        where: "footer",
        detail:
          "a footer is baked at send time and this card will be read later — put the age in `timestamp`, which Discord re-renders.",
      });
    }
    if (view.footer.length > EMBED_STYLE.footer) {
      out.push({
        rule: "footer.length",
        severity: "warning",
        where: "footer",
        detail: `${view.footer.length} characters — a footer is a caption (≤${EMBED_STYLE.footer}), not a second description.`,
      });
    }
  }

  const ignore = new Set(options.ignore ?? []);
  return out.filter((issue) => !ignore.has(issue.rule));
}

/** `checkEmbed` over a set of named cards, flattened for a CLI or a test. */
export function checkEmbeds(
  cards: readonly { readonly name: string; readonly view: EmbedView }[],
  options: CheckOptions = {},
): readonly (StyleIssue & { readonly card: string })[] {
  return cards.flatMap((card) =>
    checkEmbed(card.view, options).map((issue) => ({ ...issue, card: card.name })),
  );
}
