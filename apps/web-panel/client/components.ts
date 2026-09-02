/**
 * Shared page furniture: stat tiles, badges, empty/denied/error states.
 *
 * Kept together so every page reports "nothing here", "not allowed", and
 * "something broke" in the same voice — three states that are easy to render
 * inconsistently when each page invents its own.
 */
import type { DenyReason } from "@sbr/panel-core";
import { denialMessage } from "./api.js";
import { err, state } from "./copy.js";
import { h, type Child } from "./dom.js";
import { initials } from "./icons.js";

export function pageTitle(title: string, subtitle?: string): HTMLElement {
  return h("div", { class: "page-head" }, h("h2", {}, title), subtitle ? h("p", { class: "muted" }, subtitle) : null);
}

export function statTile(label: string, value: string, note?: string | null): HTMLElement {
  return h(
    "div",
    { class: "tile" },
    h("span", { class: "tile-label" }, label),
    h("span", { class: "tile-value" }, value),
    note ? h("span", { class: "tile-note" }, note) : null,
  );
}

export type BadgeTone = "ok" | "warn" | "bad" | "neutral";

/**
 * A pill with a leading dot. The dot carries the tone so the pill can stay quiet
 * enough to sit in a dense table row, and so the state survives being read by
 * someone who can't separate the three hues.
 */
export function badge(text: string, tone: BadgeTone = "neutral"): HTMLElement {
  return h("span", { class: `badge badge-${tone}` }, h("span", { class: "badge-dot", "aria-hidden": "true" }), text);
}

/**
 * A row that is about a person: circular initials beside the name, with an
 * optional second line for the id, rank, or whatever identifies them further.
 */
export function person(name: string, note?: Child): HTMLElement {
  return h(
    "div",
    { class: "person" },
    h("span", { class: "avatar", "aria-hidden": "true" }, initials(name)),
    h(
      "div",
      { class: "person-text" },
      h("span", { class: "person-name" }, name),
      note ? h("span", { class: "person-note" }, note) : null,
    ),
  );
}

export function card(title: string, body: HTMLElement, action?: HTMLElement | null): HTMLElement {
  return h(
    "section",
    { class: "card" },
    h("div", { class: "card-head" }, h("h3", {}, title), action ?? null),
    body,
  );
}

/** Every context a page can report "nothing here" for. */
export type EmptyContext = keyof ReturnType<typeof state>["empty"];

/** Every wait a page can name. */
export type LoadingContext = keyof ReturnType<typeof state>["loadingContext"];

/**
 * The wait, named where the page knows which wait it is.
 *
 * An unnamed spinner is still correct — the generic line covers it — so a
 * component deep in a page that has no idea what it is waiting for can call
 * this with nothing.
 */
export function spinner(context?: LoadingContext): HTMLElement {
  const text = context === undefined ? state().loading : state().loadingContext[context];
  return h("div", { class: "state state-loading", role: "status", "aria-live": "polite" }, text);
}

/**
 * "Nothing here" for one context.
 *
 * A context rather than a sentence: the words are a brand decision and the page
 * only knows *which* emptiness it is reporting. An unnamed context falls back to
 * the generic line rather than rendering blank.
 */
export function emptyState(context: EmptyContext = "default"): HTMLElement {
  return h("div", { class: "state state-empty" }, state().empty[context]);
}

export function errorState(message: string, retry?: () => void): HTMLElement {
  return h(
    "div",
    { class: "state state-error", role: "alert" },
    h("p", {}, message),
    retry ? h("button", { class: "button", onclick: retry }, state().retry) : null,
  );
}

/**
 * The denial state carries the fix, not just the refusal: a "not authenticated"
 * is one click from resolved, and the other two tell the reader who can grant
 * what they're missing.
 */
export function deniedState(reason: DenyReason): HTMLElement {
  const body = h("p", {}, denialMessage(reason));
  if (reason === "NOT_AUTHENTICATED") {
    return h(
      "div",
      { class: "state state-denied" },
      body,
      h("a", { class: "button button-primary", href: "/login" }, state().signIn),
    );
  }
  return h("div", { class: "state state-denied", role: "alert" }, body, h("p", { class: "muted" }, err().denyHint));
}

/**
 * How a column is set, when it is not prose.
 *
 * - `num` — right-aligned and mono, so a column of figures is compared by where
 *   the numbers end rather than by reading each one.
 * - `when` — the same, quieter: a trailing timestamp dates the row without
 *   competing with the figures it sits beside.
 *
 * Declared on the header rather than per cell so a column cannot end up with
 * its label over one edge and its values against the other.
 */
export type ColumnAlign = "num" | "when";

export interface Column {
  readonly label: string;
  readonly align?: ColumnAlign;
}

/** A simple data table. Cells are strings or nodes; nothing is interpreted as HTML. */
export function table(
  headers: readonly (string | Column)[],
  rows: readonly (readonly (string | HTMLElement)[])[],
): HTMLElement {
  const cols: readonly Column[] = headers.map((c) => (typeof c === "string" ? { label: c } : c));
  const cellAttrs = (index: number): Record<string, string> => {
    const align = cols[index]?.align;
    return align === undefined ? {} : { class: align };
  };
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "table" },
      h(
        "thead",
        {},
        h("tr", {}, ...cols.map((col, i) => h("th", { scope: "col", ...cellAttrs(i) }, col.label))),
      ),
      h("tbody", {}, ...rows.map((row) => h("tr", {}, ...row.map((cell, i) => h("td", cellAttrs(i), cell))))),
    ),
  );
}
