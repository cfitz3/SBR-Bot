import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModerationSurface, WordlistRuleDTO } from "@sbr/shared-types";
import {
  counterRequestsFor,
  evaluateAutomod,
  parseAutomod,
  parseRule,
  parseTrigger,
  type AutomodAction,
  type AutomodContext,
  type AutomodPolicy,
  type AutomodRule,
  type AutomodTrigger,
} from "./automod.js";

function rule(trigger: AutomodTrigger, over: Partial<AutomodRule> = {}): AutomodRule {
  const action: AutomodAction = { type: "FLAG", deleteMessage: false, durationSeconds: null };
  return {
    id: "r1",
    name: "Rule one",
    enabled: true,
    surfaces: ["DISCORD", "GUILD_CHAT"],
    trigger,
    exempt: { roleIds: [], capability: null },
    action,
    ...over,
  };
}

function policy(...rules: AutomodRule[]): AutomodPolicy {
  return { enabled: true, rules };
}

function ctx(text: string, over: Partial<AutomodContext> = {}): AutomodContext {
  return {
    text,
    surface: "DISCORD" as ModerationSurface,
    authorRoleIds: [],
    authorCapabilities: [],
    mentionCount: 0,
    counters: {},
    wordlist: [],
    ...over,
  };
}

function wordRule(pattern: string): WordlistRuleDTO {
  return {
    id: "w1",
    guildId: "g1",
    pattern,
    matchType: "SUBSTRING",
    action: "BLOCK",
    severity: 2,
    enabled: true,
    addedByDiscordId: "1",
    createdAt: new Date(0).toISOString(),
  } as WordlistRuleDTO;
}

// --- triggers ---------------------------------------------------------------

test("a wordlist trigger fires off the guild's own filter rules", () => {
  const decision = evaluateAutomod(
    policy(rule({ kind: "wordlist" })),
    ctx("this is a scam site", { wordlist: [wordRule("scam")] }),
  );
  assert.equal(decision.action, "FLAG");
  assert.equal(decision.matched[0]?.trigger, "wordlist");
  assert.equal(evaluateAutomod(policy(rule({ kind: "wordlist" })), ctx("hello", { wordlist: [wordRule("scam")] })).action, "ALLOW");
});

test("a regex trigger matches case-insensitively and a malformed one never fires", () => {
  const good = evaluateAutomod(policy(rule({ kind: "regex", pattern: "free\\s+nitro", flags: "" })), ctx("FREE   NITRO here"));
  assert.equal(good.action, "FLAG");
  // Compiled at match time as well as parse time, so a policy hand-edited into
  // an invalid pattern degrades to "never fires" rather than throwing.
  const bad = evaluateAutomod(policy(rule({ kind: "regex", pattern: "(unclosed", flags: "" })), ctx("(unclosed"));
  assert.equal(bad.action, "ALLOW");
});

test("spam and repeat read their counts from the caller, keyed by rule id", () => {
  const spam = rule({ kind: "spam", messages: 5, windowSeconds: 10 }, { id: "spam" });
  assert.equal(evaluateAutomod(policy(spam), ctx("hi", { counters: { spam: 4 } })).action, "ALLOW");
  assert.equal(evaluateAutomod(policy(spam), ctx("hi", { counters: { spam: 5 } })).action, "FLAG");
  // A missing reading is zero, not a match: a Redis failure must not start
  // muting people.
  assert.equal(evaluateAutomod(policy(spam), ctx("hi")).action, "ALLOW");

  const repeat = rule({ kind: "repeat", times: 3, windowSeconds: 30 }, { id: "rep" });
  assert.equal(evaluateAutomod(policy(repeat), ctx("hi", { counters: { rep: 3 } })).action, "FLAG");
});

