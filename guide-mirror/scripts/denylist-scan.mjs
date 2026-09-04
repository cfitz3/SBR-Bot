#!/usr/bin/env node
/**
 * Fail the build if a persistence surface this project promised not to have has
 * appeared in it.
 *
 * COMPLIANCE.md §1 is a claim about what is absent, and a claim about absence is
 * worth exactly as much as the thing that checks it. This is that thing: it runs
 * in CI as a required check, so the promise is enforced by the pipeline rather
 * than by whoever happens to review the diff.
 *
 * It is a blunt instrument on purpose. A grep for a handful of words cannot
 * prove there is no tracking here — only a reader can do that — but it does
 * catch the specific way this would go wrong in practice, which is a table or a
 * type quietly reintroduced under the name it had upstream.
 *
 * **Scope: code only.** Markdown is exempt, and deliberately so: COMPLIANCE.md
 * has to be able to name the things it rules out, and a scan that forbade the
 * words would forbid the document that explains them. This is a recorded
 * decision, not an oversight — if you are tempted to smuggle something past this
 * check by putting it in a `.md` file, that is the loophole, and using it would
 * be a lie told to a reviewer.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Directories that hold generated or third-party bytes, not our source. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".cache", "generated"]);

/** Only code. See the note above about Markdown. */
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".cjs", ".js", ".prisma", ".sql"]);

/**
 * Names from the guild-tracking platform this bot was extracted from, plus the
 * generic words for the shapes they are. Matched case-insensitively.
 *
 * The specific names catch a model or type carried across by accident. The
 * generic ones — the last three — catch a new one invented under a different
 * name, which is the likelier failure.
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

/** This file necessarily contains every word it looks for. */
const SELF = resolve(ROOT, "scripts/denylist-scan.mjs");

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

const patterns = FORBIDDEN.map((word) => ({ word, re: new RegExp(word, "i") }));
const hits = [];

for (const file of walk(ROOT)) {
  if (resolve(file) === SELF) continue;
  if (!CODE_EXTENSIONS.has(extname(file))) continue;

  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const { word, re } of patterns) {
      if (re.test(line)) hits.push({ file: relative(ROOT, file), line: i + 1, word, text: line.trim() });
    }
  });
}

if (hits.length === 0) {
  process.stdout.write(`denylist scan: clean (${FORBIDDEN.length} patterns, code files only)\n`);
  process.exit(0);
}

process.stderr.write(`denylist scan: ${hits.length} forbidden reference(s)\n\n`);
for (const hit of hits) {
  process.stderr.write(`  ${hit.file}:${hit.line}  [${hit.word}]\n    ${hit.text.slice(0, 120)}\n`);
}
process.stderr.write(
  "\nCOMPLIANCE.md §1: this bot stores no Hypixel-derived player value and keeps\n" +
    "no history. If one of these is a false positive, rename it rather than\n" +
    "widening the exemption — the word is doing real work in a reviewer's eye.\n",
);
process.exit(1);
