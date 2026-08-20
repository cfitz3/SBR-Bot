/**
 * The anti-drift guard for the browser's copy of the greeter's renderer.
 *
 * Runs under `node --test`, never in a browser, which is why it may import
 * `@sbr/roles` when the module it covers may not. A preview that renders
 * differently from the greeter is worse than no preview: it is a wrong answer
 * given confidently at the one moment somebody is checking their work.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { WELCOME_TOKENS as REAL_TOKENS, renderTemplate } from "@sbr/roles";
import { SAMPLE_VALUES, WELCOME_TOKENS, renderPreview } from "./welcome-preview.js";

test("the browser knows the same tokens the renderer does", () => {
  assert.deepEqual([...WELCOME_TOKENS].sort(), [...REAL_TOKENS].sort());
});

test("every token has a sample value", () => {
  for (const token of WELCOME_TOKENS) {
    assert.ok(SAMPLE_VALUES[token].length > 0, `${token} has no sample`);
  }
});

const CASES: readonly string[] = [
  "Welcome {user} to {server} — you're member #{memberCount}.",
  "{username} left.",
  "{ign} joined the guild at {guildRank}.",
  // A token that does not exist must render literally, so a typo looks like a
  // typo rather than like the message being empty.
  "Hello {membercount} and {nope}",
  // Broadcasts are neutered by the renderer itself, not only by allowedMentions.
  "@everyone say hi to {user}, and @here too",
  // A value that is itself token-shaped must not expand a second time.
  "{username} is here",
  "",
  "No tokens at all.",
];

test("the preview agrees with the greeter, character for character", () => {
  for (const template of CASES) {
    assert.equal(
      renderPreview(template, SAMPLE_VALUES),
      renderTemplate(template, SAMPLE_VALUES),
      `drifted on: ${template}`,
    );
  }
});

test("a nickname shaped like a token is not re-scanned", () => {
  const values = { ...SAMPLE_VALUES, username: "{server}" };
  assert.equal(renderPreview("hi {username}", values), "hi {server}");
  assert.equal(renderPreview("hi {username}", values), renderTemplate("hi {username}", values));
});
