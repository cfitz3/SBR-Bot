import assert from "node:assert/strict";
import { test } from "node:test";
import type { WordlistRuleDTO } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import type { NewWordlistRecord, WordlistRepository } from "./ports.js";
import { compileRule, evaluateText, validatePattern, WordlistServiceImpl } from "./wordlist.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

function rule(over: Partial<WordlistRuleDTO>): WordlistRuleDTO {
  return {
    id: "r1",
    guildId: "g1",
    pattern: "badword",
    matchType: "SUBSTRING",
    action: "FLAG",
    severity: 1,
    enabled: true,
    ...over,
  };
}

function repo(seed: WordlistRuleDTO[] = []): WordlistRepository & { rows: WordlistRuleDTO[] } {
  const rows = [...seed];
  return {
    rows,
    async list() { return rows; },
    async add(input: NewWordlistRecord) {
      const created = rule({ ...input, id: `r${rows.length + 1}`, enabled: true });
      rows.push(created);
      return created;
    },
    async removeById(_g, id) {
      const i = rows.findIndex((r) => r.id === id);
      return i === -1 ? null : rows.splice(i, 1)[0]!;
    },
    async removeByPattern(_g, pattern) {
      const i = rows.findIndex((r) => r.pattern === pattern);
      return i === -1 ? null : rows.splice(i, 1)[0]!;
    },
  };
}

test("each match type compiles to the matcher its name promises", () => {
  assert.equal(compileRule({ pattern: "hi", matchType: "EXACT" })("HI"), true);
  assert.equal(compileRule({ pattern: "hi", matchType: "EXACT" })("hi there"), false);
  assert.equal(compileRule({ pattern: "hi", matchType: "SUBSTRING" })("say HI there"), true);
  assert.equal(compileRule({ pattern: "^a.c$", matchType: "REGEX" })("abc"), true);
  assert.equal(compileRule({ pattern: "b*d", matchType: "WILDCARD" })("bad"), true);
  assert.equal(compileRule({ pattern: "b*d", matchType: "WILDCARD" })("xbadx"), false);
});

test("a wildcard's literal characters are not treated as regex syntax", () => {
  // Without escaping, "a.c" would match "abc" and quietly over-block.
  assert.equal(compileRule({ pattern: "a.c", matchType: "WILDCARD" })("abc"), false);
  assert.equal(compileRule({ pattern: "a.c", matchType: "WILDCARD" })("a.c"), true);
});

test("a malformed regex never fires rather than throwing at relay time", () => {
  assert.equal(compileRule({ pattern: "(", matchType: "REGEX" })("anything"), false);
  assert.equal(validatePattern("(", "REGEX") === null, false);
  assert.equal(validatePattern("(", "SUBSTRING"), null);
  assert.equal(validatePattern("   ", "SUBSTRING") === null, false);
});

test("a harsher rule outranks a softer one regardless of order", () => {
  const rules = [rule({ id: "a", action: "REPLACE" }), rule({ id: "b", action: "BLOCK" })];
  assert.equal(evaluateText(rules, "a badword here").action, "BLOCK");
  assert.equal(evaluateText([...rules].reverse(), "a badword here").action, "BLOCK");
});

test("a replace verdict carries the censored text the relay would post", () => {
  const verdict = evaluateText([rule({ action: "REPLACE" })], "say badword now");
  assert.equal(verdict.action, "REPLACE");
  assert.equal(verdict.replacement, "*** ******* ***");
});

test("a flag verdict leaves the message intact", () => {
  const verdict = evaluateText([rule({ action: "FLAG" })], "say badword now");
  assert.equal(verdict.action, "FLAG");
  assert.equal(verdict.replacement, null);
});

test("a clean message allows, matching nothing", () => {
  const verdict = evaluateText([rule({})], "perfectly fine");
  assert.equal(verdict.action, "ALLOW");
  assert.deepEqual(verdict.matched, []);
});

test("a disabled rule is inert", () => {
  assert.equal(evaluateText([rule({ enabled: false })], "badword").action, "ALLOW");
});

test("adding an invalid regex is refused with the reason", async () => {
  const svc = new WordlistServiceImpl({ repo: repo(), logger: silent });
  const r = await svc.add({
    guildId: "g1", pattern: "(", matchType: "REGEX", action: "BLOCK", addedByDiscordId: "u1",
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.kind, "INVALID_PATTERN");
});

test("adding the same pattern twice is refused as a duplicate", async () => {
  const svc = new WordlistServiceImpl({ repo: repo([rule({})]), logger: silent });
  const r = await svc.add({
    guildId: "g1", pattern: "badword", matchType: "SUBSTRING", action: "FLAG", addedByDiscordId: "u1",
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.kind, "DUPLICATE");
});

test("removal accepts either a rule id or the pattern itself", async () => {
  const store = repo([rule({ id: "r1", pattern: "one" }), rule({ id: "r2", pattern: "two" })]);
  const svc = new WordlistServiceImpl({ repo: store, logger: silent });
  const byId = await svc.remove("g1", "r1");
  assert.equal(byId.ok && byId.value?.pattern, "one");
  const byPattern = await svc.remove("g1", "two");
  assert.equal(byPattern.ok && byPattern.value?.id, "r2");
  assert.equal(store.rows.length, 0);
});

test("removing something that isn't there reports nothing rather than failing", async () => {
  const svc = new WordlistServiceImpl({ repo: repo(), logger: silent });
  const r = await svc.remove("g1", "nope");
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.value, null);
});

test("/filter-test runs the live rule set", async () => {
  const svc = new WordlistServiceImpl({ repo: repo([rule({ action: "BLOCK" })]), logger: silent });
  const r = await svc.test("g1", "contains badword");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.action, "BLOCK");
  assert.equal(r.value.matched.length, 1);
});
