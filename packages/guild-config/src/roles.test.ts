/**
 * Role resolution is the module that decides who may do what, so the tests are
 * written as claims about authority rather than as coverage of branches: a
 * stranger is nobody, a demotion sticks, and the capability that grants every
 * other capability cannot be handed to the bottom of the ladder.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemberRole } from "@sbr/shared-types";
import {
  DEFAULT_CAPABILITY_FLOOR,
  DEFAULT_ROLE_POLICY,
  capabilityFloor,
  commandFloor,
  meetsFloor,
  parseRoleBindings,
  parseRolePolicy,
  resolveMemberRole,
  validateRolePolicy,
  type MemberRoleFacts,
} from "./roles.js";

const NOBODY: MemberRoleFacts = {
  present: true,
  assigned: null,
  override: null,
  discordRoleIds: [],
  guildRank: null,
};

const facts = (patch: Partial<MemberRoleFacts>): MemberRoleFacts => ({ ...NOBODY, ...patch });

describe("parseRoleBindings", () => {
  it("accepts the historical one-id-per-role shape", () => {
    const bindings = parseRoleBindings({ OFFICER: "role-1" });
    assert.deepEqual(bindings.OFFICER, ["role-1"]);
    assert.deepEqual(bindings.ADMIN, []);
  });

  it("accepts several Discord roles for one level", () => {
    const bindings = parseRoleBindings({ MODERATOR: ["role-1", "role-2"] });
    assert.deepEqual(bindings.MODERATOR, ["role-1", "role-2"]);
  });

  it("drops blanks and duplicates rather than storing an id nobody can hold", () => {
    const bindings = parseRoleBindings({ ADMIN: ["role-1", "", "  ", "role-1"] });
    assert.deepEqual(bindings.ADMIN, ["role-1"]);
  });

  it("survives a garbage document", () => {
    assert.deepEqual(parseRoleBindings(null).MEMBER, []);
    assert.deepEqual(parseRoleBindings("nope").OWNER, []);
  });
});

describe("resolveMemberRole", () => {
  const bindings = parseRoleBindings({ MODERATOR: "role-mod", ADMIN: ["role-admin", "role-admin-2"] });
  const policy = parseRolePolicy({ guildRanks: { "guild master": "OWNER", staff: "OFFICER" } });

  it("is null for someone who is not in the guild", () => {
    // The security claim: a stranger is not a MEMBER with no perks, they are
    // nobody, and every capability check must fail rather than land on the
    // bottom rung.
    assert.equal(resolveMemberRole(facts({ present: false }), bindings, policy), null);
  });

  it("floors a present member at MEMBER", () => {
    assert.equal(resolveMemberRole(NOBODY, bindings, policy), MemberRole.MEMBER);
  });

  it("takes the highest of the assignment, the Discord role and the guild rank", () => {
    const role = resolveMemberRole(
      facts({ assigned: MemberRole.MEMBER, discordRoleIds: ["role-mod"], guildRank: "Staff" }),
      bindings,
      policy,
    );
    assert.equal(role, MemberRole.OFFICER, "the in-game rank was the highest of the three");
  });

  it("matches a guild rank regardless of how staff capitalised it", () => {
    assert.equal(resolveMemberRole(facts({ guildRank: "GUILD MASTER" }), bindings, policy), MemberRole.OWNER);
  });

  it("confers nothing for a guild rank with no mapping", () => {
    assert.equal(resolveMemberRole(facts({ guildRank: "Sapling" }), bindings, policy), MemberRole.MEMBER);
  });

  it("honours any one of several Discord roles bound to a level", () => {
    assert.equal(resolveMemberRole(facts({ discordRoleIds: ["role-admin-2"] }), bindings, policy), MemberRole.ADMIN);
  });

  it("lets an override demote someone who still holds a mapped Discord role", () => {
    // The reason `override` exists: without it there is no way down short of
    // editing Discord, because every other source combines by taking the max.
    const role = resolveMemberRole(
      facts({ assigned: MemberRole.ADMIN, override: MemberRole.MEMBER, discordRoleIds: ["role-admin"] }),
      bindings,
      policy,
    );
    assert.equal(role, MemberRole.MEMBER);
  });

  it("still denies an overridden non-member", () => {
    assert.equal(
      resolveMemberRole(facts({ present: false, override: MemberRole.OWNER }), bindings, policy),
      null,
      "presence is checked before anything can grant a level",
    );
  });
});

describe("capabilityFloor and commandFloor", () => {
  it("uses the platform defaults when nothing is configured", () => {
    assert.equal(capabilityFloor(DEFAULT_ROLE_POLICY, "RELAY_MESSAGE"), MemberRole.MEMBER);
    assert.equal(capabilityFloor(DEFAULT_ROLE_POLICY, "BYPASS_FILTER"), MemberRole.ADMIN);
  });

  it("lets a guild lower a floor", () => {
    const policy = parseRolePolicy({ capabilities: { MENTION: "MEMBER" } });
    assert.equal(capabilityFloor(policy, "MENTION"), MemberRole.MEMBER);
    assert.equal(capabilityFloor(policy, "BYPASS_COOLDOWN"), DEFAULT_CAPABILITY_FLOOR.BYPASS_COOLDOWN);
  });

  it("falls back to the handler's own minimum for an unconfigured command", () => {
    assert.equal(commandFloor(DEFAULT_ROLE_POLICY, "purge", MemberRole.MODERATOR), MemberRole.MODERATOR);
  });

  it("overrides a command's compiled-in minimum", () => {
    const policy = parseRolePolicy({ commands: { purge: "ADMIN" } });
    assert.equal(commandFloor(policy, "purge", MemberRole.MODERATOR), MemberRole.ADMIN);
    assert.equal(commandFloor(policy, "PURGE", MemberRole.MODERATOR), MemberRole.ADMIN, "command names are folded");
  });

  it("denies a null role at every floor", () => {
    assert.equal(meetsFloor(null, MemberRole.MEMBER), false);
    assert.equal(meetsFloor(MemberRole.MEMBER, MemberRole.MEMBER), true);
  });
});

describe("parseRolePolicy", () => {
  it("degrades to the defaults on a garbage document", () => {
    assert.deepEqual(parseRolePolicy(null), DEFAULT_ROLE_POLICY);
    assert.deepEqual(parseRolePolicy(42), DEFAULT_ROLE_POLICY);
  });

  it("keeps the fields it can read when one is malformed", () => {
    // A guild that configured its ranks and then wrote one bad capability keeps
    // its rank mapping; rejecting the document would revoke configuration the
    // operator never touched.
    const policy = parseRolePolicy({
      guildRanks: { staff: "OFFICER" },
      capabilities: { MENTION: "NOT_A_ROLE", NONSENSE: "ADMIN" },
    });
    assert.equal(policy.guildRanks["staff"], MemberRole.OFFICER);
    assert.equal(policy.capabilities.MENTION, DEFAULT_CAPABILITY_FLOOR.MENTION);
  });
});

describe("validateRolePolicy", () => {
  it("accepts a sound policy", () => {
    assert.equal(
      validateRolePolicy({ guildRanks: { staff: "OFFICER" }, capabilities: { MENTION: "MEMBER" }, commands: {} }),
      null,
    );
  });

  it("rejects a misspelled capability rather than dropping it", () => {
    // The write path is strict precisely where the read path is tolerant: a
    // typo that saved silently would read back as "not configured".
    assert.match(String(validateRolePolicy({ capabilities: { MENTIONS: "MEMBER" } })), /Unknown capability/);
  });

  it("rejects an unknown top-level field", () => {
    assert.match(String(validateRolePolicy({ capabilties: {} })), /Unknown field/);
  });

  it("refuses to hand ADMIN to a role below ADMIN", () => {
    assert.match(String(validateRolePolicy({ capabilities: { ADMIN: "MEMBER" } })), /grants every other capability/);
    assert.equal(validateRolePolicy({ capabilities: { ADMIN: "OWNER" } }), null);
  });

  it("rejects a value that is not a role", () => {
    assert.match(String(validateRolePolicy({ guildRanks: { staff: "BOSS" } })), /not a role/);
  });
});
