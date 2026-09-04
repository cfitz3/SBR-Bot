/**
 * `role-sync`: make Discord's roles match what the guild's rules say they
 * should be.
 *
 * Reconciliation, not event handling. Nothing here reacts to "somebody linked
 * their account" — it asks, for one member, what should be true, compares that
 * to what is true, and fixes the difference. That costs a little more than
 * listening for events and buys the three things events cannot: a gateway event
 * dropped during a deploy heals on the next pass, a rule added today applies to
 * members who qualified months ago, and a role removed by hand comes back
 * without anybody having to notice.
 *
 * Promptness is the dirty set's job, not correctness'. Somewhere that knows a
 * member changed adds them to `roles:dirty:<guildId>`; this pass drains it. If
 * that mark is lost — a Redis flush, a crash between the write and the mark —
 * the daily full sweep picks them up. Losing the set costs latency, never
 * accuracy, which is exactly why it is a set in Redis rather than a table.
 */
import { diffGrants, resolveDesiredRoles, type AutoRolePolicy, type GrantRow, type RoleMemberFacts } from "@sbr/roles";

import { forEachLimit } from "./concurrency.js";

/** One member as the pass needs them: the facts, and what they hold today. */
export interface RoleMemberSnapshot {
  readonly facts: RoleMemberFacts;
  /**
   * Discord roles they currently hold, from the mirrored roster.
   *
   * Allowed to be stale. The effector re-checks against the live gateway and
   * reports what it actually changed, and only what it actually changed is
   * written to the ledger — so a two-hour-old mirror costs at worst a no-op
   * call, never a wrong claim.
   */
  readonly heldRoleIds: readonly string[];
}

/** What the effector did, which is not always what it was asked to do. */
export interface RoleApplyOutcome {
  readonly ok: boolean;
  /** False when they are not in the Discord server at all. */
  readonly memberPresent: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** Roles the effector refused, with a reason fit for the Health card. */
  readonly refused: readonly { readonly roleId: string; readonly detail: string }[];
}

/**
 * Everything reconciling *one* member needs.
 *
 * Split out of `RoleSyncDeps` so the immediate path can reuse this pass rather
 * than reimplement it. The sweep's own dependencies — listing guilds, claiming
 * the daily sweep, draining the dirty set — are about deciding *who* to
 * reconcile, and a caller that already knows who has no business supplying them.
 */
export interface MemberSyncDeps {
  loadPolicy(guildId: string): Promise<AutoRolePolicy>;
  markDirty(guildId: string, discordIds: readonly string[]): Promise<void>;
  loadSnapshots(guildId: string, discordIds: readonly string[]): Promise<readonly RoleMemberSnapshot[]>;
  openGrants(guildId: string, discordId: string): Promise<readonly GrantRow[]>;
  apply(guildId: string, discordId: string, add: readonly string[], remove: readonly string[]): Promise<RoleApplyOutcome>;
  recordGrants(guildId: string, discordId: string, rows: readonly GrantRow[], reason: string): Promise<void>;
  closeGrants(guildId: string, discordId: string, rows: readonly GrantRow[]): Promise<void>;
  onRefusal(guildId: string, roleId: string, detail: string): void;
  onError(scope: string, error: unknown): void;
}

export interface RoleSyncDeps extends MemberSyncDeps {
  listGuilds(): Promise<readonly string[]>;
  /**
   * Whether this guild is due a full sweep, and claiming it if so. Returns true
   * at most once a day per guild; the claim is what stops two workers both
   * marking a thousand members dirty.
   */
  claimFullSweep(guildId: string): Promise<boolean>;
  /** Every member we might have to act on — only read during a full sweep. */
  listMemberIds(guildId: string): Promise<readonly string[]>;
  /** Take up to `limit` ids *out* of the dirty set. */
  drainDirty(guildId: string, limit: number): Promise<readonly string[]>;
  /** Guilds reconciled at once. Defaults to `GUILD_CONCURRENCY`. */
  guildConcurrency?: number;
}

/**
 * How many members one pass will act on per guild.
 *
 * A ceiling on Discord writes and on how long one guild can hold the bulk lane,
 * not a limit on how many can ever be fixed: whatever is left stays in the dirty
 * set and the next pass takes the next batch.
 */
export const MAX_MEMBERS_PER_PASS = 200;

/**
 * How many guilds one pass reconciles at the same time.
 *
 * Role rate limits are per guild, so two guilds are two independent budgets and
 * doing them one after the other buys nothing at all — it only means the last
 * guild in the list waits for every guild before it. Members *within* a guild
 * stay strictly serial, which is where the budget actually is.
 *
 * Four rather than unbounded because the shared costs are real even when the
 * Discord ones are not: each guild's pass opens database reads and a loopback
 * call to the admin bot, and this runs in the bulk lane alongside three other
 * jobs.
 */
export const GUILD_CONCURRENCY = 4;

/** Every write is attributed, so an audit log entry says which rule did it. */
const REASON = "Automatic role rule";

/** Runs one pass; returns how many members actually had a role change. */
export async function syncRoles(deps: RoleSyncDeps): Promise<number> {
  let guilds: readonly string[];
  try {
    guilds = await deps.listGuilds();
  } catch (error) {
    deps.onError("guild list", error);
    return 0;
  }

  let changed = 0;
  await forEachLimit(guilds, deps.guildConcurrency ?? GUILD_CONCURRENCY, async (guildId) => {
    try {
      changed += await syncGuild(deps, guildId);
    } catch (error) {
      // One guild's misconfiguration is not the rest of the platform's problem.
      deps.onError(`guild ${guildId}`, error);
    }
  });
  return changed;
}

