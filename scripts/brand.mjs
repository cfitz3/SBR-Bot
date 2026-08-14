/**
 * `npm run brand` — is the brand layer actually holding?
 *
 *   check      the things a bad edit breaks: over-length command descriptions,
 *              a theme token that isn't a CSS value or has no fallback, a card
 *              that violates the house style, a copy key nobody reads, and a
 *              read that resolves to no key
 *   diff       exactly what brand/*.ts overrides, beside the default
 *   coverage   how much of each surface is behind a key
 *
 * Offline, like `doctor` and `embeds`: it reads build output and source text,
 * and touches no datastore.
 *
 * One honesty note that the output repeats, because it matters: the dead-key and
 * unresolved-read checks are a *text scan*, not a type-checker. They understand
 * `const t = scope("members")` followed by `t("title")`, which is how every
 * module in this repo reads copy — but a key assembled at runtime is invisible
 * to them. They are a broom, not a proof, and `coverage` prints a number rather
 * than claiming completeness for exactly that reason.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { ROOT, c, die, say } from "./lib.mjs";

/** Discord rejects a longer command or option description outright. */
const DESCRIPTION_MAX = 100;

const heading = (t) => say(`\n${c.bold(t)}`);
const bullet = (t) => say(`  ${c.gray("·")} ${t}`);
const problems = [];
const problem = (t) => (problems.push(t), say(`  ${c.red("✗")} ${t}`));
const caution = (t) => say(`  ${c.yellow("!")} ${t}`);
const good = (t) => say(`  ${c.green("✓")} ${t}`);

async function load(entry, hint) {
  try {
    return await import(pathToFileURL(join(ROOT, entry)).href);
  } catch {
    die(`${hint} is not built.`, ["npm run build"]);
  }
}

// ── the copy tree as flat paths ─────────────────────────────────────────────

/** Every leaf path in a nested plain object, as `a.b.c`. */
function leaves(node, prefix = "") {
  const out = [];
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) out.push(...leaves(value, path));
    else out.push(path);
  }
  return out;
}

// ── the source scan ─────────────────────────────────────────────────────────

const SCAN_ROOTS = [
  ["packages", (name) => name !== "brand-defaults"],
  ["apps", () => true],
  ["brand", () => true],
];

function* sourceFiles() {
  for (const [top, keep] of SCAN_ROOTS) {
    const base = join(ROOT, top);
    let entries;
    try {
      entries = readdirSync(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!keep(entry)) continue;
      const path = join(base, entry);
      if (!statSync(path).isDirectory() && !path.endsWith(".ts")) continue;
      yield* walk(path);
    }
  }
}

function* walk(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return;
  }
  if (!stat.isDirectory()) {
    if (path.endsWith(".ts") && !path.endsWith(".d.ts")) yield path;
    return;
  }
  const name = basename(path);
  if (name === "node_modules" || name === "dist" || name === "public") return;
  for (const child of readdirSync(path)) yield* walk(join(path, child));
}

/**
 * Which copy paths the source reads.
 *
 * `scope()` in the panel's browser half is already rooted at `panel`, because
 * that is the only half of the tree the browser is sent — so a read of
 * `scope("members")` in `client/` means `panel.members`.
 */