test("mentions, caps, links and invites each fire on their own threshold", () => {
  const mentions = rule({ kind: "mentions", max: 3 });
  assert.equal(evaluateAutomod(policy(mentions), ctx("hey", { mentionCount: 3 })).action, "ALLOW");
  assert.equal(evaluateAutomod(policy(mentions), ctx("hey", { mentionCount: 4 })).action, "FLAG");

  const caps = rule({ kind: "caps", percent: 70, minLength: 12 });
  assert.equal(evaluateAutomod(policy(caps), ctx("SHORT")).action, "ALLOW", "under minLength");
  assert.equal(evaluateAutomod(policy(caps), ctx("WHY IS NOBODY ANSWERING")).action, "FLAG");
  // Digits and punctuation are not shouting, so a number-heavy line stays clear.
  assert.equal(evaluateAutomod(policy(caps), ctx("selling 1234567890 coins ok")).action, "ALLOW");

  const links = rule({ kind: "links", allowlist: ["example.com"] });
  assert.equal(evaluateAutomod(policy(links), ctx("see https://cdn.example.com/x")).action, "ALLOW", "subdomain of an allowed host");
  assert.equal(evaluateAutomod(policy(links), ctx("see notexample.com/x")).action, "FLAG", "suffix must break on a dot");
  assert.equal(evaluateAutomod(policy(links), ctx("visit evil.tld now")).action, "FLAG");

  const invites = rule({ kind: "invites" });
  assert.equal(evaluateAutomod(policy(invites), ctx("join discord.gg/abc123")).action, "FLAG");
  assert.equal(evaluateAutomod(policy(invites), ctx("talk to me on discord")).action, "ALLOW");
});

// --- gating -----------------------------------------------------------------

test("the master switch stops everything without unpicking the rules", () => {
  const p: AutomodPolicy = { enabled: false, rules: [rule({ kind: "invites" })] };
  assert.deepEqual(evaluateAutomod(p, ctx("discord.gg/abc")).matched, []);
  assert.equal(evaluateAutomod(p, ctx("discord.gg/abc")).action, "ALLOW");
});

test("a rule only fires on the surfaces it names", () => {
  const discordOnly = rule({ kind: "invites" }, { surfaces: ["DISCORD"] });
  assert.equal(evaluateAutomod(policy(discordOnly), ctx("discord.gg/a", { surface: "DISCORD" })).action, "FLAG");
  assert.equal(evaluateAutomod(policy(discordOnly), ctx("discord.gg/a", { surface: "GUILD_CHAT" })).action, "ALLOW");
});

test("either exemption is enough, so one rule covers staff on both surfaces", () => {
  const exempt = rule(
    { kind: "invites" },
    { exempt: { roleIds: ["role-staff"], capability: "BYPASS_FILTER" } },
  );
  assert.equal(evaluateAutomod(policy(exempt), ctx("discord.gg/a", { authorRoleIds: ["role-staff"] })).action, "ALLOW");
  assert.equal(
    evaluateAutomod(policy(exempt), ctx("discord.gg/a", { authorCapabilities: ["BYPASS_FILTER"] })).action,
    "ALLOW",
  );
  assert.equal(evaluateAutomod(policy(exempt), ctx("discord.gg/a", { authorRoleIds: ["role-member"] })).action, "FLAG");
});

test("a disabled rule is skipped", () => {
  assert.equal(evaluateAutomod(policy(rule({ kind: "invites" }, { enabled: false })), ctx("discord.gg/a")).action, "ALLOW");
});

// --- precedence -------------------------------------------------------------

test("the strongest action wins regardless of the order rules sit in", () => {
  const flag = rule({ kind: "invites" }, { id: "a", name: "Invites", action: { type: "FLAG", deleteMessage: false, durationSeconds: null } });
  const mute = rule({ kind: "links", allowlist: [] }, { id: "b", name: "Links", action: { type: "MUTE", deleteMessage: false, durationSeconds: 600 } });
  const forwards = evaluateAutomod(policy(flag, mute), ctx("discord.gg/abc"));
  const backwards = evaluateAutomod(policy(mute, flag), ctx("discord.gg/abc"));
  assert.equal(forwards.action, "MUTE");
  assert.equal(backwards.action, "MUTE");
  assert.equal(forwards.durationSeconds, 600);
  assert.equal(forwards.matched.length, 2, "both matches are reported, not just the deciding one");
});

test("a delete asked for by any matched rule stands even when a harsher rule decides", () => {
  const deleter = rule({ kind: "invites" }, { id: "a", action: { type: "FLAG", deleteMessage: true, durationSeconds: null } });
  const warner = rule({ kind: "links", allowlist: [] }, { id: "b", action: { type: "WARN", deleteMessage: false, durationSeconds: null } });
  const decision = evaluateAutomod(policy(deleter, warner), ctx("discord.gg/abc"));
  assert.equal(decision.action, "WARN");
  assert.equal(decision.deleteMessage, true);
});

