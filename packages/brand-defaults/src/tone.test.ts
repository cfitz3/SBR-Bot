/**
 * The tone standard, enforced rather than remembered.
 *
 * Every rule here was a real string in this repo before the tone pass: a bot
 * apologising in the first person, an "oops" where a fact belonged, a platform
 * failure that described itself instead of pointing anywhere. Copy is edited by
 * whoever is nearest the feature, months apart, and a convention nobody can fail
 * is worth more than a style guide nobody rereads.
 *
 * It walks `DEFAULT_ERRORS` structurally, so a key added later is covered the
 * day it lands rather than the day somebody notices.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_COMMANDS } from "./defaults/commands.js";
import { DEFAULT_ERRORS } from "./defaults/errors.js";

function strings(value: unknown, path = ""): readonly (readonly [string, string])[] {
  if (typeof value === "string") return [[path, value]];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => strings(v, path === "" ? k : `${path}.${k}`));
}

const ERRORS = strings(DEFAULT_ERRORS);

test("no error speaks in the first person", () => {
  // "I couldn't open a ticket just now" makes the failure sound like a person
  // having an off day, and invites the member to wait for it to pass. The
  // platform is not a person and the member is not being asked to be patient.
  for (const [key, text] of ERRORS) {
    assert.doesNotMatch(text, /\b(I|I'm|I'll|me|my)\b/, key);
  }
});

test("no error apologises or hedges", () => {
  for (const [key, text] of ERRORS) {
    assert.doesNotMatch(text, /\b(sorry|oops|whoops|uh-oh|hmm|unfortunately|something went wrong)\b/i, key);
  }
});

test("every platform failure names where to look, and nothing else does", () => {
  // The pointer only means anything while it is scarce. A permission denial or
  // an empty search result carrying a status link would teach members that the
  // link is decoration, and then it would be ignored on the day it matters.
  const platform = new Set([
    "generic.unknown",
    "generic.saveFailed",
    "generic.loadFailed",
    "generic.upstreamDown",
    "bridge.offline",
    "command.adminFailed",
  ]);

  for (const [key, text] of ERRORS) {
    const points = /\/health/.test(text);
    assert.equal(points, platform.has(key), `${key}: ${text}`);
  }
});

test("errors stay short enough to read at a glance", () => {
  // Discord truncates nothing at this length; the limit is attention. Anything
  // longer is explaining, and an error that explains is usually one that should
  // have been two errors.
  for (const [key, text] of ERRORS) {
    assert.ok(text.length <= 120, `${key} is ${text.length} chars: ${text}`);
  }
});

test("command descriptions are a phrase, not a sentence", () => {
  // Discord renders these in a list beside the command name, where a full
  // sentence with a full stop reads as a paragraph fragment and a capitalised
  // verb reads as a heading. Discord's own commands are phrases.
  for (const [key, text] of strings(DEFAULT_COMMANDS)) {
    if (!key.endsWith(".description")) continue;
    assert.doesNotMatch(text, /\.$/, key);
    assert.ok(text.length <= 100, `${key} is ${text.length} chars`);
    assert.doesNotMatch(text, /\b(I|I'm|I'll|me|my)\b/, key);
  }
});
