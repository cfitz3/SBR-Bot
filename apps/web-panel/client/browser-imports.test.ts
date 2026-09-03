/**
 * The guard that would have caught the blank panel.
 *
 * The client half has no bundler: the browser loads exactly the modules tsc
 * emitted into `public/app/`. So a runtime import of a workspace package — or of
 * anything else that only a bundler or Node could resolve — is emitted verbatim
 * as a bare specifier, and the browser fails the whole module graph rather than
 * that one import. `main.ts` imports every page statically, so the blast radius
 * is the entire panel: the shell never gets past its `Loading…` placeholder, and
 * the sign-in button never renders, because no module in the graph ever ran.
 *
 * `enums.ts`, `role-menu-limits.ts`, `trigger-limits.ts` and `link-help-limits.ts`
 * are the answer for the values a page genuinely needs — a browser-safe copy with
 * a test pinning it to the platform's own constant. This test is the backstop
 * that makes reaching for the shortcut fail here rather than in production.
 *
 * It reads the *emitted* JavaScript rather than the TypeScript, because that is
 * the artefact the browser loads: `import type` erases and is fine, a value
 * import of the same module is not, and only the emit knows which happened.
 *
 * `*.test.js` files are exempt: they run under Node, where bare specifiers
 * resolve, and `resolveAsset` refuses to serve them.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** This file is emitted into `public/app/`, beside the modules it checks. */
const APP_ROOT = fileURLToPath(new URL(".", import.meta.url));

async function appModules(dir: string = APP_ROOT): Promise<readonly string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await appModules(path)));
    else if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) found.push(path);
  }
  return found;
}

/** Every `from "…"` in the emitted module, static or dynamic. */
function specifiers(source: string): readonly string[] {
  return [...source.matchAll(/(?:^|[\s;{(])(?:import|export)[^"'\n]*from\s*["']([^"']+)["']/gm)].map(
    (m) => m[1]!,
  );
}

test("no emitted client module imports something the browser cannot resolve", async () => {
  const offenders: string[] = [];
  for (const file of await appModules()) {
    const source = await readFile(file, "utf8");
    for (const specifier of specifiers(source)) {
      // Relative and absolute paths are the only two a browser resolves without
      // an import map, and the panel ships no import map.
      if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) continue;
      offenders.push(`${file.slice(APP_ROOT.length)} imports "${specifier}"`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these would fail the whole module graph and blank the panel:\n${offenders.join("\n")}`,
  );
});
