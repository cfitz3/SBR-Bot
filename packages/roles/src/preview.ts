/**
 * The dry run: what a policy *would* do, without doing any of it.
 *
 * The whole value of this is that it is not an estimate. It calls the same
 * `resolveDesiredRoles` + `diffGrants` the reconciler calls, over the same
 * ledger rows, so "this would grant 214 and revoke 3" is the reconciler's own
 * answer rather than a second implementation that agrees with it on the cases
 * somebody thought to test. The resolver being pure is what makes that free.
 *
 * Two honest caveats, both surfaced rather than hidden:
 *
 * - The counts are what the *rules* say. The effector can still refuse a role
 *   that sits above the bot, so the real pass may land fewer. `refusable` is
 *   not modelled here because this package cannot see Discord's role order.
 * - `sampled` says whether the caller gave us every member or a page of them.
 *   A number that silently means "the first two hundred" is worse than no
 *   number, so the panel is told which it has.
 */
import type { AutoRolePolicy, AutoRoleRule } from "./policy.js";
import { diffGrants, resolveDesiredRoles, type GrantRow, type RoleMemberFacts } from "./resolve.js";

/** One member, with everything the diff needs to be exact about them. */
export interface PreviewMember {
  readonly facts: RoleMemberFacts;
  readonly heldRoleIds: readonly string[];
  /** Their **open** grant rows. Closed ones authorise nothing; see `diffGrants`. */
  readonly ledger: readonly GrantRow[];
}

/** What one rule would do, so the panel can point at the rule that does it. */
export interface RulePreview {
  readonly key: string;
  readonly roleId: string;
  /** Members who satisfy the rule right now, whether or not they hold the role. */
  readonly qualifying: number;
  readonly grants: number;
  readonly revokes: number;
}

export interface RolePreview {
  readonly membersConsidered: number;
  /** Members with at least one add or remove. */
  readonly membersAffected: number;
  /** Total role additions across every member — not distinct roles. */
  readonly grants: number;
  readonly revokes: number;
  readonly rules: readonly RulePreview[];
  /** True when the caller passed a page rather than the whole roster. */
  readonly sampled: boolean;
}

const EMPTY: RolePreview = Object.freeze({
  membersConsidered: 0,
  membersAffected: 0,
  grants: 0,
  revokes: 0,
  rules: [],
  sampled: false,
});

interface Tally {
  readonly rule: AutoRoleRule;
  qualifying: number;
  grants: number;
  revokes: number;
}

/**
 * Run the resolver over a roster and total up the difference.
 *
 * A disabled policy previews as nothing at all, matching `syncRoles`: the
 * answer to "what would happen if I saved this?" for a switched-off feature is
 * "nothing", not "every granted role would be stripped".
 */
export function previewRoleChanges(
  policy: AutoRolePolicy,
  members: readonly PreviewMember[],
  options: { readonly sampled?: boolean } = {},
): RolePreview {
  const sampled = options.sampled === true;
  if (!policy.enabled || policy.rules.length === 0) {
    return { ...EMPTY, membersConsidered: members.length, sampled };
  }

  // Seeded from the policy, not from what the members happened to trigger, so a
  // rule matching nobody still shows up in the panel as a row reading zero.
  // "My new rule is missing" and "my new rule matches nobody" are different
  // problems and staff must be able to tell them apart.
  const tallies = new Map<string, Tally>();
  for (const rule of policy.rules) {
    if (rule.enabled) tallies.set(rule.key, { rule, qualifying: 0, grants: 0, revokes: 0 });
  }

  let membersAffected = 0;
  let grants = 0;
  let revokes = 0;

  for (const member of members) {
    const outcomes = resolveDesiredRoles(member.facts, policy);
    for (const outcome of outcomes) {
      if (outcome.qualifies) {
        const tally = tallies.get(outcome.rule.key);
        if (tally) tally.qualifying += 1;
      }
    }

    const diff = diffGrants(outcomes, member.heldRoleIds, member.ledger);
    if (diff.add.length > 0 || diff.remove.length > 0) membersAffected += 1;
    grants += diff.add.length;
    revokes += diff.remove.length;

    // Attributed by ledger row rather than by role id: two rules can name the
    // same role, and the row is the only thing that says which one moved it.
    for (const row of diff.grant) {
      const tally = tallies.get(row.ruleKey);
      if (tally && diff.add.includes(row.roleId)) tally.grants += 1;
    }
    for (const row of diff.revoke) {
      const tally = tallies.get(row.ruleKey);
      if (tally && diff.remove.includes(row.roleId)) tally.revokes += 1;
    }
  }

  return {
    membersConsidered: members.length,
    membersAffected,
    grants,
    revokes,
    rules: [...tallies.values()].map((t) => ({
      key: t.rule.key,
      roleId: t.rule.roleId,
      qualifying: t.qualifying,
      grants: t.grants,
      revokes: t.revokes,
    })),
    sampled,
  };
}
