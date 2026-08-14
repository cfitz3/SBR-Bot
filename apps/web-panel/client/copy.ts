/**
 * The browser half's reader for the brand layer.
 *
 * The panel has no bundler: `client/*.ts` is compiled straight to `public/app/`
 * and the browser loads exactly those modules, so a bare `import { copy } from
 * "@sbr/brand"` would emit a specifier nothing can resolve at runtime. The
 * resolved copy therefore arrives the way every other piece of server state
 * does — over HTTP, once, before the first render — and this module is where it
 * lands. Types still come from `@sbr/brand` directly, because `import type` is
 * erased and costs the browser nothing.
 *
 * `scope()` mirrors `makeScope` in `@sbr/brand-defaults` rather than importing
 * it, for the same resolution reason. The two are small and their agreement is
 * covered by `copy.test.ts`.
 */
import type { Copy, DeepReadonly } from "@sbr/brand";

type Panel = DeepReadonly<Copy>["panel"];
type Errors = DeepReadonly<Copy>["error"];

/** The resolved panel copy tree. Exported so pages can name parts of it. */
export type PanelCopy = Panel;

let panel: Panel | null = null;
let errors: Errors | null = null;

/** Called once by `main.ts` with the payload from `/api/copy`, before rendering. */
export function installCopy(next: { readonly panel: Panel; readonly error: Errors }): void {
  panel = next.panel;
  errors = next.error;
}

/** True once `installCopy` has run. `main.ts` uses this to decide what to render. */
export function copyReady(): boolean {
  return panel !== null;
}

function requirePanel(): Panel {
  // Reaching a reader before the bootstrap fetch is a programming error, not a
  // user-facing state: `main.ts` awaits the copy before it renders anything.
  // Throwing here names the bug at the call site instead of painting the panel
  // with the word "undefined".
  if (panel === null) throw new Error("panel copy read before installCopy()");
  return panel;
}

/**
 * Read one section of the panel copy:
 *
 * ```ts
 * const t = scope("members");
 * t("title"); // "Members"
 * ```
 *
 * The lookup is lazy, so a page module may take its reader at module scope even
 * though the copy itself does not exist until the bootstrap fetch resolves.
 */
export function scope<S extends keyof Panel>(section: S): <K extends keyof Panel[S]>(key: K) => Panel[S][K] {
  return (key) => requirePanel()[section][key];
}

/** The shared state words — used by `components.ts` and the router. */
export const state = (): Panel["state"] => requirePanel().state;

/** The chrome around every page: switcher, landmarks, browser tab. */
export const shell = (): Panel["shell"] => requirePanel().shell;

/** Nav labels and group headings. */
export const nav = (): Panel["nav"] => requirePanel().nav;

/** Failure messages, keyed by reason code. Shared with the bots. */
export function err(): Errors {
  if (errors === null) throw new Error("error copy read before installCopy()");
  return errors;
}
