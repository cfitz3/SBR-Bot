/**
 * Reading a stored policy back. The interesting cases are all about damage:
 * a rule from a newer build, a half-written rule, a duplicated key.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_AUTO_ROLES, parseAutoRoles, validateAutoRoles } from "./policy.js";

const ok = {
  enabled: true,
  rules: [
    { key: "guild-member", label: "Guild member", trigger: { kind: "IN_GUILD" }, roleId: "1", revokeWhenUnqualified: true },
  ],
};

test("a well-formed policy round-trips", () => {
  const policy = parseAutoRoles(ok);
  assert.equal(policy.enabled, true);
  assert.equal(policy.rules.length, 1);
  assert.deepEqual(policy.rules[0]?.trigger, { kind: "IN_GUILD" });
  assert.equal(policy.rules[0]?.revokeWhenUnqualified, true);
});

test("nothing stored at all is off, not broken", () => {
  assert.deepEqual(parseAutoRoles(undefined), DEFAULT_AUTO_ROLES);
  assert.deepEqual(parseAutoRoles("nonsense"), DEFAULT_AUTO_ROLES);
  assert.deepEqual(parseAutoRoles({ enabled: true }), { enabled: true, rules: [] });
});

test("one unreadable rule costs that rule, not the ones behind it", () => {
  const policy = parseAutoRoles({
    enabled: true,
    rules: [
      { key: "a", trigger: { kind: "LINKED" }, roleId: "1" },
      { key: "b", trigger: { kind: "XP_LEVEL" }, roleId: "2" }, // no atLeast
      { key: "c", trigger: { kind: "TAROT_CARD" }, roleId: "3" }, // from the future
      { key: "d", trigger: { kind: "LINKED" } }, // no role
      { key: "e", trigger: { kind: "EVENTS_ATTENDED", atLeast: 10 }, roleId: "5" },
    ],
  });
  assert.deepEqual(
    policy.rules.map((r) => r.key),
    ["a", "e"],
  );
});

test("a duplicated key collapses to the first", () => {
  // Two rules sharing a key would each be able to revoke the other's grants.
  const policy = parseAutoRoles({
    enabled: true,
    rules: [
      { key: "dup", trigger: { kind: "LINKED" }, roleId: "1" },
      { key: "dup", trigger: { kind: "IN_GUILD" }, roleId: "2" },
    ],
  });
  assert.equal(policy.rules.length, 1);
  assert.equal(policy.rules[0]?.roleId, "1");
});

test("revoking is off unless it was asked for, and enabled is on unless it was refused", () => {
  const policy = parseAutoRoles({ enabled: true, rules: [{ key: "a", trigger: { kind: "LINKED" }, roleId: "1" }] });
  assert.equal(policy.rules[0]?.revokeWhenUnqualified, false);
  assert.equal(policy.rules[0]?.enabled, true);
  const off = parseAutoRoles({ enabled: true, rules: [{ key: "a", trigger: { kind: "LINKED" }, roleId: "1", enabled: false }] });
  assert.equal(off.rules[0]?.enabled, false);
});

test("a label falls back to the key rather than being blank in the panel", () => {
  const policy = parseAutoRoles({ enabled: true, rules: [{ key: "cata-40", trigger: { kind: "LINKED" }, roleId: "1" }] });
  assert.equal(policy.rules[0]?.label, "cata-40");
});

test("rank names are normalised on read so a stored Officer matches an in-game OFFICER", () => {
  const policy = parseAutoRoles({
    enabled: true,
    rules: [{ key: "r", trigger: { kind: "GUILD_RANK", rank: "  Officer " }, roleId: "1" }],
  });
  assert.deepEqual(policy.rules[0]?.trigger, { kind: "GUILD_RANK", rank: "officer" });
});

test("the write path refuses what the read path would silently drop", () => {
  assert.equal(validateAutoRoles(ok), null);
  assert.match(String(validateAutoRoles({ enabled: true, rules: [{ key: "a", trigger: { kind: "NOPE" }, roleId: "1" }] })), /trigger must be one of/);
  assert.match(String(validateAutoRoles({ enabled: true, rules: [{ trigger: { kind: "LINKED" }, roleId: "1" }] })), /needs a key/);
  assert.match(String(validateAutoRoles({ enabled: true, rules: [{ key: "a", trigger: { kind: "LINKED" } }] })), /needs a role/);
  assert.match(
    String(validateAutoRoles({ enabled: true, rules: [{ key: "a", trigger: { kind: "XP_LEVEL", atLeast: 2.5 }, roleId: "1" }] })),
    /whole number/,
  );
  assert.match(
    String(
      validateAutoRoles({
        enabled: true,
        rules: [
          { key: "a", trigger: { kind: "LINKED" }, roleId: "1" },
          { key: "a", trigger: { kind: "IN_GUILD" }, roleId: "2" },
        ],
      }),
    ),
    /repeats the key/,
  );
  assert.match(String(validateAutoRoles({ rules: [] })), /enabled must be a boolean/);
});