test("between two mutes the longer holds, and an unbounded one outranks any finite one", () => {
  const short = rule({ kind: "invites" }, { id: "a", action: { type: "MUTE", deleteMessage: false, durationSeconds: 60 } });
  const long = rule({ kind: "links", allowlist: [] }, { id: "b", action: { type: "MUTE", deleteMessage: false, durationSeconds: 3600 } });
  assert.equal(evaluateAutomod(policy(short, long), ctx("discord.gg/a")).durationSeconds, 3600);
  assert.equal(evaluateAutomod(policy(long, short), ctx("discord.gg/a")).durationSeconds, 3600);

  const forever = rule({ kind: "links", allowlist: [] }, { id: "c", action: { type: "MUTE", deleteMessage: false, durationSeconds: null } });
  assert.equal(evaluateAutomod(policy(short, forever), ctx("discord.gg/a")).durationSeconds, null);
});

test("the reason names every rule that fired, so the audit row explains itself", () => {
  const a = rule({ kind: "invites" }, { id: "a", name: "No invites" });
  const b = rule({ kind: "links", allowlist: [] }, { id: "b", name: "No links" });
  assert.equal(evaluateAutomod(policy(a, b), ctx("discord.gg/x")).reason, "Automod: No invites, No links");
});

// --- counter requests -------------------------------------------------------

test("counter requests cover only the windowed rules that apply to this surface", () => {
  const p = policy(
    rule({ kind: "spam", messages: 5, windowSeconds: 10 }, { id: "s1" }),
    rule({ kind: "repeat", times: 3, windowSeconds: 30 }, { id: "r1", surfaces: ["GUILD_CHAT"] }),
    rule({ kind: "invites" }, { id: "i1" }),
    rule({ kind: "spam", messages: 2, windowSeconds: 5 }, { id: "s2", enabled: false }),
  );
  assert.deepEqual(counterRequestsFor(p, "DISCORD"), [{ ruleId: "s1", kind: "spam", windowSeconds: 10 }]);
  assert.deepEqual(counterRequestsFor(p, "GUILD_CHAT"), [
    { ruleId: "s1", kind: "spam", windowSeconds: 10 },
    { ruleId: "r1", kind: "repeat", windowSeconds: 30 },
  ]);
  assert.deepEqual(counterRequestsFor({ ...p, enabled: false }, "DISCORD"), []);
});

// --- parsing ----------------------------------------------------------------

test("an unparseable trigger is refused rather than defaulted into something else", () => {
  assert.equal(parseTrigger({ kind: "nonsense" }), null);
  assert.equal(parseTrigger({ kind: "regex", pattern: "(unclosed", flags: "" }), null);
  assert.equal(parseTrigger({ kind: "regex", pattern: "   ", flags: "" }), null);
  assert.deepEqual(parseTrigger({ kind: "spam" }), { kind: "spam", messages: 5, windowSeconds: 10 });
  assert.deepEqual(parseTrigger({ kind: "caps", percent: 400 }), { kind: "caps", percent: 100, minLength: 12 });
});

test("a rule saved without surfaces means everywhere, not nowhere", () => {
  const parsed = parseRule({ id: "x", trigger: { kind: "invites" } });
  assert.deepEqual(parsed?.surfaces, ["DISCORD", "GUILD_CHAT"]);
  assert.equal(parsed?.name, "x", "an unnamed rule falls back to its id rather than being dropped");
  assert.deepEqual(parsed?.action, { type: "FLAG", deleteMessage: false, durationSeconds: null });
});

test("a duration only survives on a MUTE", () => {
  const warn = parseRule({ id: "x", trigger: { kind: "invites" }, action: { type: "WARN", durationSeconds: 600 } });
  assert.equal(warn?.action.durationSeconds, null);
  const mute = parseRule({ id: "x", trigger: { kind: "invites" }, action: { type: "MUTE", durationSeconds: 600 } });
  assert.equal(mute?.action.durationSeconds, 600);
});

test("the default policy is off and empty", () => {
  assert.deepEqual(parseAutomod(null), { enabled: false, rules: [] });
  assert.deepEqual(parseAutomod("nonsense"), { enabled: false, rules: [] });
});

test("one mangled rule costs that rule, and duplicate ids collapse to the first", () => {
  const parsed = parseAutomod({
    enabled: true,
    rules: [
      { id: "a", trigger: { kind: "invites" } },
      { id: "b", trigger: { kind: "regex", pattern: "(bad" } },
      { trigger: { kind: "invites" } },
      { id: "a", name: "duplicate", trigger: { kind: "invites" } },
    ],
  });
  assert.equal(parsed.enabled, true);
  assert.deepEqual(parsed.rules.map((r) => r.id), ["a"]);
  assert.equal(parsed.rules[0]?.name, "a", "the first id wins, so a duplicate cannot steal a spam counter");
});
