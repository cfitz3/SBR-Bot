/**
 * The vocabulary of XP and standing.
 *
 * Three conventions run through everything here.
 *
 * **XP is derived, never handed out inline.** A message increments a counter;
 * the counter is weighted into XP later. That split is what makes a daily cap
 * enforceable and a weight change re-derivable — an award already given out
 * cannot be un-given, but a counter can be re-read.
 *
 * **Every award is explainable.** An entry carries the raw quantity it came from
 * as well as the XP it produced, so `/standing` can say "2,400 GEXP × 0.05" and
 * a member can argue with the number rather than just distrust it.
 *
 * **A source with no configuration is off.** People will try to farm this. The
 * safe direction for an unconfigured guild is zero, not "whatever the defaults
 * happen to be", so `policyFor` returns a disabled source rather than a guess.
 */

// The vocabulary the bots and the panel also speak lives in `@sbr/shared-types`
// so no surface has to depend on this package to render a standing. What stays
// here is what only the engine needs: counters, awards, and the policy shape it
// evaluates.
import type { XpSource, XpSourcePolicyDTO, XpStandingDTO } from "@sbr/shared-types";

export type { XpSource };

/** A member's standing. Alias rather than a second declaration — one shape. */
export type Standing = XpStandingDTO;

/** Every source, in the order `/standing` lists them. */
export const XP_SOURCES: readonly XpSource[] = [
  "GEXP",
  "DISCORD_MESSAGE",
  "GUILD_CHAT_MESSAGE",
  "TENURE",
  "COMMAND_USAGE",
  "EVENT",
  "MILESTONE",
  "MANUAL",
];

/** Per-source weight and anti-abuse limits. One row per source per guild. */
export type XpSourcePolicy = XpSourcePolicyDTO;

/** A guild's whole XP policy, source → rule. Missing entries are disabled. */
export type XpPolicy = Readonly<Partial<Record<XpSource, XpSourcePolicy>>>;

/**
 * The rule applied when a guild has configured nothing for a source: off, and
 * weightless. Returned rather than thrown so callers stay branch-free.
 */
export function disabledPolicy(source: XpSource): XpSourcePolicy {
  return { source, enabled: false, weight: 0, dailyCap: null, cooldownSec: 0, minLength: 0 };
}

export function policyFor(policy: XpPolicy, source: XpSource): XpSourcePolicy {
  return policy[source] ?? disabledPolicy(source);
}

/**
 * Suggested starting policy for a guild turning XP on. Deliberately *not* the
 * fallback — a guild has to opt in per source, and these are what the panel
 * offers to write, not what silently applies.
 *
 * The shape of the numbers is the point: chat is capped low enough that a whole
 * day of talking is worth less than a day of guild activity, because the one
 * thing that reliably ruins an XP system is making spam the best strategy.
 */
export const SUGGESTED_POLICY: readonly XpSourcePolicy[] = [
  { source: "GEXP", enabled: true, weight: 0.05, dailyCap: null, cooldownSec: 0, minLength: 0 },
  { source: "DISCORD_MESSAGE", enabled: true, weight: 1, dailyCap: 60, cooldownSec: 30, minLength: 4 },
  { source: "GUILD_CHAT_MESSAGE", enabled: true, weight: 1, dailyCap: 40, cooldownSec: 30, minLength: 4 },
  { source: "TENURE", enabled: true, weight: 10, dailyCap: 10, cooldownSec: 0, minLength: 0 },
  { source: "COMMAND_USAGE", enabled: true, weight: 1, dailyCap: 10, cooldownSec: 60, minLength: 0 },
  { source: "EVENT", enabled: true, weight: 50, dailyCap: 150, cooldownSec: 0, minLength: 0 },
  { source: "MANUAL", enabled: true, weight: 1, dailyCap: null, cooldownSec: 0, minLength: 0 },
];

/** Raw per-day counters for one member. What XP is computed from. */
export interface ActivityCounters {
  readonly discordMessages: number;
  readonly guildChatMessages: number;
  readonly commandsUsed: number;
  /** `/g online` hits: presence is sampled, never measured. */
  readonly presenceSamples: number;
}

export const NO_ACTIVITY: ActivityCounters = {
  discordMessages: 0,
  guildChatMessages: 0,
  commandsUsed: 0,
  presenceSamples: 0,
};

/** One line of the ledger, before it is stored. */
export interface XpAward {
  readonly discordId: string;
  readonly source: XpSource;
  /** Signed: a MANUAL adjustment may take XP away. */
  readonly amount: number;
  readonly rawValue: number;
  /** ISO date, `YYYY-MM-DD`. The grain everything aggregates on. */
  readonly day: string;
  /**
   * Idempotency key. Present for anything a job might replay, null for a
   * genuinely one-off award. A repeated key overwrites rather than adds, so a
   * day still in progress converges instead of double-crediting.
   */
  readonly dedupeKey: string | null;
  readonly meta?: Readonly<Record<string, unknown>>;
}

