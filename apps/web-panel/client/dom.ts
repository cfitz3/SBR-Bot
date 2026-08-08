/**
 * A ~40-line element builder, in place of a UI framework.
 *
 * The panel renders a handful of read-only pages from JSON it already has; a
 * component runtime would be more machinery than the job needs, and the repo
 * keeps the panel dependency-free on purpose. Everything below sets text and
 * attributes through the DOM API — nothing here ever touches `innerHTML`, so
 * guild names, job errors, and Discord usernames cannot become markup.
 */

export type Child = Node | string | number | null | undefined | false;

type Attrs = Readonly<Record<string, string | number | boolean | null | undefined | EventListener>>;

function append(parent: HTMLElement, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  parent.append(child instanceof Node ? child : String(child));
}

export function h(tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value);
    } else if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children) append(el, child);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * `h` for SVG. A separate function because `createElement` puts the node in the
 * HTML namespace, where an `<svg>` subtree parses but never renders — a failure
 * that looks like a styling bug rather than a namespace one.
 */
export function s(tag: string, attrs: Attrs = {}, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value);
    } else {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

/** `h` for a list of children already in an array. */
export function frag(children: readonly Child[]): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    f.append(child instanceof Node ? child : String(child));
  }
  return f;
}

/**
 * Set style properties through the CSSOM.
 *
 * A `style="…"` attribute would need `'unsafe-inline'` in the server's
 * `style-src`, which the panel's CSP does not grant. Property assignment is not
 * covered by CSP at all, so a computed width or colour can still be applied
 * without loosening the policy for every stylesheet on the page.
 */
export function style(el: HTMLElement, props: Readonly<Record<string, string>>): HTMLElement {
  for (const [prop, value] of Object.entries(props)) el.style.setProperty(prop, value);
  return el;
}

export function replace(host: HTMLElement, content: Child): void {
  host.replaceChildren();
  append(host, content);
}
