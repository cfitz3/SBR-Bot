/**
 * Shared page furniture: stat tiles, badges, empty/denied/error states.
 *
 * Kept together so every page reports "nothing here", "not allowed", and
 * "something broke" in the same voice — three states that are easy to render
 * inconsistently when each page invents its own.
 */
import type { DenyReason } from "@sbr/panel-core";
import { denialMessage } from "./api.js";
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

export function spinner(label = "Loading…"): HTMLElement {
  return h("div", { class: "state state-loading", role: "status", "aria-live": "polite" }, label);
}

export function emptyState(message: string): HTMLElement {
  return h("div", { class: "state state-empty" }, message);
}

export function errorState(message: string, retry?: () => void): HTMLElement {
  return h(
    "div",
    { class: "state state-error", role: "alert" },
    h("p", {}, message),
    retry ? h("button", { class: "button", onclick: retry }, "Try again") : null,
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
      h("a", { class: "button button-primary", href: "/login" }, "Sign in with Discord"),
    );
  }
  return h("div", { class: "state state-denied", role: "alert" }, body, h("p", { class: "muted" }, "Ask a guild admin if you think this is wrong."));
}

/** A simple data table. Cells are strings or nodes; nothing is interpreted as HTML. */
export function table(headers: readonly string[], rows: readonly (readonly (string | HTMLElement)[])[]): HTMLElement {
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "table" },
      h("thead", {}, h("tr", {}, ...headers.map((label) => h("th", { scope: "col" }, label)))),
      h("tbody", {}, ...rows.map((row) => h("tr", {}, ...row.map((cell) => h("td", {}, cell))))),
    ),
  );
}