function readPaths(known = () => true) {
  const found = new Map(); // path → first file that reads it

  /**
   * A property access reads a key and then keeps going: `E.command.cooldown`
   * is followed by `.replace(…)`, and `slot.hint` by `.length`. Trimming to the
   * longest prefix the copy tree actually has is exact and needs no list of
   * JavaScript's own property names to exclude — a list that would be wrong
   * again the first time someone called `.at()` on a string.
   *
   * Only the property-access scanners trim. A `t("typo")` is left whole so it
   * is still reported, which is the check's whole point.
   */
  const trim = (path) => {
    for (let p = path; p.includes("."); p = p.slice(0, p.lastIndexOf("."))) {
      if (known(p)) return p;
    }
    return path;
  };

  for (const file of sourceFiles()) {
    const text = readFileSync(file, "utf8");
    const where = relative(ROOT, file).replace(/\\/g, "/");
    const clientSide = where.startsWith("apps/web-panel/client/");

    // `const t = scope("members")` → t reads under panel.members
    const scopes = new Map();
    for (const m of text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*scope\(\s*"([\w.]+)"\s*\)/g)) {
      scopes.set(m[1], clientSide ? `panel.${m[2]}` : m[2]);
    }

    const mark = (path) => {
      if (!found.has(path)) found.set(path, where);
    };

    for (const [name, namespace] of scopes) {
      for (const m of text.matchAll(new RegExp(String.raw`\b${name}\(\s*"([\w.]+)"`, "g"))) {
        mark(`${namespace}.${m[1]}`);
      }
      // A reader called with anything but a literal — `t(kind)`, `t(n === 1 ?
      // one : many)` — is a key the scan cannot resolve. The namespace is marked
      // whole rather than guessed at: over-reporting a key as read costs a stale
      // string nobody notices, under-reporting sends someone deleting a key that
      // is on screen right now.
      if (new RegExp(String.raw`\b${name}\(\s*[^")\s]`).test(text)) mark(namespace);
    }

    // The accessor readers. `state().loading` names one key; a bare `state()`
    // handed to something else hands over the whole section.
    //
    // The local name is taken from the import rather than assumed, because
    // `main.ts` imports `nav as navCopy` to keep the word `nav` free for the
    // sidebar's own helpers — and a scan that hardcoded `nav` would report
    // every sidebar label as dead while the sidebar was printing them.
    const ACCESSORS = { state: "panel.state", shell: "panel.shell", nav: "panel.nav", err: "error" };
    const imported = /import\s*\{([^}]*)\}\s*from\s*"\.\/copy\.js"/.exec(text)?.[1] ?? "";
    for (const clause of imported.split(",")) {
      const [exported, local = exported] = clause.trim().split(/\s+as\s+/).map((s) => s.trim());
      const namespace = ACCESSORS[exported];
      if (!namespace || !local) continue;
      for (const m of text.matchAll(new RegExp(String.raw`\b${local}\(\)\.(\w+)`, "g"))) {
        mark(`${namespace}.${m[1]}`);
      }
      if (new RegExp(String.raw`\b${local}\(\)(?!\s*\.)`).test(text)) mark(namespace);
    }

    // Server-side reads go through the resolved object directly, the way
    // `chrome.ts` reads `copy.panel.shell.name` on its way into the HTML shell.
    //
    // A *section* is required: a bare `copy.panel` is the whole tree being
    // handed to `installCopy` or a renderer, and counting that as a read would
    // mark all 600 panel keys live and leave the check reporting nothing.
    for (const m of text.matchAll(/\bcopy\.((?:panel|error|embed)\.\w+(?:\.\w+)*)/g)) mark(trim(m[1]));

    // …and often through a one-letter alias, because `E.command.cooldown` reads
    // better in a dispatcher than the full path repeated six times. The alias is
    // resolved from its own declaration rather than assumed, for the same reason
    // the accessor imports above are.
    const ALIAS = /\b(?:const|let)\s+(\w+)\s*=\s*copy\.((?:panel|error|embed)(?:\.\w+)*)(\[)?/g;
    for (const [, local, path, indexed] of text.matchAll(ALIAS)) {
      // `copy.panel.channelSlot[slot]` binds one row chosen at runtime, so what
      // follows the alias names a column and not a copy key. The table is marked
      // read whole; guessing which row would invent keys that don't exist.
      if (indexed) {
        mark(path);
        continue;
      }
      for (const m of text.matchAll(new RegExp(String.raw`\b${local}\.(\w+(?:\.\w+)*)`, "g"))) {
        mark(trim(`${path}.${m[1]}`));
      }
    }
  }
  return found;
}

/** A defined leaf is read if it, or any ancestor of it, was read. */
function isRead(leaf, reads) {
  if (reads.has(leaf)) return true;
  for (let cut = leaf.lastIndexOf("."); cut > 0; cut = leaf.lastIndexOf(".", cut - 1)) {
    if (reads.has(leaf.slice(0, cut))) return true;
  }
  return false;
}

/** A read resolves if it names a leaf, or a subtree containing one. */
function resolves(read, leafSet, prefixSet) {
  return leafSet.has(read) || prefixSet.has(read);
}

// ── check ───────────────────────────────────────────────────────────────────

