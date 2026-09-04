#!/usr/bin/env node
/**
 * Generate the SBR-Guide mirror repository from this one.
 *
 * SBR-Guide ships as its own public repository because that is what gets read
 * during a Hypixel API review: a reviewer has to be able to see the entire
 * data-access surface of the bot in one place, and a bot that imported
 * `@sbr/progression` would show a package named for progression tracking
 * sitting next to a snapshot repository — precisely the impression that sank
 * the last application. So the mirror is genuinely standalone.
 *
 * **This repository is the source of truth; the mirror is generated.** Nothing
 * in the mirror is ever hand-edited. Every change originates here and arrives
 * there through this script, which is why `--check` exists and why CI runs it.
 *
 * Two kinds of file cross over, and the distinction is the whole design:
 *
 *   - **Emitted.** Pure domain modules — parsers, the ranking engine, the
 *     content loader, the logger. Zero I/O, no platform coupling, no idea a
 *     guild exists. These are copied byte-for-byte with their `@sbr/*` imports
 *     rewritten to relative paths, so the two repositories genuinely run the
 *     same code rather than two copies that have drifted.
 *
 *   - **Template.** Everything at the edge: the composition root, config, the
 *     Prisma layer, the vendored Hypixel client, the reduced type surface.
 *     These cannot be copied, because the platform versions of them describe
 *     rosters and moderation and stored progression. They are hand-authored
 *     *here*, under `guide-mirror/`, and copied over verbatim — so "never
 *     hand-edit the mirror" still holds: the hand-editing happens in this repo,
 *     under review, in the same commit as whatever prompted it.
 *
 * Usage:
 *   node scripts/sync-guide.mjs                 # write to ../SBR-Guide
 *   node scripts/sync-guide.mjs --out <dir>     # write elsewhere
 *   node scripts/sync-guide.mjs --check         # fail if the mirror has drifted
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_OUT = resolve(ROOT, "..", "SBR-Guide");

// ── the manifest ────────────────────────────────────────────────────────────

/**
 * Exactly which source directories cross into the mirror, and where they land.
 *
 * Written out rather than derived from the workspace list on purpose: a new
 * package appearing in this repository must not silently start being published.
 * Adding a line here is a decision somebody makes and a reviewer sees.
 */
const EMIT = [
  {
    from: "packages/shared-types/src",
    to: "src/types",
    // The platform contract layer also describes rosters, moderation cases and
    // stored progression readings. Only the generic result vocabulary travels;
    // `src/types/dtos.ts` in the mirror is a hand-written reduction of the rest.
    only: ["common.ts"],
  },
  { from: "packages/skyblock-parse/src", to: "src/parse" },
  { from: "packages/guide/src", to: "src/guide" },
  { from: "packages/guide-content/src", to: "src/content" },
  {
    from: "packages/observability/src",
    to: "src/log",
    // No shipper (posts records into a Discord channel) and no status card
    // (curates a member-facing platform status) — neither has a use here.
    only: [
      "logger.ts",
      "logger.test.ts",
      "meter.ts",
      "meter.test.ts",
      "health.ts",
      "lifecycle.ts",
      "lifecycle.test.ts",
    ],
  },
];

/** Hand-authored mirror files, copied verbatim from `guide-mirror/` to the root. */
const TEMPLATE = { from: "guide-mirror", to: "." };

/**
 * Path fragments that must never reach the mirror.
 *
 * A denylisted file appearing in the emit set is a hard error, not a warning.
 * The whole argument for the mirror is that a reviewer can trust its contents,
 * and a check that prints a warning and carries on is a check that will
 * eventually be scrolled past.
 */
const DENY = [
  "packages/xp",
  "packages/leaderboards",
  "packages/analytics",
  "packages/moderation",
  "packages/tickets",
  "packages/bridge",
  "packages/client-ingest",
  "packages/screening",
  "packages/skykings",
  "packages/playtime",
  "packages/community",
  "packages/perms",
  "packages/progression",
  "apps/admin-bot",
  "apps/web-panel",
  "apps/bridge-bot",
  "ctjs-module",
];

/**
 * Where each workspace package lands in the mirror, as a module path.
 *
 * A table rather than a regex, because a rewrite that guesses is a rewrite that
 * eventually guesses wrong — and it would do so silently, producing a mirror
 * that compiles against the wrong module.
 */
