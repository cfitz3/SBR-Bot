/**
 * `npm run embeds` — the loop that turns a design into constants.
 *
 * The problem it solves: someone shows you a card they like as a Discohook
 * export, and the honest answer to "can we do this?" is a mix of yes, no, and
 * "only if we change a number in the theme". Reading that off a JSON blob by
 * eye is how a house style stops being one.
 *
 *   learn <name>   read design/embeds/<name>.json, say what we can and cannot
 *                  carry, and print the constants the design implies
 *   check          run the house-style checker over every card the platform can
 *                  send; exit non-zero on an error, list warnings
 *   preview <name> print a gallery card as it renders, plus the Discohook JSON
 *                  to paste back
 *
 * Everything here is offline: the gallery is fixtures, so this runs in CI with
 * no database, no Hypixel key and no gateway.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ROOT, c, die, say } from "./lib.mjs";

const SPECIMENS = join(ROOT, "design", "embeds");

/**
 * The build output is imported, not the source: these packages are TS project
 * references and `dist/` is what every other process loads. If it is missing,
 * say so with the command rather than with a module-resolution stack trace.
 */
async function load(pkg) {
  const entry = join(ROOT, "packages", pkg, "dist", "index.js");
  try {
    return await import(pathToFileURL(entry).href);
  } catch {
    die(`${pkg} is not built.`, ["npm run build"]);
  }
}

const heading = (t) => say(`\n${c.bold(t)}`);
const bullet = (t) => say(`  ${c.gray("·")} ${t}`);

const severityMark = (s) => (s === "error" ? c.red("✗") : c.yellow("!"));

// ── learn ───────────────────────────────────────────────────────────────────

function readSpecimen(name) {
  const path = join(SPECIMENS, `${name}.json`);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    const available = listSpecimens();
    die(
      `No specimen called "${name}".`,
      available.length > 0
        ? [`Available: ${available.join(", ")}`, `Add one at design/embeds/${name}.json`]
        : ["Put a Discohook export at design/embeds/<name>.json"],
    );
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    die(`design/embeds/${name}.json is not valid JSON.`, [String(err.message)]);
  }
}