async function check() {
  const brand = await load("brand/dist/index.js", "brand");
  const { copy, theme } = brand;

  // 1. Command descriptions, against Discord's own cap.
  heading("Command descriptions");
  let over = 0;
  for (const [name, spec] of Object.entries(copy.command)) {
    const check = (label, text) => {
      if (typeof text === "string" && text.length > DESCRIPTION_MAX) {
        over += 1;
        problem(`${label} is ${text.length} characters; Discord's cap is ${DESCRIPTION_MAX}`);
      }
    };
    check(`/${name}`, spec.description);
    for (const [opt, text] of Object.entries(spec.option ?? {})) check(`/${name} ${opt}`, text);
  }
  if (over === 0) good(`${Object.keys(copy.command).length} commands, all within ${DESCRIPTION_MAX} characters`);

  // 2. Theme tokens: a CSS value, and one app.css can fall back to.
  heading("Panel theme tokens");
  const chrome = await load("apps/web-panel/dist/chrome.js", "the web panel");
  const { css, rejected } = chrome.renderThemeCss(theme.panel);
  for (const token of rejected) problem(`${token} is not a CSS value, so app.css supplies it instead`);

  const appCss = readFileSync(join(ROOT, "apps/web-panel/public/app.css"), "utf8");
  const tokens = [...css.matchAll(/^ {2}(--[a-z0-9-]+):/gm)].map((m) => m[1]);
  const orphans = tokens.filter((t) => !appCss.includes(`${t}:`));
  for (const token of orphans) problem(`${token} has no fallback in app.css`);
  if (rejected.length === 0 && orphans.length === 0) good(`${tokens.length} tokens, every one with a fallback`);

  // 3. The house style, over every card the platform can send.
  heading("Embed gallery");
  const kit = await load("packages/discord-kit/dist/index.js", "discord-kit");
  const { GALLERY } = await load("packages/embed-gallery/dist/index.js", "embed-gallery");
  const issues = kit.checkEmbeds(GALLERY);
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity !== "error");
  for (const issue of errors) problem(`${issue.name}: ${issue.message} [${issue.rule}]`);
  for (const issue of warnings) caution(`${issue.name}: ${issue.message} [${issue.rule}]`);
  if (errors.length === 0) good(`${GALLERY.length} cards, no error-severity issues`);

  // 4. Keys nobody reads, and reads that name no key.
  const { defined, reads, dead, unresolved } = surveyCopy(copy);

  heading("Copy keys");
  say(c.gray("  A text scan, not a type-check: a key assembled at runtime looks dead here."));
  say(c.gray("  command.* is checked against the real registries by commands.test.ts instead."));
  for (const path of unresolved) problem(`${path} is read but no such key exists (${reads.get(path)})`);
  if (dead.length > 0) caution(`${dead.length} of ${defined.length} keys are read nowhere`);
  if (dead.length > 0 && process.argv.includes("--verbose")) for (const path of dead) bullet(c.gray(path));
  if (dead.length === 0 && unresolved.length === 0) good(`${defined.length} keys, all defined and all read`);

  report();
}

/**
 * `command.*` is exempt from the text scan, and not because it is hard.
 *
 * Command copy is not read key by key: `withCommandCopy()` lays the whole table
 * over both registries at build time, so a text scan sees zero reads and would
 * report every description in the platform as dead. The real question — does
 * this key name a command that exists, and does every command have a key — is
 * answered exactly, against the built registries, by
 * `packages/embed-gallery/src/commands.test.ts`. A worse version of a check that
 * already exists is worth less than nothing, so this one defers.
 */
const OVERLAID = "command.";

function surveyCopy(copy) {
  const defined = leaves(copy).filter((leaf) => !leaf.startsWith(OVERLAID));
  const leafSet = new Set(defined);
  const prefixSet = new Set();
  for (const leaf of defined) {
    for (let cut = leaf.lastIndexOf("."); cut > 0; cut = leaf.lastIndexOf(".", cut - 1)) {
      prefixSet.add(leaf.slice(0, cut));
    }
  }

  const reads = readPaths((path) => resolves(path, leafSet, prefixSet));
  const unresolved = [...reads.keys()].filter((path) => !resolves(path, leafSet, prefixSet)).sort();
  const dead = defined.filter((leaf) => !isRead(leaf, reads)).sort();
  return { defined, reads, dead, unresolved, leafSet };
}

// ── diff ────────────────────────────────────────────────────────────────────

