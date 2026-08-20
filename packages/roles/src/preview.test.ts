/**
 * The dry run.
 *
 * The point of these is that the preview and the real pass cannot disagree:
 * every case here is one the reconciler's own tests pin, asserted through the
 * counting layer instead of the diff.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AutoRolePolicy, AutoRoleRule, AutoRoleTrigger } from "./policy.js";
import type { RoleMemberFacts } from "./resolve.js";
import { previewRoleChanges, type PreviewMember } from "./preview.js";

function facts(over: Partial<RoleMemberFacts> = {}): RoleMemberFacts {
  return {
    discordId: "u1",
    inGuild: false,
    linked: false,
    guildRank: null,
    xpLevel: 0,
    achievementKeys: [],
    eventsAttended: 0,
    ...over,
  };
}

function rule(trigger: AutoRoleTrigger, over: Partial<AutoRoleRule> = {}): AutoRoleRule {
  return {
    key: over.key ?? "r",
    label: "Rule",
    trigger,
    roleId: over.roleId ?? "role-a",
    revokeWhenUnqualified: over.revokeWhenUnqualified ?? false,
    enabled: over.enabled ?? true,
  };
}

function policy(...rules: AutoRoleRule[]): AutoRolePolicy {
  return { enabled: true, rules };
}

function member(over: Partial<PreviewMember> & { facts: RoleMemberFacts }): PreviewMember {
  return { heldRoleIds: [], ledger: [], ...over };
}

test("counts the grants a policy would hand out", () => {
  const roster = [
    member({ facts: facts({ discordId: "a", linked: true }) }),
    member({ facts: facts({ discordId: "b", linked: true }) }),
    member({ facts: facts({ discordId: "c" }) }),
  ];

  const preview = previewRoleChanges(policy(rule({ kind: "LINKED" })), roster);
  assert.equal(preview.membersConsidered, 3);
  assert.equal(preview.membersAffected, 2);
  assert.equal(preview.grants, 2);
  assert.equal(preview.revokes, 0);
});

test("a member who already holds the role is not counted as a grant", () => {
  const roster = [member({ facts: facts({ linked: true }), heldRoleIds: ["role-a"] })];

  const preview = previewRoleChanges(policy(rule({ kind: "LINKED" })), roster);
  assert.equal(preview.grants, 0);
  assert.equal(preview.membersAffected, 0);
  assert.equal(preview.rules[0]?.qualifying, 1, "they still qualify; there is just nothing to do");
});

test("a revoke is only counted when the ledger says we granted it", () => {
  const lapsed = facts({ linked: false });
  const revoking = policy(rule({ kind: "LINKED" }, { revokeWhenUnqualified: true }));

  const ours = previewRoleChanges(revoking, [
    member({ facts: lapsed, heldRoleIds: ["role-a"], ledger: [{ ruleKey: "r", roleId: "role-a" }] }),
  ]);
  assert.equal(ours.revokes, 1);

  const theirs = previewRoleChanges(revoking, [member({ facts: lapsed, heldRoleIds: ["role-a"] })]);
  assert.equal(theirs.revokes, 0, "a role we did not grant is not ours to take");
});

test("a disabled policy previews as no change at all, never as a mass strip", () => {
  const preview = previewRoleChanges(
    { enabled: false, rules: [rule({ kind: "LINKED" }, { revokeWhenUnqualified: true })] },
    [member({ facts: facts(), heldRoleIds: ["role-a"], ledger: [{ ruleKey: "r", roleId: "role-a" }] })],
  );
  assert.equal(preview.revokes, 0);
  assert.equal(preview.grants, 0);
  assert.deepEqual(preview.rules, []);
  assert.equal(preview.membersConsidered, 1, "we still say how many we looked at");
});

test("a rule that matches nobody is still a row, reading zero", () => {
  const preview = previewRoleChanges(policy(rule({ kind: "XP_LEVEL", atLeast: 99 }, { key: "high" })), [
    member({ facts: facts({ xpLevel: 3 }) }),
  ]);
  assert.deepEqual(preview.rules, [{ key: "high", roleId: "role-a", qualifying: 0, grants: 0, revokes: 0 }]);
});

test("a disabled rule contributes nothing and does not appear", () => {
  const preview = previewRoleChanges(
    policy(rule({ kind: "LINKED" }, { key: "on" }), rule({ kind: "IN_GUILD" }, { key: "off", enabled: false, roleId: "role-b" })),
    [member({ facts: facts({ linked: true, inGuild: true }) })],
  );
  assert.deepEqual(
    preview.rules.map((r) => r.key),
    ["on"],
  );
  assert.equal(preview.grants, 1);
});

test("two rules naming one role grant it once, attributed to the rule that moved it", () => {
  const preview = previewRoleChanges(
    policy(rule({ kind: "LINKED" }, { key: "link" }), rule({ kind: "IN_GUILD" }, { key: "guild" })),
    [member({ facts: facts({ linked: true, inGuild: true }) })],
  );
  assert.equal(preview.grants, 1, "one role, one add");
  assert.equal(preview.membersAffected, 1);
  assert.equal(preview.rules.reduce((sum, r) => sum + r.grants, 0), 2, "both rules opened a ledger row for it");
  assert.deepEqual(preview.rules.map((r) => r.qualifying), [1, 1]);
});

test("a still-qualifying sibling rule keeps the role, so the preview promises no revoke", () => {
  const preview = previewRoleChanges(
    policy(
      rule({ kind: "LINKED" }, { key: "link", revokeWhenUnqualified: true }),
      rule({ kind: "IN_GUILD" }, { key: "guild" }),
    ),
    [
      member({
        facts: facts({ linked: false, inGuild: true }),
        heldRoleIds: ["role-a"],
        ledger: [{ ruleKey: "link", roleId: "role-a" }],
      }),
    ],
  );
  assert.equal(preview.revokes, 0);
  assert.equal(preview.membersAffected, 0);
});

test("a MANUAL rule never previews a revoke", () => {
  const preview = previewRoleChanges(policy(rule({ kind: "MANUAL" }, { revokeWhenUnqualified: true })), [
    member({ facts: facts(), heldRoleIds: ["role-a"], ledger: [{ ruleKey: "r", roleId: "role-a" }] }),
  ]);
  assert.equal(preview.revokes, 0);
});

test("a sampled roster says so, because a number meaning \"the first page\" is a lie", () => {
  const full = previewRoleChanges(policy(rule({ kind: "LINKED" })), []);
  assert.equal(full.sampled, false);
  assert.equal(previewRoleChanges(policy(rule({ kind: "LINKED" })), [], { sampled: true }).sampled, true);
});

test("an empty roster previews cleanly rather than dividing by nobody", () => {
  const preview = previewRoleChanges(policy(rule({ kind: "LINKED" })), []);
  assert.equal(preview.membersConsidered, 0);
  assert.equal(preview.grants, 0);
  assert.equal(preview.rules.length, 1);
});
