/**
 * The three shapes a person actually types into an emoji box, and the ones
 * Discord rejects the whole message over.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { emojiPayload, formatEmoji, normalizeEmoji, parseEmoji } from "./emoji.js";

test("a plain unicode emoji is read as itself", () => {
  const parsed = parseEmoji("🎫");
  assert.deepEqual(parsed, { kind: "unicode", value: "🎫" });
});

test("the emoji a keyboard actually produces are all accepted", () => {
  for (const emoji of ["🎫", "⚠️", "❤️", "👍🏽", "👨‍👩‍👧‍👦", "🇬🇧", "1️⃣", "#️⃣", "🏳️‍🌈", "✅"]) {
    assert.notEqual(parseEmoji(emoji), null, `${emoji} should be accepted`);
  }
});

test("a custom emoji is read in every form it is written in", () => {
  assert.deepEqual(parseEmoji("<:star:123456789012345>"), {
    kind: "custom",
    name: "star",
    id: "123456789012345",
    animated: false,
  });
  assert.deepEqual(parseEmoji("<a:spin:123456789012345>"), {
    kind: "custom",
    name: "spin",
    id: "123456789012345",
    animated: true,
  });
  // The stored form, which is what a gateway reaction event carries.
  assert.deepEqual(parseEmoji("star:123456789012345"), {
    kind: "custom",
    name: "star",
    id: "123456789012345",
    animated: false,
  });
});

test("what Discord would reject is refused here instead", () => {
  for (const bad of [":)", ":tada:", "hello", "a", "", "  ", "🎫🎟️", "🎫 ticket", "<:x:12>", "<::123456789012345>"]) {
    assert.equal(parseEmoji(bad), null, `${bad} should be refused`);
  }
});

test("a custom emoji is stored the way the gateway reports it", () => {
  const normalized = normalizeEmoji("<a:spin:123456789012345>");
  assert.deepEqual(normalized, { ok: true, value: "a:spin:123456789012345" });
  assert.equal(formatEmoji(parseEmoji("<:star:123456789012345>")!), "star:123456789012345");
});

test("an empty box means no emoji, not a bad one", () => {
  assert.deepEqual(normalizeEmoji("   "), { ok: true, value: null });
  assert.deepEqual(normalizeEmoji(null), { ok: true, value: null });
});

test("a refusal names what was typed and what would work", () => {
  const shortcode = normalizeEmoji(":tada:");
  assert.equal(shortcode.ok, false);
  assert.match(shortcode.ok ? "" : shortcode.reason, /shortcode/);

  const two = normalizeEmoji("🎫🎟️");
  assert.equal(two.ok, false);
  assert.match(two.ok ? "" : two.reason, /more than one emoji/);

  const nonsense = normalizeEmoji(":)");
  assert.equal(nonsense.ok, false);
  assert.match(nonsense.ok ? "" : nonsense.reason, /not an emoji/);
});

test("a unicode emoji is sent as a name and a custom one as an id", () => {
  assert.deepEqual(emojiPayload(parseEmoji("🎫")!), { name: "🎫" });
  assert.deepEqual(emojiPayload(parseEmoji("<a:spin:123456789012345>")!), {
    id: "123456789012345",
    name: "spin",
    animated: true,
  });
});