const IMPORT_MAP = {
  "@sbr/shared-types": "src/types/index.js",
  "@sbr/skyblock-parse": "src/parse/index.js",
  "@sbr/guide": "src/guide/index.js",
  "@sbr/guide-content": "src/content/index.js",
  "@sbr/hypixel": "src/hypixel/index.js",
  "@sbr/observability": "src/log/index.js",
};

/**
 * Strings that must not appear in emitted or template *code*.
 *
 * Markdown is exempt: COMPLIANCE.md has to be able to name what it rules out,
 * and a scan that forbade the words would forbid the document explaining them.
 * That is a recorded decision, not a loophole — moving something past this
 * check by writing it in a `.md` file would be a lie told to a reviewer.
 */
const FORBIDDEN = [
  "ProfileSnapshot",
  "ProfileCurrent",
  "MetricRollup",
  "XpEvent",
  "AnalyticsEvent",
  "snapshot",
  "rollup",
  "leaderboard",
];

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".cjs", ".js", ".prisma", ".sql"]);

/**
 * Top-level entries in the mirror that belong to the mirror, not to this
 * script: its git history, its installed dependencies, its build output, and
 * the operator's real `.env`. These survive a regeneration and are ignored by
 * the drift check.
 */
const PRESERVE = new Set([".git", "node_modules", "dist", ".env", ".env.local", "tsconfig.tsbuildinfo"]);

/** Comment syntax by extension, for the generated-file banner. */
const BANNER_STYLE = {
  ".ts": "block",
  ".tsx": "block",
  ".mjs": "block",
  ".cjs": "block",
  ".js": "block",
  ".prisma": "line",
  ".yml": "hash",
  ".yaml": "hash",
  ".example": "hash",
};

// ── helpers ─────────────────────────────────────────────────────────────────

const say = (msg = "") => process.stdout.write(`${msg}\n`);

function die(msg, hints = []) {
  process.stderr.write(`\nsync-guide: ${msg}\n`);
  for (const h of hints) process.stderr.write(`  → ${h}\n`);
  process.stderr.write("\n");
  process.exit(1);
}

const shaCache = new Map();

/**
 * The commit that last touched this particular source file.
 *
 * Not `HEAD`, which would be the obvious choice and is the wrong one: every
 * commit to this repository would change the banner on all fifty-odd generated
 * files, so `--check` would report total drift the moment anything at all was
 * committed, and the mirror could never be anything but one commit stale. A
 * per-file commit moves only when that file moves, which makes the banner both
 * stable and more informative — it dates the content, not the run.
 */
