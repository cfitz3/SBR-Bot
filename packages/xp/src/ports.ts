/**
 * What XP needs from the outside world.
 *
 * The split is deliberate: the *counter* side is a hot path called on every
 * message, and the *ledger* side is a nightly job. They are separate ports so a
 * deployment can wire the counter sink to Redis and the ledger to Postgres
 * without either knowing about the other.
 */
import type { ActivityCounters, XpAward, XpPolicy, XpSource, XpSourcePolicy } from "./types.js";

/** One member's counters for one day, as they come back out. */
export interface ActivityRow {
  readonly discordId: string;
  readonly day: string;
  readonly counters: ActivityCounters;
}

/** A stored ledger line. */
export interface LedgerRow {
  readonly discordId: string;
  readonly source: XpSource;
  readonly amount: number;
  readonly rawValue: number;
  readonly day: string;
  readonly createdAt: Date;
}

/** A stored balance. */
export interface BalanceRow {
  readonly discordId: string;
  readonly totalXp: number;
  readonly level: number;
  readonly bySource: Readonly<Partial<Record<XpSource, number>>>;
  readonly tenureDays: number;
  readonly lastAwardAt: Date | null;
}

/**
 * The counter sink. Increments are fire-and-forget from the caller's point of
 * view: a member's message must not fail because the XP counter did.
 */
export interface ActivitySink {
  bump(guildId: string, discordId: string, day: string, field: keyof ActivityCounters, by: number): Promise<void>;
}

export interface XpRepository {
  /** Every configured source for a guild. Sources absent here are disabled. */
  policy(guildId: string): Promise<readonly XpSourcePolicy[]>;
  /** Panel write. Creates the row if the guild had none for that source. */
  setSourcePolicy(guildId: string, policy: XpSourcePolicy): Promise<XpSourcePolicy>;

  /** Everyone with activity on a day. The job's input. */
  activityForDay(guildId: string, day: string): Promise<readonly ActivityRow[]>;
  /**
   * Guild experience per *linked* member for a day. Unlinked IGNs earn nothing:
   * XP is attributed to a platform member, and a chat line cannot name one.
   */
  gexpForDay(guildId: string, day: string): Promise<readonly { readonly discordId: string; readonly gexp: number }[]>;
  /** Days on the platform per member, as of `day`. */
  tenureForDay(guildId: string, day: string): Promise<readonly { readonly discordId: string; readonly days: number }[]>;
  /** Events attended per member on a day. */
  eventsForDay(guildId: string, day: string): Promise<readonly { readonly discordId: string; readonly count: number }[]>;

  /**
   * Write awards. Entries carrying a `dedupeKey` upsert on it — replaying a day
   * overwrites, never adds. Entries without one are appended.
   */
  recordAwards(guildId: string, awards: readonly XpAward[]): Promise<void>;

  /** The whole ledger for a guild, for a balance rebuild. */
  ledger(guildId: string): Promise<readonly LedgerRow[]>;
  /** Replace the stored balances wholesale. */
  saveBalances(guildId: string, balances: readonly BalanceRow[]): Promise<void>;

  balance(guildId: string, discordId: string): Promise<BalanceRow | null>;
  /** 1-based position by total XP. Null when the member has no balance. */
  rank(guildId: string, discordId: string): Promise<number | null>;
  top(guildId: string, limit: number): Promise<readonly BalanceRow[]>;
}

/** Convenience view over `XpRepository.policy`, keyed for `policyFor`. */
export function toPolicyMap(rows: readonly XpSourcePolicy[]): XpPolicy {
  const map: Partial<Record<XpSource, XpSourcePolicy>> = {};
  for (const row of rows) map[row.source] = row;
  return map;
}
