/**
 * Reading a specimen: raw Discord embed JSON → the platform's `EmbedView`.
 *
 * This is the teaching channel. The operator builds a card they want in
 * Discohook (or copies one out of another bot with "Copy JSON"), drops it in
 * `design/embeds/`, and this module turns it into the same shape our renderers
 * return — so the target and the current output can be put side by side, and so
 * the parts of the design our view model *cannot express* are named rather than
 * silently lost.
 *
 * That last part is the point. `EmbedView` is deliberately small; when a
 * specimen uses an author line, an image, or a colour that is not in the palette,
 * the honest answer is either "widen the view model" or "we don't do that", and
 * both need someone to see it first. Dropping it quietly decides by accident.
 */
import type { EmbedFieldView, EmbedView, ViewColor } from "@sbr/shared-types";
import { VIEW_COLORS } from "./style.js";

export interface SpecimenNote {
  /** Which embed in the payload, 0-based. */
  readonly index: number;
  readonly detail: string;
}

export interface SpecimenResult {
  readonly views: readonly EmbedView[];
  /** Everything the conversion could not carry, in the operator's terms. */
  readonly notes: readonly SpecimenNote[];
}

/** Fields of a Discord embed that `EmbedView` has no home for. */
const UNSUPPORTED: readonly { readonly key: string; readonly why: string }[] = [
  { key: "author", why: "author line (name/icon above the title)" },
  { key: "image", why: "full-width image" },
  { key: "video", why: "video" },
  { key: "provider", why: "provider" },
  { key: "timestamp", why: "timestamp (we put staleness in the footer instead — stalenessFooter)" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * A raw colour back to a palette name.
 *
 * Exact matches are silent. Anything else is reported *and* mapped to its
 * nearest neighbour, because a specimen is a design to learn from, not a config
 * to obey: if the operator keeps choosing a colour we don't have, that is an
 * argument for adding one to `VIEW_COLORS`, not for letting one card go rogue.
 */
export function nearestColor(hex: number): { readonly color: ViewColor; readonly exact: boolean } {
  const entries = Object.entries(VIEW_COLORS) as readonly [ViewColor, number][];
  const exact = entries.find(([, value]) => value === hex);
  if (exact) return { color: exact[0], exact: true };

  const channels = (n: number): readonly number[] => [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const target = channels(hex);
  let best: ViewColor = "NEUTRAL";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [name, value] of entries) {
    const distance = channels(value).reduce((sum, c, i) => sum + (c - (target[i] ?? 0)) ** 2, 0);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  return { color: best, exact: false };
}

function toHex(value: number): string {
  return `#${value.toString(16).padStart(6, "0")}`;
}

function readFields(raw: unknown, index: number, notes: SpecimenNote[]): readonly EmbedFieldView[] {
  if (!Array.isArray(raw)) return [];
  const out: EmbedFieldView[] = [];
  raw.forEach((entry, i) => {
    if (!isRecord(entry)) return;
    const name = str(entry["name"]);
    const value = str(entry["value"]);
    if (name === undefined || value === undefined) {
      notes.push({ index, detail: `field[${i}] has no name or no value — skipped.` });
      return;
    }
    out.push(entry["inline"] === true ? { name, value, inline: true } : { name, value });
  });
  return out;
}

function readEmbed(raw: Record<string, unknown>, index: number, notes: SpecimenNote[]): EmbedView {
  for (const { key, why } of UNSUPPORTED) {
    if (raw[key] !== undefined && raw[key] !== null) {
      notes.push({ index, detail: `dropped ${why} — EmbedView has no field for it.` });
    }
  }

  const view: {
    -readonly [K in keyof EmbedView]: EmbedView[K];
  } = {};

  const title = str(raw["title"]);
  if (title !== undefined) view.title = title;
  const description = str(raw["description"]);
  if (description !== undefined) view.description = description;
  const url = str(raw["url"]);
  if (url !== undefined) view.url = url;

  const fields = readFields(raw["fields"], index, notes);
  if (fields.length > 0) view.fields = fields;

  const footer = raw["footer"];
  if (isRecord(footer)) {
    const text = str(footer["text"]);
    if (text !== undefined) view.footer = text;
    if (footer["icon_url"] !== undefined) {
      notes.push({ index, detail: "dropped footer icon — our footers are text only." });
    }
  }

  const thumbnail = raw["thumbnail"];
  if (isRecord(thumbnail)) {
    const thumbUrl = str(thumbnail["url"]);
    if (thumbUrl !== undefined) view.thumbnailUrl = thumbUrl;
  }

  const color = raw["color"];
  if (typeof color === "number" && Number.isFinite(color)) {
    const match = nearestColor(color);
    view.color = match.color;
    if (!match.exact) {
      notes.push({
        index,
        detail: `colour ${toHex(color)} is not in the palette — read as ${match.color} (${toHex(VIEW_COLORS[match.color])}). Add it to VIEW_COLORS if it is meant to stay.`,
      });
    }
  }

  return view;
}

/**
 * Parse a Discohook payload, a bare embed, or an array of embeds.
 *
 * Tolerant on the way in by design — this is a file a human pasted, and the
 * three shapes above are all things Discord's own tooling hands out. Strict
 * about what it reports: nothing is dropped without a note.
 */
export function fromDiscordJson(raw: unknown): SpecimenResult {
  const notes: SpecimenNote[] = [];
  const embeds: unknown[] = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw["embeds"])
      ? raw["embeds"]
      : isRecord(raw)
        ? [raw]
        : [];

  if (isRecord(raw) && str(raw["content"]) !== undefined) {
    notes.push({ index: 0, detail: "dropped message content — a reply's text lives in ReplyView.text." });
  }

  const views: EmbedView[] = [];
  embeds.forEach((embed, i) => {
    if (!isRecord(embed)) {
      notes.push({ index: i, detail: "not an object — skipped." });
      return;
    }
    views.push(readEmbed(embed, i, notes));
  });

  return { views, notes };
}

/** `EmbedView` back to raw Discord JSON, for the preview page and round-tripping. */
export function toDiscordJson(view: EmbedView): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (view.title !== undefined) out["title"] = view.title;
  if (view.description !== undefined) out["description"] = view.description;
  if (view.url !== undefined) out["url"] = view.url;
  if (view.color !== undefined) out["color"] = VIEW_COLORS[view.color];
  if (view.fields !== undefined) {
    out["fields"] = view.fields.map((f) => ({ name: f.name, value: f.value, inline: f.inline === true }));
  }
  if (view.footer !== undefined) out["footer"] = { text: view.footer };
  if (view.thumbnailUrl !== undefined) out["thumbnail"] = { url: view.thumbnailUrl };
  return out;
}