function sourceSha(sourceRel) {
  const cached = shaCache.get(sourceRel);
  if (cached !== undefined) return cached;

  let sha;
  try {
    sha = execFileSync("git", ["log", "-1", "--format=%h", "--", sourceRel], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    sha = "";
  }
  // No history, or a file that has never been committed. Say so rather than
  // print a commit the content does not actually correspond to.
  const answer = sha === "" ? "uncommitted" : sha;
  shaCache.set(sourceRel, answer);
  return answer;
}

function banner(sourcePath, sha, style) {
  const lines = [
    "GENERATED FILE — do not edit here.",
    "",
    `Source: ${sourcePath} @ ${sha}`,
    "Every change originates in the SBR-Bot repository and arrives through",
    "`node scripts/sync-guide.mjs`. An edit made here is lost on the next sync.",
  ];
  if (style === "block") return `/**\n${lines.map((l) => (l ? ` * ${l}` : " *")).join("\n")}\n */\n`;
  if (style === "line") return `${lines.map((l) => (l ? `// ${l}` : "//")).join("\n")}\n\n`;
  return `${lines.map((l) => (l ? `# ${l}` : "#")).join("\n")}\n\n`;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** POSIX-style repo-relative path, so output is identical on every platform. */
const rel = (from, to) => relative(from, to).split(sep).join(posix.sep);

/**
 * Rewrite `@sbr/*` imports to paths relative to where this file lands.
 *
 * Returns the rewritten text, or throws naming the specifier if a package
 * crosses over that the map has no entry for — an unmapped import would compile
 * in this repository and fail in the mirror, which is the failure mode the
 * table exists to make impossible.
 */
function rewriteImports(text, destRelPath, sourcePath) {
  const fromDir = posix.dirname(destRelPath);

  const rewritten = text.replace(/(\bfrom\s*|\bimport\s*\(\s*)(["'])(@sbr\/[^"']+)\2/g, (match, lead, quote, spec) => {
    const target = IMPORT_MAP[spec];
    if (!target) {
      die(`${sourcePath} imports ${spec}, which has no entry in IMPORT_MAP.`, [
        "Either the package does not belong in the mirror (check the manifest),",
        "or IMPORT_MAP needs a line saying where it lands.",
      ]);
    }
    let specifier = posix.relative(fromDir, target);
    if (!specifier.startsWith(".")) specifier = `./${specifier}`;
    return `${lead}${quote}${specifier}${quote}`;
  });

  // Package names also appear in prose — "the loader in `@sbr/guide-content`
  // calls this". Left alone they are dangling references in the mirror, naming
  // packages a reader there cannot find. Every quoted specifier has already
  // been consumed above, so what remains is prose, and the same table decides
  // where it points.
  return rewritten.replace(/@sbr\/[a-z-]+/g, (spec) => {
    const target = IMPORT_MAP[spec];
    return target ? posix.dirname(target) : spec;
  });
}

function assertNotDenied(sourcePath) {
  const normalized = sourcePath.split(sep).join(posix.sep);
  for (const fragment of DENY) {
    if (normalized.includes(fragment)) {
      die(`${sourcePath} matches the denylist entry "${fragment}".`, [
        "This file describes guild tracking, moderation, or another surface the",
        "mirror must not contain. Remove it from the manifest.",
      ]);
    }
  }
}

// ── generation ──────────────────────────────────────────────────────────────

/** Build the complete mirror into `out`, which is created fresh. */
function generate(out) {
  const written = [];

  // Clear out the previous generation so a file deleted from the manifest
  // actually disappears rather than lingering — but never touch the things the
  // mirror owns and this script did not put there. Wiping `.git` would destroy
  // the mirror's history; wiping `node_modules` would make every sync a
  // reinstall.
  mkdirSync(out, { recursive: true });
  for (const entry of readdirSync(out)) {
    if (PRESERVE.has(entry)) continue;
    rmSync(join(out, entry), { recursive: true, force: true });
  }

  const emit = (sourceAbs, sourceRel, destRel, { rewrite }) => {
    assertNotDenied(sourceRel);

    const ext = extname(sourceAbs);
    const destAbs = join(out, destRel);
    mkdirSync(dirname(destAbs), { recursive: true });

    // Everything here is text, and it is written with LF regardless of what the
    // source file happens to have. Output that depended on the line endings of
    // a checkout would make `--check` report drift on a machine that had done
    // nothing wrong, which would quickly teach everyone to ignore it.
    let text = readFileSync(sourceAbs, "utf8").replace(/\r\n/g, "\n");
    if (rewrite) text = rewriteImports(text, destRel, sourceRel);

    // Markdown, JSON and dotfiles have no comment syntax that belongs at the
    // top, so they carry no banner. The mirror's README says it is generated.
    const style = BANNER_STYLE[ext];
    if (style) {
      const note = banner(sourceRel, sourceSha(sourceRel), style);
      // A shebang has to be the first bytes of the file or it stops being one,
      // so on an executable script the banner goes underneath it.
      if (text.startsWith("#!")) {
        const eol = text.indexOf("\n") + 1;
        text = text.slice(0, eol) + note + text.slice(eol);
      } else {
        text = note + text;
      }
    }
    writeFileSync(destAbs, text);
    written.push(destRel);
  };

  for (const entry of EMIT) {
    const fromAbs = resolve(ROOT, entry.from);
    if (!existsSync(fromAbs)) die(`manifest entry ${entry.from} does not exist.`);

    for (const fileAbs of walk(fromAbs)) {
      const name = rel(fromAbs, fileAbs);
      if (entry.only && !entry.only.includes(name)) continue;
      const sourceRel = rel(ROOT, fileAbs);
      emit(fileAbs, sourceRel, posix.join(entry.to, name), { rewrite: true });
    }

    if (entry.only) {
      const present = new Set(readdirSync(fromAbs));
      const missing = entry.only.filter((n) => !present.has(n));
      if (missing.length > 0) {
        die(`${entry.from} no longer contains: ${missing.join(", ")}.`, [
          "The manifest names files that have moved or been renamed. Fix the",
          "`only` list rather than letting the mirror silently lose them.",
        ]);
      }
    }
  }

  const templateAbs = resolve(ROOT, TEMPLATE.from);
  if (!existsSync(templateAbs)) die(`template directory ${TEMPLATE.from} does not exist.`);
  for (const fileAbs of walk(templateAbs)) {
    const name = rel(templateAbs, fileAbs);
    const sourceRel = rel(ROOT, fileAbs);
    // Template files are already written against the mirror layout, so their
    // imports are relative and there is nothing to rewrite.
    emit(fileAbs, sourceRel, name, { rewrite: false });
  }

  return { written };
}

/** Grep the generated tree for the strings the mirror promised not to contain. */
function scan(out) {
  const patterns = FORBIDDEN.map((word) => ({ word, re: new RegExp(word, "i") }));
  const hits = [];

  for (const fileAbs of walk(out)) {
    const path = rel(out, fileAbs);
    // Dependencies and build output are not ours to answer for.
    if (PRESERVE.has(path.split(posix.sep)[0] ?? path)) continue;
    if (!CODE_EXTENSIONS.has(extname(fileAbs))) continue;
    // The mirror's own scanner necessarily contains every word it looks for.
    if (path === "scripts/denylist-scan.mjs") continue;

    readFileSync(fileAbs, "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        for (const { word, re } of patterns) {
          if (re.test(line)) hits.push({ file: rel(out, fileAbs), line: i + 1, word, text: line.trim() });
        }
      });
  }
  return hits;
}

// ── entry point ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const check = argv.includes("--check");
const outIndex = argv.indexOf("--out");
const outDir = outIndex === -1 ? DEFAULT_OUT : resolve(argv[outIndex + 1] ?? "");

if (outIndex !== -1 && !argv[outIndex + 1]) die("--out needs a directory.");

if (check) {
  const temp = mkdtempSync(join(tmpdir(), "sbr-guide-check-"));
  try {
    const { written } = generate(temp);
    const hits = scan(temp);
    if (hits.length > 0) reportScan(hits);

    if (!existsSync(outDir)) {
      die(`the mirror at ${outDir} does not exist, so drift cannot be checked.`, [
        "Run `node scripts/sync-guide.mjs` to create it.",
      ]);
    }

    const drift = [];
    for (const path of written) {
      const mirrored = join(outDir, path);
      if (!existsSync(mirrored)) {
        drift.push(`missing in mirror: ${path}`);
        continue;
      }
      if (readFileSync(join(temp, path), "utf8") !== readFileSync(mirrored, "utf8")) {
        drift.push(`differs: ${path}`);
      }
    }

    // Files in the mirror that this script would not produce. Almost always a
    // hand-edit, which is the thing the mirror contract forbids.
    const expected = new Set(written);
    for (const fileAbs of walk(outDir)) {
      const path = rel(outDir, fileAbs);
      const top = path.split(posix.sep)[0] ?? path;
      if (PRESERVE.has(top)) continue;
      if (path.endsWith(".tsbuildinfo")) continue;
      if (!expected.has(path)) drift.push(`not generated by this script: ${path}`);
    }

    if (drift.length > 0) {
      process.stderr.write(`\nsync-guide --check: the mirror has drifted (${drift.length}).\n\n`);
      for (const d of drift) process.stderr.write(`  ${d}\n`);
      process.stderr.write("\nRun `node scripts/sync-guide.mjs` and commit the result.\n\n");
      process.exit(1);
    }

    say(`sync-guide --check: ${written.length} files, no drift.`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
} else {
  const { written } = generate(outDir);
  const hits = scan(outDir);
  if (hits.length > 0) reportScan(hits);
  say(`sync-guide: wrote ${written.length} files to ${outDir}.`);
  say("The mirror is generated. Commit it there; never edit it there.");
}

function reportScan(hits) {
  process.stderr.write(`\nsync-guide: ${hits.length} forbidden reference(s) in the generated mirror.\n\n`);
  for (const hit of hits) {
    process.stderr.write(`  ${hit.file}:${hit.line}  [${hit.word}]\n    ${hit.text.slice(0, 120)}\n`);
  }
  process.stderr.write(
    "\nThe mirror stores no Hypixel-derived player value and keeps no history\n" +
      "(COMPLIANCE.md §1). Fix the source in this repository — the mirror is\n" +
      "generated, so there is nothing to fix on the other side.\n\n",
  );
  process.exit(1);
}
