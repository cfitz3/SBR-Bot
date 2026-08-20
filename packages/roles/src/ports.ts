/**
 * What the resolver needs from the outside world.
 *
 * Declared here and implemented in `@sbr/db`, so this package stays testable
 * with plain objects and the reconciler in `apps/workers` depends on an
 * interface rather than on Prisma.
 */
import type { GrantRow } from "./resolve.js";

/** One grant, as it is written down. */
export interface GrantRecord extends GrantRow {
  readonly discordId: string;
  readonly grantedAt: string;
}

export interface RoleGrantRepository {
  /**
   * The **open** grants for one member. Revoked rows are history and history
   * authorises nothing, so they are never returned here.
   */
  openGrants(guildId: string, discordId: string): Promise<readonly GrantRow[]>;
  /**
   * Record roles we actually granted. Called *after* Discord accepted the
   * write, never before: a row for a grant that did not happen would authorise
   * a future revoke of a role we never gave.
   */
  recordGrants(guildId: string, discordId: string, rows: readonly GrantRow[], reason: string): Promise<void>;
  /** Close grants, having actually removed the roles (or found them gone). */
  closeGrants(guildId: string, discordId: string, rows: readonly GrantRow[]): Promise<void>;
  /** Every open grant made by one rule — the panel's "who has this" read. */
  openGrantsForRule(guildId: string, ruleKey: string): Promise<readonly GrantRecord[]>;
}
