/**
 * The resolver and the diff.
 *
 * Most of these are written as prohibitions, because the failure mode of an
 * auto-role system is not "somebody waited an hour for a role" — it is "the bot
 * stripped a role off half the server".
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseAutoRoles, type AutoRolePolicy, type AutoRoleRule, type AutoRoleTrigger } from "./policy.js";
import { diffGrants, resolveDesiredRoles, type GrantRow, type RoleMemberFacts } from "./resolve.js";

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

/** Did this member qualify for the single rule in this policy? */
function qualifies(trigger: AutoRoleTrigger, member: RoleMemberFacts): boolean {
  return resolveDesiredRoles(member, policy(rule(trigger)))[0]?.qualifies === true;
}

test("IN_GUILD follows the roster, not the Discord server", () => {
  assert.equal(qualifies({ kind: "IN_GUILD" }, facts({ inGuild: true })), true);
  assert.equal(qualifies({ kind: "IN_GUILD" }, facts({ inGuild: false })), false);
});

test("LINKED needs a verified link", () => {
  assert.equal(qualifies({ kind: "LINKED" }, facts({ linked: true })), true);
  assert.equal(qualifies({ kind: "LINKED" }, facts()), false);
});

test("GUILD_RANK matches case and spacing insensitively, and only exactly", () => {
  const t: AutoRoleTrigger = { kind: "GUILD_RANK", rank: "officer" };
  assert.equal(qualifies(t, facts({ guildRank: "Officer" })), true);
  assert.equal(qualifies(t, facts({ guildRank: " OFFICER " })), true);
  // Not "officer or above": the platform has no trustworthy ordering of Hypixel
  // rank names, so a guild that wants a ladder writes one rule per rung.
  assert.equal(qualifies(t, facts({ guildRank: "Guild Master" })), false);
  assert.equal(qualifies(t, facts({ guildRank: null })), false);
});

test("XP_LEVEL and EVENTS_ATTENDED are inclusive thresholds", () => {
  assert.equal(qualifies({ kind: "XP_LEVEL", atLeast: 25 }, facts({ xpLevel: 25 })), true);
  assert.equal(qualifies({ kind: "XP_LEVEL", atLeast: 25 }, facts({ xpLevel: 24 })), false);
  assert.equal(qualifies({ kind: "EVENTS_ATTENDED", atLeast: 10 }, facts({ eventsAttended: 10 })), true);
  assert.equal(qualifies({ kind: "EVENTS_ATTENDED", atLeast: 10 }, facts({ eventsAttended: 9 })), false);
});

test("ACHIEVEMENT matches the definition key", () => {
  const t: AutoRoleTrigger = { kind: "ACHIEVEMENT", definitionKey: "cata:40" };
  assert.equal(qualifies(t, facts({ achievementKeys: ["cata:40", "nw:1b"] })), true);
  assert.equal(qualifies(t, facts({ achievementKeys: ["cata:30"] })), false);
});

test("MANUAL never qualifies and so can never be auto-revoked", () => {
  // Staff gave it. There is no fact about the member that could make it true,
  // which is exactly why a reconcile must never decide it has become false.
  const member = facts({ inGuild: true, linked: true, xpLevel: 99 });
  assert.equal(qualifies({ kind: "MANUAL" }, member), false);
  const outcomes = resolveDesiredRoles(member, policy(rule({ kind: "MANUAL" }, { revokeWhenUnqualified: true })));
  const diff = diffGrants(outcomes, ["role-a"], [{ ruleKey: "r", roleId: "role-a" }]);
  assert.deepEqual(diff.remove, []);
});

test("a disabled policy does nothing at all — it does not strip everything", () => {
  const outcomes = resolveDesiredRoles(facts(), { enabled: false, rules: [rule({ kind: "LINKED" }, { revokeWhenUnqualified: true })] });
  assert.deepEqual(outcomes, []);
  const diff = diffGrants(outcomes, ["role-a"], [{ ruleKey: "r", roleId: "role-a" }]);
  assert.deepEqual(diff, { add: [], remove: [], grant: [], revoke: [] });
});

test("a disabled rule is skipped without revoking what it granted", () => {
  const outcomes = resolveDesiredRoles(facts(), policy(rule({ kind: "LINKED" }, { enabled: false, revokeWhenUnqualified: true })));
  assert.deepEqual(outcomes, []);
  assert.deepEqual(diffGrants(outcomes, ["role-a"], [{ ruleKey: "r", roleId: "role-a" }]).remove, []);
});