async function diff() {
  const defaults = await load("packages/brand-defaults/dist/index.js", "brand-defaults");
  const overrides = {
    copy: (await load("brand/dist/copy.js", "brand")).copyOverride,
    theme: (await load("brand/dist/theme.js", "brand")).themeOverride,
  };

  let total = 0;
  for (const [name, base] of [
    ["copy", defaults.DEFAULT_COPY],
    ["theme", defaults.DEFAULT_THEME],
  ]) {
    const paths = leaves(overrides[name]);
    heading(`brand/${name}.ts — ${paths.length} override${paths.length === 1 ? "" : "s"}`);
    total += paths.length;
    if (paths.length === 0) {
      say(c.gray("  Nothing overridden; the defaults are what ships."));
      continue;
    }
    for (const path of paths) {
      const was = path.split(".").reduce((node, key) => node?.[key], base);
      const now = path.split(".").reduce((node, key) => node?.[key], overrides[name]);
      say(`  ${c.bold(path)}`);
      say(`    ${c.gray("default")}  ${format(was)}`);
      say(`    ${c.green("yours")}    ${format(now)}`);
    }
  }

  if (total === 0) {
    say(`\n${c.gray("An empty override is a valid one — the type says every key is optional.")}`);
  }
}

const format = (value) =>
  value === undefined ? c.red("(no such key)") : typeof value === "number" ? `0x${value.toString(16)}` : JSON.stringify(value);

// ── coverage ────────────────────────────────────────────────────────────────

/**
 * Two different numbers, kept apart on purpose.
 *
 * *Keys read* says how much of what the brand layer defines is actually wired
 * up. *Literals left* says how much of the product still says something the
 * brand layer cannot change — which is the number the exhaustiveness decision
 * was actually about, and the only one that can prove a surface is done.
 */
async function coverage() {
  const { copy } = await load("brand/dist/index.js", "brand");
  const { defined, reads, dead } = surveyCopy(copy);

  heading("Keys defined and read");
  const sections = new Map();
  for (const leaf of defined) {
    const top = leaf.startsWith("panel.") ? leaf.split(".").slice(0, 2).join(".") : leaf.split(".")[0];
    const row = sections.get(top) ?? { total: 0, read: 0 };
    row.total += 1;
    if (isRead(leaf, reads)) row.read += 1;
    sections.set(top, row);
  }
  for (const [name, { total, read }] of [...sections].sort()) {
    const pct = Math.round((read / total) * 100);
    const mark = pct === 100 ? c.green("✓") : pct >= 80 ? c.yellow("!") : c.red("✗");
    say(`  ${mark} ${name.padEnd(28)} ${c.gray(`${read}/${total} (${pct}%)`)}`);
  }
  say(`  ${c.gray("─".repeat(46))}`);
  say(`  ${" ".repeat(2)}${"total".padEnd(28)} ${c.gray(`${defined.length - dead.length}/${defined.length}`)}`);

  heading("Literals left in the surfaces copy covers");
  say(c.gray("  Multi-word string literals a text scan can still see. Class names,"));
  say(c.gray("  SVG path data and test names are excluded; anything else is a string"));
  say(c.gray("  the operator cannot change."));
  for (const [label, dir] of [
    ["panel client", "apps/web-panel/client"],
    ["bridge commands", "packages/commands-bridge/src"],
    ["admin commands", "packages/commands-admin/src"],
  ]) {
    say(`  ${label.padEnd(28)} ${c.gray(String(countLiterals(join(ROOT, dir))))}`);
  }
}

/** Multi-word double-quoted literals, minus the ones that are never prose. */
function countLiterals(dir) {
  let n = 0;
  for (const file of walk(dir)) {
    if (file.endsWith(".test.ts")) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("import")) continue;
      if (/\bclass:|"d":|\bd="/.test(line)) continue;
      for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
        const value = m[1];
        if (!value.includes(" ")) continue;
        if (value.startsWith("/") || value.startsWith("$") || value.startsWith("--")) continue;
        n += 1;
      }
    }
  }
  return n;
}

// ── entry ───────────────────────────────────────────────────────────────────

function report() {
  if (problems.length === 0) {
    say(`\n${c.green("Brand layer is clean.")}`);
    return;
  }
  say(`\n${c.red(`${problems.length} problem${problems.length === 1 ? "" : "s"}.`)}`);
  process.exitCode = 1;
}

const MODES = { check, diff, coverage };

const mode = process.argv[2] ?? "check";
const run = MODES[mode];
if (!run) die(`Unknown mode "${mode}".`, [`Try one of: ${Object.keys(MODES).join(", ")}`]);
await run();