function listSpecimens() {
  try {
    return readdirSync(SPECIMENS)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

async function learn(name) {
  if (!name) die("Which specimen?", [`Available: ${listSpecimens().join(", ") || "(none yet)"}`]);

  const kit = await load("discord-kit");
  const { theme } = await import(pathToFileURL(join(ROOT, "brand", "dist", "index.js")).href);
  const raw = readSpecimen(name);
  const { views, notes } = kit.fromDiscordJson(raw);

  heading(`design/embeds/${name}.json`);
  if (views.length === 0) {
    die("Nothing in that file looked like an embed.", [
      "Discohook: use the JSON export, not a screenshot or a message link.",
    ]);
  }
  say(`  ${views.length} card${views.length === 1 ? "" : "s"} read.`);

  // What we cannot carry. This is the honest half and it comes first: a design
  // is worth adopting only once you know which of it survives.
  heading("What our view model cannot carry");
  if (notes.length === 0) bullet(c.green("Nothing — every part of this design is expressible."));
  else for (const note of notes) bullet(`card ${note.index + 1}: ${note.detail}`);

  // Colour, against the palette rather than in the abstract.
  heading("Colour");
  for (let i = 0; i < views.length; i += 1) {
    const stated = readColor(raw, i);
    if (stated === null) {
      bullet(`card ${i + 1}: no colour stated — we would send ${c.bold("NEUTRAL")}`);
      continue;
    }
    const match = kit.nearestColor(stated);
    const hex = `#${stated.toString(16).padStart(6, "0")}`;
    bullet(
      match.exact
        ? `card ${i + 1}: ${hex} is exactly ${c.bold(match.color)}`
        : `card ${i + 1}: ${hex} is not in the palette; nearest is ${c.bold(match.color)} ` +
            `(#${theme.embed.colors[match.color].toString(16).padStart(6, "0")})`,
    );
    if (!match.exact) {
      say(
        c.gray(
          `      To adopt it: brand/theme.ts → { embed: { colors: { ${match.color}: 0x${stated
            .toString(16)
            .padStart(6, "0")} } } }`,
        ),
      );
    }
  }

  // Where the design differs from the house style, as constants rather than as
  // an impression. These are the numbers a person would otherwise argue about.
  heading("Where this differs from the house style");
  const differences = [];
  for (const [i, view] of views.entries()) {
    const lines = (view.description ?? "").split("\n").filter((l) => l.trim() !== "").length;
    const fields = view.fields?.length ?? 0;
    const inlineRun = longestInlineRun(view.fields ?? []);
    const footer = view.footer?.length ?? 0;

    if (lines > theme.embed.style.descriptionLines) {
      differences.push(`card ${i + 1}: ${lines} description lines; ours caps at ${theme.embed.style.descriptionLines}`);
    }
    if (fields > theme.embed.style.fields) {
      differences.push(`card ${i + 1}: ${fields} fields; ours caps at ${theme.embed.style.fields}`);
    }
    if (inlineRun > 0 && inlineRun !== theme.embed.style.inlineRow) {
      differences.push(`card ${i + 1}: inline runs of ${inlineRun}; ours rows at ${theme.embed.style.inlineRow}`);
    }
    if (footer > theme.embed.style.footer) {
      differences.push(`card ${i + 1}: ${footer}-character footer; ours caps at ${theme.embed.style.footer}`);
    }
  }
  if (differences.length === 0) bullet(c.green("Nothing — this design already sits inside the house style."));
  else {
    for (const d of differences) bullet(d);
    say(c.gray("\n      Each of these is one number in brand/theme.ts → embed.style."));
  }

  // And what the checker itself says, treating the specimen as if we had sent it.
  heading("What the style checker says about it");
  const issues = kit.checkEmbeds(views.map((view, i) => ({ name: `card ${i + 1}`, view })));
  if (issues.length === 0) bullet(c.green("Clean."));
  else for (const i of issues) bullet(`${severityMark(i.severity)} ${i.card}: ${c.bold(i.rule)} — ${i.detail}`);

  say("");
}

/** The raw colour as stated, before we map it — `learn` reports both. */
function readColor(raw, index) {
  const embeds = Array.isArray(raw) ? raw : Array.isArray(raw?.embeds) ? raw.embeds : [raw];
  const value = embeds[index]?.color;
  return typeof value === "number" ? value : null;
}

function longestInlineRun(fields) {
  let best = 0;
  let run = 0;
  for (const f of fields) {
    if (f.inline === true) run += 1;
    else {
      best = Math.max(best, run);
      run = 0;
    }
  }
  return Math.max(best, run);
}

// ── check ───────────────────────────────────────────────────────────────────

async function check() {
  const kit = await load("discord-kit");
  const { GALLERY } = await load("embed-gallery");

  const issues = kit.checkEmbeds(GALLERY);
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  heading(`${GALLERY.length} cards checked`);

  if (issues.length === 0) {
    say(`  ${c.green("✓")} Clean at every rule.\n`);
    return 0;
  }

  // Grouped by card, because that is the unit somebody fixes.
  const byCard = new Map();
  for (const issue of issues) {
    if (!byCard.has(issue.card)) byCard.set(issue.card, []);
    byCard.get(issue.card).push(issue);
  }
  for (const [card, list] of byCard) {
    say(`\n  ${c.bold(card)}`);
    for (const i of list) {
      say(`    ${severityMark(i.severity)} ${c.bold(i.rule)}${i.where ? c.gray(` (${i.where})`) : ""} — ${i.detail}`);
    }
  }

  say("");
  say(
    `  ${errors.length === 0 ? c.green("0 errors") : c.red(`${errors.length} error${errors.length === 1 ? "" : "s"}`)}` +
      `, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`,
  );
  // Errors fail the run; warnings are house style, which is a judgement, and a
  // judgement that blocks CI is one people learn to switch off.
  if (errors.length > 0) {
    say(c.gray("  An error means Discord would reject the payload, or the card is unreadable.\n"));
    return 1;
  }
  say(c.gray("  Warnings are house style — fix them or ignore the rule by id in checkEmbed.\n"));
  return 0;
}

// ── preview ─────────────────────────────────────────────────────────────────

async function preview(name) {
  const kit = await load("discord-kit");
  const { GALLERY, galleryCard } = await load("embed-gallery");

  if (!name) {
    heading(`${GALLERY.length} cards`);
    for (const card of GALLERY) say(`  ${c.bold(card.name.padEnd(24))} ${c.gray(card.about)}`);
    say("");
    return 0;
  }

  const card = galleryCard(name);
  if (!card) {
    die(`No card called "${name}".`, ["npm run embeds preview   # lists every card"]);
  }

  heading(card.name);
  say(c.gray(`  ${card.about}`));
  say(c.gray(`  drawn by ${card.renderer}()`));
  say("");
  for (const line of renderPlain(card.view)) say(`  ${line}`);

  heading("As Discohook JSON");
  say(JSON.stringify({ embeds: [kit.toDiscordJson(card.view)] }, null, 2));

  const issues = kit.checkEmbed(card.view);
  if (issues.length > 0) {
    heading("Style");
    for (const i of issues) say(`  ${severityMark(i.severity)} ${c.bold(i.rule)} — ${i.detail}`);
  }
  say("");
  return 0;
}

/** A terminal approximation. Not a pixel preview — a legibility check. */
function renderPlain(view) {
  const out = [];
  if (view.title) out.push(c.bold(view.title));
  if (view.url) out.push(c.gray(view.url));
  if (view.description) {
    out.push("");
    for (const line of view.description.split("\n")) out.push(line);
  }
  for (const field of view.fields ?? []) {
    out.push("");
    out.push(`${c.bold(field.name)}${field.inline ? c.gray("  (inline)") : ""}`);
    for (const line of String(field.value).split("\n")) out.push(`  ${line}`);
  }
  if (view.footer) {
    out.push("");
    out.push(c.gray(view.footer));
  }
  out.push("");
  out.push(c.gray(`colour: ${view.color ?? "NEUTRAL"}`));
  return out;
}

// ── entry ───────────────────────────────────────────────────────────────────

const [command, argument] = process.argv.slice(2);

switch (command) {
  case "learn":
    await learn(argument);
    break;
  case "check":
    process.exitCode = await check();
    break;
  case "preview":
    process.exitCode = await preview(argument);
    break;
  default:
    say(`
${c.bold("npm run embeds")} — the embed style loop

  ${c.bold("learn <name>")}     read design/embeds/<name>.json and say what it would cost us
  ${c.bold("check")}            check every card the platform can send (CI-suitable)
  ${c.bold("preview [name]")}   list the gallery, or print one card and its Discohook JSON

Specimens: ${listSpecimens().join(", ") || c.gray("none yet — see design/embeds/README.md")}
`);
    process.exitCode = command === undefined ? 0 : 1;
}