async function syncGuild(deps: RoleSyncDeps, guildId: string): Promise<number> {
  const policy = await deps.loadPolicy(guildId);
  // Off means off: no reads, no writes, and emphatically no revocations. A
  // guild that switches the feature off has not asked us to undo it.
  if (!policy.enabled || policy.rules.length === 0) return 0;

  if (await deps.claimFullSweep(guildId)) {
    // A full sweep is just "everybody is dirty". Reusing the drain means the
    // batch ceiling, the ordering and the retry behaviour are the same code on
    // both paths, rather than a second traversal that ages differently.
    const everyone = await deps.listMemberIds(guildId);
    if (everyone.length > 0) await deps.markDirty(guildId, everyone);
  }

  const ids = await deps.drainDirty(guildId, MAX_MEMBERS_PER_PASS);
  if (ids.length === 0) return 0;

  const snapshots = await deps.loadSnapshots(guildId, ids);
  let changed = 0;
  for (const snapshot of snapshots) {
    try {
      if (await syncMember(deps, guildId, policy, snapshot)) changed += 1;
    } catch (error) {
      deps.onError(`member ${snapshot.facts.discordId}`, error);
      // Put them back: the mark was consumed by the drain, and dropping it here
      // would leave this member unreconciled until the daily sweep.
      await deps.markDirty(guildId, [snapshot.facts.discordId]).catch(() => undefined);
    }
  }
  return changed;
}

async function syncMember(
  deps: MemberSyncDeps,
  guildId: string,
  policy: AutoRolePolicy,
  snapshot: RoleMemberSnapshot,
): Promise<boolean> {
  const discordId = snapshot.facts.discordId;
  const ledger = await deps.openGrants(guildId, discordId);
  const outcomes = resolveDesiredRoles(snapshot.facts, policy);
  const diff = diffGrants(outcomes, snapshot.heldRoleIds, ledger);
  if (diff.add.length === 0 && diff.remove.length === 0) {
    // Nothing to do on Discord. There may still be ledger rows to close — a
    // grant whose role somebody removed by hand — and closing them is what stops
    // the pass rediscovering the same non-work forever.
    if (diff.revoke.length > 0) await deps.closeGrants(guildId, discordId, diff.revoke);
    return false;
  }

  const result = await deps.apply(guildId, discordId, diff.add, diff.remove);
  for (const refusal of result.refused) deps.onRefusal(guildId, refusal.roleId, refusal.detail);

  if (!result.memberPresent) {
    // They left the Discord server. Their grants are over — the roles went with
    // the membership — and leaving the rows open would have us try to remove
    // roles from somebody who is not there on every future pass.
    if (ledger.length > 0) await deps.closeGrants(guildId, discordId, ledger);
    return false;
  }

  // Record only what Discord actually accepted. Asking for three roles and
  // getting two is normal — one may have been deleted, or moved above the bot
  // since the rule was written — and claiming the third would authorise us to
  // "revoke" a role we never granted.
  const landed = diff.grant.filter((row) => result.added.includes(row.roleId));
  if (landed.length > 0) await deps.recordGrants(guildId, discordId, landed, REASON);

  const closed = diff.revoke.filter(
    (row) => result.removed.includes(row.roleId) || !snapshot.heldRoleIds.includes(row.roleId),
  );
  if (closed.length > 0) await deps.closeGrants(guildId, discordId, closed);

  if (!result.ok) {
    // The call failed after the preflight — a permission changed underneath us,
    // or Discord was unhappy. Nothing was claimed above; put them back so the
    // next pass tries again rather than waiting a day.
    await deps.markDirty(guildId, [discordId]).catch(() => undefined);
    return false;
  }
  return result.added.length > 0 || result.removed.length > 0;
}

/**
 * Reconcile one member, now.
 *
 * The other half of the model the file header describes. Reconciliation is
 * still what happens — this asks the same question about the same member and
 * applies the same diff through the same effector — the only difference is who
 * asked and when. Somebody who has just linked their account should not wait a
 * quarter of an hour to be told the platform noticed.
 *
 * Deliberately does **not** touch the dirty set. The caller marks the member
 * dirty as usual and then nudges; if this pass fails, or never runs because the
 * worker was restarting, the mark is still sitting there for the sweep to find.
 * A path that consumed the mark to go faster would be trading the one property
 * that makes the whole arrangement safe for fifteen minutes of latency.
 *
 * Running twice is harmless and is the expected case: the sweep will reach this
 * member again within the quarter hour, ask the same question, find the ledger
 * and Discord already agree, and make no call at all.
 */
export async function syncOneMember(
  deps: MemberSyncDeps,
  guildId: string,
  discordId: string,
): Promise<boolean> {
  try {
    const policy = await deps.loadPolicy(guildId);
    // Same refusal as the sweep's, for the same reason: a guild with the
    // feature off has not asked us to act on it promptly either.
    if (!policy.enabled || policy.rules.length === 0) return false;

    const snapshots = await deps.loadSnapshots(guildId, [discordId]);
    const snapshot = snapshots.at(0);
    // Not a member of this guild as far as the mirror is concerned. Nothing to
    // reconcile against, and inventing facts for them would be worse than
    // waiting for the roster to catch up.
    if (snapshot === undefined) return false;

    return await syncMember(deps, guildId, policy, snapshot);
  } catch (error) {
    // Never rethrown. The caller is on somebody's request path — a link, a
    // join, a punishment — and a role that could not be applied is not a
    // failure of the thing they actually asked for. The mark they left behind
    // is what gets this retried, so retrying here would only be a second
    // failure sooner.
    deps.onError(`member ${discordId}`, error);
    return false;
  }
}
