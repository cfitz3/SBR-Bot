/**
 * The gallery is only worth having if it is complete, so completeness is
 * measured rather than claimed.
 *
 * Every package that exports a card renderer is scanned for functions whose
 * names say so, and every one of them must appear in `GALLERY`. A renderer
 * added next month with no fixture fails here — which is the moment to notice,
 * rather than the moment someone reports an embed Discord refused to send.
 *
 * The list below is the whole set of packages allowed to draw a card. Adding to
 * it is the deliberate act it should be: a card built somewhere unscanned is a
 * card no style check ever sees.
 */
import * as admin from "@sbr/commands-admin";
import * as bridge from "@sbr/commands-bridge";
import * as triggers from "@sbr/triggers";
import { checkEmbeds } from "@sbr/discord-kit";
import assert from "node:assert/strict";
import { test } from "node:test";

import { coveredRenderers, GALLERY, galleryCard } from "./index.js";

/**
 * `render…Embed` draws one card, `render…Pages` draws several. Deliberately
 * name-based: a convention the codebase already follows everywhere, and the
 * alternative — a hand-kept list of renderers — is the drift this test exists
 * to catch.
 */
const RENDERER = /^render[A-Za-z]*(Embed|Pages)$/;

function renderersOf(mod: Record<string, unknown>): readonly string[] {
  return Object.keys(mod).filter((k) => RENDERER.test(k) && typeof mod[k] === "function");
}

const SOURCES: readonly Record<string, unknown>[] = [bridge, admin, triggers];

function allRenderers(): readonly string[] {
  return SOURCES.flatMap((mod) => renderersOf(mod));
}

test("every renderer the card-drawing packages export has at least one card", () => {
  const covered = coveredRenderers();
  const missing = allRenderers().filter((name) => !covered.has(name));
  assert.deepEqual(missing, [], `renderers with no gallery card: ${missing.join(", ")}`);
});

test("the gallery names no renderer that does not exist", () => {
  // The other direction: a renamed renderer leaves a card pointing at nothing,
  // and a card that renders nothing is worse than an absent one.
  const real = new Set(allRenderers());
  for (const name of coveredRenderers()) {
    assert.ok(real.has(name), `${name} is in the gallery but no scanned package exports it`);
  }
});

test("card names are unique — they are how the CLI addresses a card", () => {
  const seen = new Set<string>();
  for (const c of GALLERY) {
    assert.ok(!seen.has(c.name), `duplicate card name: ${c.name}`);
    seen.add(c.name);
  }
});

test("card names are kebab-case ids, not prose", () => {
  for (const c of GALLERY) assert.match(c.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, c.name);
});

test("every card says what it is for", () => {
  for (const c of GALLERY) assert.ok(c.about.trim().length > 0, c.name);
});

test("galleryCard finds a card by name and answers undefined for a stranger", () => {
  assert.equal(galleryCard("roster")?.name, "roster");
  assert.equal(galleryCard("no-such-card"), undefined);
});

test("no card in the gallery is illegal to send", () => {
  // Errors only. Warnings are house style and are reported by `npm run embeds
  // check` for a human to weigh; an error means Discord would reject the payload
  // or the card is unreadable, and neither is a matter of taste.
  const errors = checkEmbeds(GALLERY).filter((i) => i.severity === "error");
  const report = errors.map((i) => `${i.card}: ${i.rule} — ${i.detail}`).join("\n");
  assert.deepEqual(errors, [], `\n${report}`);
});
