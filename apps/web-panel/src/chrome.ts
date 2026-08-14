/**
 * The brand layer's two escapes from TypeScript into the browser: the token
 * stylesheet and the HTML shell.
 *
 * Both are rendered here rather than in `server.ts` because both are pure string
 * work over `theme.panel`, and pure string work that produces a stylesheet and a
 * document is exactly the kind of thing worth testing directly. The route
 * handlers stay three lines each.
 *
 * Why serve rather than bundle: the panel has no bundler, and an inline
 * `<style>` block would need `'unsafe-inline'` in the CSP — the one thing the
 * whole panel is built to avoid. A same-origin `/theme.css` is already allowed
 * by `default-src 'self'`, so the tokens arrive with no policy change at all.
 */
import type { Copy, DeepReadonly, Theme } from "@sbr/brand";

type PanelTheme = Theme["panel"];
type PanelCopy = DeepReadonly<Copy>["panel"];

/**
 * Characters that would let a token value stop being a value.
 *
 * `brand/theme.ts` is operator-authored code in this repo, so this is not a
 * defence against an attacker — it is a defence against a typo silently
 * producing a stylesheet that parses as something else. A rejected token is
 * omitted, which means `app.css`'s `:root` block supplies it instead; that block
 * exists as the documented fallback, so the panel stays painted either way.
 */
const UNSAFE = /[;{}<>]|\/\*|\*\//;

/** `accent2` → `accent-2`, `neutral100` → `neutral-100`, `bg` → `bg`. */
function kebab(key: string): string {
  return key
    .replace(/([a-z])(\d)/g, "$1-$2")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

export interface ThemeCss {
  readonly css: string;
  /** Token names dropped for holding a value that isn't a CSS value. */
  readonly rejected: readonly string[];
}

/**
 * The token block, in the same custom-property names `app.css` declares.
 *
 * Only the tokens the theme owns are emitted. `app.css`'s derived tokens
 * (`--tone-neutral`, `--muted`, `--rule`) are written in terms of these, so they
 * follow an override without appearing here — a theme that changes the accent
 * moves the rule gradient for free.
 */
export function renderThemeCss(panel: PanelTheme): ThemeCss {
  const groups: readonly (readonly [string, Readonly<Record<string, string>>, (k: string) => string])[] = [
    ["color", panel.colors, kebab],
    ["tone", panel.tone, kebab],
    // The scale's keys are `s1`…`s8`; the property is `--space-1`, so the `s`
    // that only exists because an identifier can't start with a digit is dropped.
    ["space", panel.space, (k) => k.slice(1)],
    ["radius", panel.radius, kebab],
    ["shadow", panel.shadow, kebab],
    ["font", panel.font, kebab],
  ];

  const lines: string[] = [];
  const rejected: string[] = [];

  for (const [prefix, table, name] of groups) {
    for (const [key, value] of Object.entries(table)) {
      const token = `--${prefix}-${name(key)}`;
      if (UNSAFE.test(value)) {
        rejected.push(token);
        continue;
      }
      lines.push(`  ${token}: ${value};`);
    }
  }

  const header = [
    "/*",
    " * Generated from brand/theme.ts by the panel — do not edit.",
    " *",
    " * Linked after app.css, so these win by cascade without any rule in app.css",
    " * being rewritten. app.css keeps its own :root block as the fallback for a",
    " * panel served without the brand layer.",
    " */",
  ];
  if (rejected.length > 0) {
    header.push(`/* Dropped, not a CSS value: ${rejected.join(", ")} — app.css supplies these. */`);
  }

  return { css: `${header.join("\n")}\n\n:root {\n${lines.join("\n")}\n}\n`, rejected };
}

/** Text destined for an HTML text node or a double-quoted attribute. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The mark is one glyph in a rounded square, so a wordmark longer than that is
 * taken at its first character rather than overflowing the box.
 */
function markGlyph(wordmark: string): string {
  return [...wordmark.trim()][0] ?? "";
}

/**
 * Fill `index.html`'s `{{…}}` slots from the brand layer.
 *
 * `index.html` is a template rather than a served file for one reason: every
 * word and colour in it is on screen *before* any JavaScript runs, so setting
 * them from `main.ts` would mean a visible flash of the wrong name on every
 * load — and the `noscript` line has to read correctly in a browser where
 * `main.ts` never runs at all.
 *
 * The name comes from copy and the tint from the theme, because one is words and
 * the other is looks. An unfilled slot is left as-is rather than blanked — a
 * missing key should look like a bug in the template, not like an empty panel.
 */
export function renderShellHtml(template: string, panel: PanelCopy, theme: PanelTheme): string {
  const values: Readonly<Record<string, string>> = {
    title: panel.shell.title,
    name: panel.shell.name,
    wordmark: panel.shell.wordmark,
    tagline: panel.shell.tagline,
    mark: markGlyph(panel.shell.wordmark),
    themeColor: theme.chrome.themeColor,
    signOut: panel.shell.signOut,
    loading: panel.state.loading,
    noscript: panel.shell.noscript,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
    const value = values[key];
    return value === undefined ? whole : escapeHtml(value);
  });
}
