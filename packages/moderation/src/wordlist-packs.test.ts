import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateText, validatePattern } from "./wordlist.js";
import {
  findPack,
  isPackRuleId,
  packRuleId,
  packRules,
  parsePackSelection,
  resolveWordlist,
  NO_PACKS,
  WORDLIST_PACKS,
} from "./wordlist-packs.js";
import type { WordlistRuleDTO } from "@sbr/shared-types";

test("every shipped pattern compiles, so no pack can silently match nothing", () => {
  for (const pack of WORDLIST_PACKS) {
    for (const rule of pack.rules) {
      assert.equal(
        validatePattern(rule.pattern, rule.matchType),
        null,
        `${pack.id}:${rule.key} does not compile`,
      );
    }
  }
});

test("pack and rule keys are unique, because suppression is keyed on them", () => {
  const packIds = new Set<string>();
  for (const pack of WORDLIST_PACKS) {
    assert.equal(packIds.has(pack.id), false, `duplicate pack id ${pack.id}`);
    packIds.add(pack.id);
    const keys = new Set<string>();
    for (const rule of pack.rules) {
      assert.equal(keys.has(rule.key), false, `duplicate rule key ${pack.id}:${rule.key}`);
      keys.add(rule.key);
    }
  }
});

test("nothing is on until a guild turns it on", () => {
  assert.deepEqual(packRules("g", NO_PACKS), []);
  assert.deepEqual(parsePackSelection(null), NO_PACKS);
  assert.deepEqual(parsePackSelection("scams"), NO_PACKS);
  assert.deepEqual(parsePackSelection(["scams"]), NO_PACKS);
});

test("a pack that no longer ships goes quiet instead of resolving to nothing", () => {
  const parsed = parsePackSelection({ enabled: ["scams", "retired-pack"], suppressed: [] });
  assert.deepEqual(parsed.enabled, ["scams"]);
  assert.equal(findPack("retired-pack"), null);
});

test("suppressing one rule keeps the rest of its pack", () => {
  const all = packRules("g", { enabled: ["links"], suppressed: [] });
  const trimmed = packRules("g", { enabled: ["links"], suppressed: ["links:shortener"] });
  assert.equal(trimmed.length, all.length - 1);
  assert.equal(
    trimmed.some((r) => r.id === packRuleId("links", "shortener")),
    false,
  );
  assert.equal(
    trimmed.some((r) => r.id === packRuleId("links", "ip-logger")),
    true,
  );
});

test("suppression names a pack as well as a rule, so two packs cannot collide", () => {
  const rules = packRules("g", { enabled: ["links", "scams"], suppressed: ["scams:ip-logger"] });
  // The key belongs to `links`; suppressing it under `scams` must not reach it.
  assert.equal(
    rules.some((r) => r.id === packRuleId("links", "ip-logger")),
    true,
  );
});

test("a pack rule is the same shape as a typed one, and says which it is", () => {
  const [rule] = packRules("guild-1", { enabled: ["scams"], suppressed: [] });
  assert.ok(rule);
  assert.equal(rule.guildId, "guild-1");
  assert.equal(rule.enabled, true);
  assert.equal(isPackRuleId(rule.id), true);
  assert.equal(isPackRuleId("cuid-from-the-database"), false);
});

test("the guild's own rules lead the resolved list", () => {
  const own: WordlistRuleDTO = {
    id: "own-1",
    guildId: "g",
    pattern: "mine",
    matchType: "SUBSTRING",
    action: "FLAG",
    severity: 1,
    enabled: true,
  };
  const resolved = resolveWordlist("g", [own], { enabled: ["scams"], suppressed: [] });
  assert.equal(resolved[0]?.id, "own-1");
  assert.ok(resolved.length > 1);
});

test("an enabled pack judges a message exactly as a typed rule would", () => {
  const rules = resolveWordlist("g", [], { enabled: ["scams"], suppressed: [] });
  const hit = evaluateText(rules, "claim your free nitro here");
  assert.equal(hit.action, "BLOCK");
  assert.ok(hit.matched.length > 0);
  assert.equal(evaluateText(rules, "good luck on the dungeon run").action, "ALLOW");
});

test("risky links are flagged rather than blocked, so staff still decide", () => {
  const rules = resolveWordlist("g", [], { enabled: ["links"], suppressed: [] });
  assert.equal(evaluateText(rules, "join us at discord.gg/example").action, "FLAG");
  // Except the ones with no innocent use.
  assert.equal(evaluateText(rules, "check this grabify link").action, "BLOCK");
});

test("the Hypixel pack catches what a general-purpose list would not", () => {
  const rules = resolveWordlist("g", [], { enabled: ["hypixel"], suppressed: [] });
  assert.equal(evaluateText(rules, "selling my account, dm me").action, "BLOCK");
  assert.equal(evaluateText(rules, "selling 100 mil for paypal").action, "BLOCK");
  assert.equal(evaluateText(rules, "selling my dungeon carries for coins").action, "ALLOW");
});

test("a guild can beat a packaged rule with one of its own", () => {
  const allow: WordlistRuleDTO = {
    id: "own-1",
    guildId: "g",
    pattern: "\bbit\.ly/ourguild\b",
    matchType: "REGEX",
    action: "FLAG",
    severity: 1,
    // Disabled: this is the escape hatch shape — suppress the pack rule, keep
    // the record of why. The real allow-listing is the suppression itself.
    enabled: false,
  };
  const rules = resolveWordlist("g", [allow], {
    enabled: ["links"],
    suppressed: ["links:shortener"],
  });
  assert.equal(evaluateText(rules, "our own bit.ly/ourguild link").action, "ALLOW");
});
