/**
 * The two claims this package makes: a stored blob only ever yields rules that
 * can actually be run, and a rule fires exactly when the guild said it should.
 *
 * Both are worth pinning because the action is public. A rule that fires when
 * it should not reposts a member's message into a channel they did not choose,
 * and a rule that silently vanishes on read is a starboard staff think is on.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TriggerRule } from "@sbr/shared-types";
import {
  MAX_TRIGGER_RULES,
  normalizeEmoji,
  parseTriggers,
  validateTriggers,
} from "./policy.js";
import { firedByMessage, firedByReaction, firingKey } from "./match.js";

const CHANNEL = "800000000000000001";
const OTHER = "800000000000000002";

const starboard = (over: Partial<TriggerRule> = {}): TriggerRule => ({
  id: "starboard",
  label: "Starboard",
  enabled: true,
  when: { kind: "REACTION_COUNT", emoji: "⭐", threshold: 3 },
  then: { kind: "REPOST", channelId: OTHER },
  channels: [],
  exemptChannels: [],
  includeBots: false,
  includeSelf: false,
  ...over,
});

const reaction = (over: Partial<Parameters<typeof firedByReaction>[1]> = {}) => ({
  channelId: CHANNEL,
  messageId: "m1",
  emoji: "⭐",
  count: 3,
  authorId: "900000000000000001",
  authorIsBot: false,
  authorReacted: false,
  ...over,
});

test("a stored starboard survives the round trip", () => {
  const stored = {
    rules: [
      {
        id: "starboard",
        label: "Starboard",
        when: { kind: "REACTION_COUNT", emoji: "⭐", threshold: 3 },
        then: { kind: "REPOST", channelId: OTHER },
      },
    ],
  };
  assert.equal(validateTriggers(stored), null);
  const [rule] = parseTriggers(stored);
  assert.ok(rule);
  // Absent means on, and both "include" flags default to the safe reading.
  assert.deepEqual([rule.enabled, rule.includeBots, rule.includeSelf], [true, false, false]);
});

test("one unrunnable rule costs itself and not the list", () => {
  const parsed = parseTriggers({
    rules: [
      { id: "broken", label: "Broken", when: { kind: "REACTION_COUNT", emoji: "⭐" }, then: { kind: "PIN" } },
      { id: "fine", label: "Fine", when: { kind: "MESSAGE_CONTAINS", phrase: "gg" }, then: { kind: "PIN" } },
    ],
  });
  assert.deepEqual(parsed.map((r) => r.id), ["fine"]);
});

test("a duplicate id is dropped rather than shadowing the first", () => {
  const parsed = parseTriggers({
    rules: [
      { id: "a", label: "First", when: { kind: "MESSAGE_CONTAINS", phrase: "one" }, then: { kind: "PIN" } },
      { id: "a", label: "Second", when: { kind: "MESSAGE_CONTAINS", phrase: "two" }, then: { kind: "PIN" } },
    ],
  });
  assert.deepEqual(parsed.map((r) => r.label), ["First"]);
});

test("the reader stops at the cap the writer refuses to exceed", () => {
  const rules = Array.from({ length: MAX_TRIGGER_RULES + 2 }, (_, i) => ({
    id: `r${i}`,
    label: `R${i}`,
    when: { kind: "MESSAGE_CONTAINS", phrase: "gg" },
    then: { kind: "PIN" },
  }));
  assert.equal(parseTriggers({ rules }).length, MAX_TRIGGER_RULES);
  assert.match(validateTriggers({ rules }) ?? "", /at most/);
});

test("the strict half names what is wrong, once", () => {
  assert.match(validateTriggers({}) ?? "", /must be a list/);
  assert.match(validateTriggers({ rules: [{ id: "Bad Id" }] }) ?? "", /id of lowercase/);
  assert.match(
    validateTriggers({ rules: [{ id: "a", label: "A", when: { kind: "REACTION_COUNT", emoji: "⭐", threshold: 0 }, then: { kind: "PIN" } }] }) ?? "",
    /reaction count between/,
  );
  assert.match(
    validateTriggers({ rules: [{ id: "a", label: "A", when: { kind: "MESSAGE_CONTAINS", phrase: "gg" }, then: { kind: "REPOST", channelId: "nope" } }] }) ?? "",
    /channel to repost to/,
  );
});

test("custom emoji keep their id, so two servers' :star: are different emoji", () => {
  assert.equal(normalizeEmoji("<:sbrstar:800000000000000003>"), "sbrstar:800000000000000003");
  assert.equal(normalizeEmoji("<a:spin:800000000000000004>"), "spin:800000000000000004");
  assert.equal(normalizeEmoji("⭐"), "⭐");
  assert.equal(normalizeEmoji("  "), null);
});

test("a reaction fires its rule at the threshold and not before", () => {
  const rules = [starboard()];
  assert.equal(firedByReaction(rules, reaction({ count: 2 })).length, 0);
  assert.equal(firedByReaction(rules, reaction({ count: 3 })).length, 1);
  assert.equal(firedByReaction(rules, reaction({ count: 9 })).length, 1);
});

test("the author's own star does not count toward their own board", () => {
  const rules = [starboard()];
  assert.equal(firedByReaction(rules, reaction({ count: 3, authorReacted: true })).length, 0);
  assert.equal(firedByReaction(rules, reaction({ count: 4, authorReacted: true })).length, 1);
  // Unless the guild says otherwise.
  const permissive = [starboard({ includeSelf: true })];
  assert.equal(firedByReaction(permissive, reaction({ count: 3, authorReacted: true })).length, 1);
});

test("scope is an allowlist when set, and an exemption always wins", () => {
  assert.equal(firedByReaction([starboard({ channels: [OTHER] })], reaction()).length, 0);
  assert.equal(firedByReaction([starboard({ channels: [CHANNEL] })], reaction()).length, 1);
  assert.equal(
    firedByReaction([starboard({ channels: [CHANNEL], exemptChannels: [CHANNEL] })], reaction()).length,
    0,
  );
});

test("a different emoji, a disabled rule and a bot's message all fire nothing", () => {
  assert.equal(firedByReaction([starboard()], reaction({ emoji: "🌟" })).length, 0);
  assert.equal(firedByReaction([starboard({ enabled: false })], reaction()).length, 0);
  assert.equal(firedByReaction([starboard()], reaction({ authorIsBot: true })).length, 0);
  assert.equal(firedByReaction([starboard({ includeBots: true })], reaction({ authorIsBot: true })).length, 1);
});

test("a reaction rule is never fired by a message, or the reverse", () => {
  const phrase: TriggerRule = starboard({
    id: "gg",
    when: { kind: "MESSAGE_CONTAINS", phrase: "gg" },
    then: { kind: "PIN" },
  });
  const message = {
    channelId: CHANNEL,
    messageId: "m1",
    content: "GG everyone",
    authorId: "900000000000000001",
    authorIsBot: false,
  };
  assert.deepEqual(firedByMessage([starboard(), phrase], message).map((r) => r.id), ["gg"]);
  assert.deepEqual(firedByReaction([starboard(), phrase], reaction()).map((r) => r.id), ["starboard"]);
  assert.equal(firedByMessage([phrase], { ...message, content: "good game" }).length, 0);
});

test("the firing key separates two rules watching one message", () => {
  assert.notEqual(firingKey(starboard(), "m1"), firingKey(starboard({ id: "pinboard" }), "m1"));
  assert.notEqual(firingKey(starboard(), "m1"), firingKey(starboard(), "m2"));
});
