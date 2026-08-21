import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_STICKIES,
  MAX_STICKIES,
  MAX_STICKY_CONTENT,
  findSticky,
  parseStickies,
  removeSticky,
  upsertSticky,
  validateStickies,
  type StickyDoc,
} from "./sticky.js";

function doc(...channelIds: readonly string[]): StickyDoc {
  return { stickies: channelIds.map((channelId) => ({ channelId, content: `note for ${channelId}`, enabled: true })) };
}

test("nothing stored, and anything unrecognisable, reads as no stickies", () => {
  assert.deepEqual(parseStickies(null), DEFAULT_STICKIES);
  assert.deepEqual(parseStickies("stickies"), DEFAULT_STICKIES);
  assert.deepEqual(parseStickies({ stickies: "one" }), DEFAULT_STICKIES);
});

test("an entry missing a channel or a message is dropped rather than half-read", () => {
  const parsed = parseStickies({
    stickies: [{ content: "orphan" }, { channelId: "c1" }, { channelId: "c2", content: "  keep me  " }],
  });
  assert.deepEqual(parsed.stickies, [{ channelId: "c2", content: "keep me", enabled: true }]);
});

test("a second sticky for the same channel is dropped — one channel, one bottom", () => {
  const parsed = parseStickies({
    stickies: [
      { channelId: "c1", content: "first" },
      { channelId: "c1", content: "second" },
    ],
  });
  assert.equal(parsed.stickies.length, 1);
  assert.equal(parsed.stickies[0]?.content, "first");
});

test("enabled defaults to on, and is respected when it is off", () => {
  const parsed = parseStickies({
    stickies: [
      { channelId: "c1", content: "on by omission" },
      { channelId: "c2", content: "off", enabled: false },
    ],
  });
  assert.equal(parsed.stickies[0]?.enabled, true);
  assert.equal(parsed.stickies[1]?.enabled, false);
});

test("an over-long message is trimmed on read rather than dropping the sticky", () => {
  const parsed = parseStickies({ stickies: [{ channelId: "c1", content: "x".repeat(MAX_STICKY_CONTENT + 50) }] });
  assert.equal(parsed.stickies[0]?.content.length, MAX_STICKY_CONTENT);
});

test("findSticky answers only for a channel with one switched on", () => {
  const parsed = parseStickies({
    stickies: [
      { channelId: "c1", content: "here" },
      { channelId: "c2", content: "paused", enabled: false },
    ],
  });
  assert.equal(findSticky(parsed, "c1")?.content, "here");
  assert.equal(findSticky(parsed, "c2"), null);
  assert.equal(findSticky(parsed, "c3"), null);
});

test("validate names the first thing wrong, in the order a form would show it", () => {
  assert.match(validateStickies(null) ?? "", /must be an object/);
  assert.match(validateStickies({ stickies: {} }) ?? "", /must be a list/);
  assert.match(validateStickies({ stickies: [{ content: "x" }] }) ?? "", /needs a channel/);
  assert.match(validateStickies({ stickies: [{ channelId: "c1" }] }) ?? "", /needs something to say/);
  assert.match(
    validateStickies({ stickies: [{ channelId: "c1", content: "x".repeat(MAX_STICKY_CONTENT + 1) }] }) ?? "",
    new RegExp(String(MAX_STICKY_CONTENT)),
  );
  assert.match(
    validateStickies({ stickies: [{ channelId: "c1", content: "a", enabled: "yes" }] }) ?? "",
    /must be a boolean/,
  );
  assert.match(
    validateStickies({ stickies: [{ channelId: "c1", content: "a" }, { channelId: "c1", content: "b" }] }) ?? "",
    /same channel/,
  );
  assert.equal(validateStickies({ stickies: [{ channelId: "c1", content: "a" }] }), null);
});

test("validate refuses more stickies than a server should have", () => {
  const many = { stickies: Array.from({ length: MAX_STICKIES + 1 }, (_, i) => ({ channelId: `c${String(i)}`, content: "x" })) };
  assert.match(validateStickies(many) ?? "", new RegExp(String(MAX_STICKIES)));
});

test("upsert replaces a channel's sticky in place and adds a new one", () => {
  const before = doc("c1");
  const edited = upsertSticky(before, { channelId: "c1", content: "new words", enabled: true });
  assert.equal(edited?.stickies.length, 1);
  assert.equal(edited?.stickies[0]?.content, "new words");

  const added = upsertSticky(before, { channelId: "c2", content: "second", enabled: true });
  assert.equal(added?.stickies.length, 2);
  // The original is untouched: these are documents, not mutations.
  assert.equal(before.stickies.length, 1);
});

test("the cap stops a new channel but never blocks editing an existing one", () => {
  const full = doc(...Array.from({ length: MAX_STICKIES }, (_, i) => `c${String(i)}`));
  assert.equal(upsertSticky(full, { channelId: "new", content: "x", enabled: true }), null);
  assert.notEqual(upsertSticky(full, { channelId: "c0", content: "edited", enabled: true }), null);
});

test("removing a channel that has none says so rather than reporting a change", () => {
  const before = doc("c1", "c2");
  assert.deepEqual(removeSticky(before, "c1")?.stickies.map((s) => s.channelId), ["c2"]);
  assert.equal(removeSticky(before, "c9"), null);
});
