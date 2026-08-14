import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { copy, theme } from "@sbr/brand";
import { renderShellHtml, renderThemeCss } from "./chrome.js";
import { ASSET_ROOT } from "./static.js";

/**
 * The token names are a contract with `app.css`, not an internal detail: the
 * stylesheet's rules are all written against these, so a renamed property here
 * unstyles the panel silently. Spot-checking one of each shape covers the
 * transform, and the exhaustive agreement check below covers the rest.
 */
test("tokens are emitted under the property names app.css declares", () => {
  const { css } = renderThemeCss(theme.panel);
  for (const token of [
    "--color-bg",
    "--color-accent-2",
    "--color-neutral-100",
    "--color-accent-900",
    "--tone-warn",
    "--space-1",
    "--space-8",
    "--radius-md",
    "--shadow-lg",
    "--font-sans",
  ]) {
    assert.ok(css.includes(`${token}:`), `${token} missing from /theme.css`);
  }
});

/**
 * The whole point of Phase E is that `app.css`'s `:root` is a *fallback* for the
 * generated sheet. A token the theme emits that `app.css` never declares means
 * the fallback has a hole; the reverse is fine, since `app.css` also derives
 * tokens (`--muted`, `--rule`) from the ones the theme owns.
 */
test("every generated token is one app.css declares as a fallback", async () => {
  const { css } = renderThemeCss(theme.panel);
  const appCss = await readFile(new URL("app.css", ASSET_ROOT), "utf8");

  const generated = [...css.matchAll(/^ {2}(--[a-z0-9-]+):/gm)].map((m) => m[1]);
  assert.ok(generated.length > 30, "the token block looks truncated");

  for (const token of generated) {
    assert.ok(appCss.includes(`${token}:`), `${token} has no fallback in app.css`);
  }
});

/**
 * `brand/theme.ts` is code in this repo rather than untrusted input, so this is
 * a typo guard, not a security boundary — but a value that closes the rule set
 * would take the rest of the sheet with it, and dropping one token loses only
 * that token because `app.css` still declares it.
 */
test("a value that isn't a CSS value is dropped rather than emitted", () => {
  const broken = { ...theme.panel, colors: { ...theme.panel.colors, bg: "red; } body { display: none" } };
  const { css, rejected } = renderThemeCss(broken);

  assert.deepEqual(rejected, ["--color-bg"]);
  assert.ok(!css.includes("display: none"));
  assert.ok(css.includes("--color-surface:"), "the other tokens still render");
  // Named in the sheet itself, so the cause is visible where the effect is.
  assert.ok(css.includes("--color-bg"), "the dropped token is reported, not hidden");
});

test("the shell's slots are filled from copy and theme", async () => {
  const template = await readFile(new URL("index.html", ASSET_ROOT), "utf8");
  const html = renderShellHtml(template, copy.panel, theme.panel);

  assert.ok(!html.includes("{{"), "an unfilled slot was left in the shell");
  assert.ok(html.includes(`<title>${copy.panel.shell.title}</title>`));
  assert.ok(html.includes(copy.panel.shell.name));
  assert.ok(html.includes(copy.panel.shell.noscript));
  assert.ok(html.includes(`content="${theme.panel.chrome.themeColor}"`));
  // The mark is one glyph, not the whole wordmark.
  assert.ok(html.includes(`aria-hidden="true">${[...copy.panel.shell.wordmark][0]}<`));
});

/**
 * The shell is the one place copy reaches HTML, so it is the one place copy
 * could carry markup. It must arrive as text.
 */
test("copy is escaped into the shell, never interpolated as markup", () => {
  const panel = {
    ...copy.panel,
    shell: { ...copy.panel.shell, name: '<img src=x onerror="alert(1)">' },
  };
  const html = renderShellHtml("<a>{{name}}</a>", panel, theme.panel);
  assert.equal(html, "<a>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</a>");
});

/** A key nothing supplies is a template bug; blanking it would hide the bug. */
test("an unknown slot is left visible rather than blanked", () => {
  assert.equal(renderShellHtml("<p>{{nosuchkey}}</p>", copy.panel, theme.panel), "<p>{{nosuchkey}}</p>");
});
