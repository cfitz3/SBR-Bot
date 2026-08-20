/**
 * Who should hold what, and what to do about the difference.
 *
 * Pure: no Discord, no Prisma, no clock. The reconciler loads a bundle of facts
 * per member, asks this module what the answer is, and hands the difference to
 * the effector. Keeping it pure is what makes the interesting cases — a rule
 * added today, a member who left, a role somebody removed by hand — testable
 * without a Discord server.
 *
 * The governing rule of the whole feature lives here: **we only ever remove
 * what we granted.** A role somebody was given by hand, by another bot, or by a
 * rule that has since been deleted is not ours to take away, and the ledger is
 * how we know the difference.
 */
import { normalizeRank, type AutoRolePolicy, type AutoRoleRule } from "./policy.js";

/**
 * Everything the rules can ask about one member, loaded once.
 *
 * One bundle per member rather than one query per rule: a guild with thirty
 * rules and four hundred members would otherwise be twelve thousand queries a
 * pass.
 */
export interface RoleMemberFacts {
  readonly discordId: string;
  /** An active `GuildMember` row — in the Hypixel guild, not the Discord one. */
  readonly inGuild: boolean;
  /** A verified `LinkedAccount` exists. */
  readonly linked: boolean;
  /** Their in-game guild rank, when we have a roster entry for them. */
  readonly guildRank: string | null;
  /** `levelForXp(balance)`, computed by the caller — this package owns no maths. */
  readonly xpLevel: number;
  /** Definition keys of achievements they have earned. */
  readonly achievementKeys: readonly string[];
  readonly eventsAttended: number;
}

export interface RuleOutcome {
  readonly rule: AutoRoleRule;
  readonly qualifies: boolean;
}

/**
 * One row of the grant ledger: a role we handed out, and the rule that said so.
 *
 * `ruleKey` rather than "granted automatically" as a flag, because a role can be
 * granted by two rules and only the rule that granted it may take it back.
 */
export interface GrantRow {
  readonly ruleKey: string;
  readonly roleId: string;
}

export interface RoleDiff {
  /** Role ids to add on Discord. */
  readonly add: readonly string[];
  /** Role ids to remove on Discord. */
  readonly remove: readonly string[];
  /** Ledger rows to open, once the add has actually landed. */
  readonly grant: readonly GrantRow[];
  /** Ledger rows to close, once the remove has actually landed. */
  readonly revoke: readonly GrantRow[];
}

const EMPTY_DIFF: RoleDiff = Object.freeze({ add: [], remove: [], grant: [], revoke: [] });

/**
 * Whether one member satisfies one trigger.
 *
 * `MANUAL` is always false and that is not an oversight: a manual grant is
 * staff saying "give this person this role", which the ledger records directly.
 * There is no fact about the member that could make it true, so a reconcile
 * must never conclude that it has become false either.
 */
function qualifies(rule: AutoRoleRule, facts: RoleMemberFacts): boolean {
  const t = rule.trigger;
  switch (t.kind) {
    case "IN_GUILD":
      return facts.inGuild;
    case "LINKED":
      return facts.linked;
    case "GUILD_RANK":
      // Exact match on the normalised name, not "this rank or above". Hypixel
      // guild ranks are free text with no ordering the platform can trust, and
      // inventing one would eventually grant an officer role to whoever renamed
      // their bottom rung. A guild that wants "Officer and up" writes one rule
      // per rank, which is explicit and reads correctly in the panel.
      return facts.guildRank !== null && normalizeRank(facts.guildRank) === t.rank;
    case "XP_LEVEL":
      return facts.xpLevel >= t.atLeast;
    case "ACHIEVEMENT":
      return facts.achievementKeys.includes(t.definitionKey);
    case "EVENTS_ATTENDED":
      return facts.eventsAttended >= t.atLeast;
    case "MANUAL":
      return false;
  }
}

/**
 * Every enabled rule, with whether this member satisfies it.
 *
 * A disabled policy resolves to nothing at all — not "nobody qualifies". The
 * difference matters: turning the feature off should stop it acting, not strip
 * every role it ever granted from every member at once.
 */
export function resolveDesiredRoles(facts: RoleMemberFacts, policy: AutoRolePolicy): readonly RuleOutcome[] {
  if (!policy.enabled) return [];
  return policy.rules
    .filter((rule) => rule.enabled)
    .map((rule) => ({ rule, qualifies: qualifies(rule, facts) }));
}

/**
 * The difference between what should be and what is.
 *
 * Three deliberate asymmetries:
 *
 * 1. **A role already held is not recorded as granted.** If somebody had the
 *    role before a rule ever ran, we did not give it to them, and writing a
 *    ledger row would quietly authorise us to take it away later.
 * 2. **A revoke needs both a ledger row and `revokeWhenUnqualified`.** Missing
 *    either, the role stays. Losing a role is the surprising direction and it
 *    should require somebody to have asked for it twice.
 * 3. **Another qualifying rule vetoes the removal.** Two rules can point at one
 *    role; the member keeps it while any of them still says yes.
 *
 * The ledger passed in must be the *open* rows only — revoked grants are
 * history, and history does not authorise anything.
 */
export function diffGrants(
  outcomes: readonly RuleOutcome[],
  held: readonly string[],
  ledger: readonly GrantRow[],
): RoleDiff {
  if (outcomes.length === 0) return EMPTY_DIFF;

  const holds = new Set(held);
  const desired = new Set<string>();
  for (const o of outcomes) if (o.qualifies) desired.add(o.rule.roleId);

  const add: string[] = [];
  const grant: GrantRow[] = [];
  const remove: string[] = [];
  const revoke: GrantRow[] = [];

  for (const { rule, qualifies: ok } of outcomes) {
    const row: GrantRow = { ruleKey: rule.key, roleId: rule.roleId };
    const open = ledger.some((g) => g.ruleKey === rule.key && g.roleId === rule.roleId);

    if (ok) {
      if (holds.has(rule.roleId)) {
        // They already have it. Nothing to do on Discord, and nothing to
        // record: see asymmetry 1. If we granted it earlier the row is already
        // open, and if we did not, it is not ours.
        continue;
      }
      if (!add.includes(rule.roleId)) add.push(rule.roleId);
      if (!open) grant.push(row);
      continue;
    }

    // A MANUAL rule never qualifies, so without this every reconcile would
    // treat a staff grant as a lapsed one and take it straight back.
    if (rule.trigger.kind === "MANUAL") continue;
    if (!open || !rule.revokeWhenUnqualified) continue;
    // Somebody else's rule still wants this role on them. The row stays open
    // as well as the role: we did grant it and they do still hold it, and if
    // the other rule stops qualifying later this is what authorises the
    // removal then.
    if (desired.has(rule.roleId)) continue;
    if (holds.has(rule.roleId) && !remove.includes(rule.roleId)) remove.push(rule.roleId);
    // The row closes either way. If the role was already gone — removed by
    // hand — the grant is over just the same, and leaving the row open would
    // have us re-remove a role we no longer hold on every future pass.
    revoke.push(row);
  }

  return { add, remove, grant, revoke };
}