test("qualifying without the role adds it and opens a ledger row", () => {
  const outcomes = resolveDesiredRoles(facts({ linked: true }), policy(rule({ kind: "LINKED" })));
  const diff = diffGrants(outcomes, [], []);
  assert.deepEqual(diff.add, ["role-a"]);
  assert.deepEqual(diff.grant, [{ ruleKey: "r", roleId: "role-a" }]);
  assert.deepEqual(diff.remove, []);
});

test("a role they already held is not claimed as ours", () => {
  // The whole safety property. Writing a row here would quietly authorise us to
  // take away a role somebody was given by hand.
  const outcomes = resolveDesiredRoles(facts({ linked: true }), policy(rule({ kind: "LINKED" })));
  const diff = diffGrants(outcomes, ["role-a"], []);
  assert.deepEqual(diff.add, []);
  assert.deepEqual(diff.grant, []);
});

test("a role we never granted is never removed, however unqualified they are", () => {
  const outcomes = resolveDesiredRoles(facts({ linked: false }), policy(rule({ kind: "LINKED" }, { revokeWhenUnqualified: true })));
  const diff = diffGrants(outcomes, ["role-a"], []); // held, but no ledger row
  assert.deepEqual(diff.remove, []);
  assert.deepEqual(diff.revoke, []);
});

test("losing the qualification removes it only when revoking was asked for", () => {
  const ledger: GrantRow[] = [{ ruleKey: "r", roleId: "role-a" }];
  const sticky = resolveDesiredRoles(facts(), policy(rule({ kind: "LINKED" })));
  assert.deepEqual(diffGrants(sticky, ["role-a"], ledger).remove, []);

  const revoking = resolveDesiredRoles(facts(), policy(rule({ kind: "LINKED" }, { revokeWhenUnqualified: true })));
  const diff = diffGrants(revoking, ["role-a"], ledger);
  assert.deepEqual(diff.remove, ["role-a"]);
  assert.deepEqual(diff.revoke, ledger);
});

test("another rule that still wants the role vetoes the removal", () => {
  const outcomes = resolveDesiredRoles(
    facts({ inGuild: true }),
    policy(
      rule({ kind: "LINKED" }, { key: "link", roleId: "role-a", revokeWhenUnqualified: true }),
      rule({ kind: "IN_GUILD" }, { key: "member", roleId: "role-a" }),
    ),
  );
  const diff = diffGrants(outcomes, ["role-a"], [{ ruleKey: "link", roleId: "role-a" }]);
  assert.deepEqual(diff.remove, []);
  // The claim stays open. We did grant this role and they do still hold it, so
  // if the membership rule stops qualifying later, this row is what authorises
  // taking it back then.
  assert.deepEqual(diff.revoke, []);
});

test("a grant whose role was removed by hand closes rather than being re-removed forever", () => {
  const outcomes = resolveDesiredRoles(facts(), policy(rule({ kind: "LINKED" }, { revokeWhenUnqualified: true })));
  const diff = diffGrants(outcomes, [], [{ ruleKey: "r", roleId: "role-a" }]);
  assert.deepEqual(diff.remove, []);
  assert.deepEqual(diff.revoke, [{ ruleKey: "r", roleId: "role-a" }]);
});

test("a role removed on Discord while still qualified comes back", () => {
  // Desired state, not events: this is the case an event-driven design misses.
  const outcomes = resolveDesiredRoles(facts({ linked: true }), policy(rule({ kind: "LINKED" })));
  const diff = diffGrants(outcomes, [], [{ ruleKey: "r", roleId: "role-a" }]);
  assert.deepEqual(diff.add, ["role-a"]);
  assert.deepEqual(diff.grant, []); // the row is already open
});

test("two rules granting one role add it once", () => {
  const outcomes = resolveDesiredRoles(
    facts({ linked: true, inGuild: true }),
    policy(rule({ kind: "LINKED" }, { key: "a" }), rule({ kind: "IN_GUILD" }, { key: "b" })),
  );
  const diff = diffGrants(outcomes, [], []);
  assert.deepEqual(diff.add, ["role-a"]);
  assert.equal(diff.grant.length, 2); // both rules own their claim
});

test("a rule added today applies to a member who qualified long ago", () => {
  const stored = parseAutoRoles({
    enabled: true,
    rules: [{ key: "veteran", trigger: { kind: "EVENTS_ATTENDED", atLeast: 10 }, roleId: "role-v" }],
  });
  const outcomes = resolveDesiredRoles(facts({ eventsAttended: 40 }), stored);
  assert.deepEqual(diffGrants(outcomes, [], []).add, ["role-v"]);
});
