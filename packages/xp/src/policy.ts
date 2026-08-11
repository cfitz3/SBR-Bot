/**
 * Turning raw activity into XP.
 *
 * Everything here is pure and total: given the same counters and the same
 * policy, it produces the same awards, which is what lets the aggregation job
 * re-run over a day that is still in progress. The job stores the *result* of
 * the day, not the delta since last time, so a replay converges rather than
 * accumulating.
 *
 * Anti-abuse is split across two moments on purpose:
 *
 *  - `countsAsMessage` runs on the hot path, where the message text exists.
 *    Length and cooldown can only be judged there.
 *  - `awardsFor` runs in the job, where the whole day is visible. Daily caps can
 *    only be judged there — capping at capture time would require reading the
 *    running total on every message.
 */
import type { ActivityCounters, XpAward, XpPolicy, XpSource, XpSourcePolicy } from "./types.js";
import { policyFor } from "./types.js";

/** The counter a message-shaped source increments. */
const MESSAGE_SOURCES = {
  DISCORD_MESSAGE: "discordMessages",
  GUILD_CHAT_MESSAGE: "guildChatMessages",
  COMMAND_USAGE: "commandsUsed",
} as const satisfies Partial<Record<XpSource, keyof ActivityCounters>>;

/**
 * Whether a message counts at all, before any weighting.
 *
 * Length is measured on the *trimmed* text so trailing whitespace cannot pad a
 * message over the bar. The cooldown is not judged here — the caller holds the
 * clock — but `cooldownSec` is returned so the caller can key a gate off one
 * source of truth rather than reading the config twice.
 */
export function countsAsMessage(
  text: string,
  policy: XpSourcePolicy,
): { readonly counts: boolean; readonly cooldownSec: number } {
  const trimmed = text.trim();
  const counts = policy.enabled && trimmed.length >= policy.minLength && trimmed.length > 0;
  return { counts, cooldownSec: policy.cooldownSec };
}

/**
 * Apply a weight and a cap.
 *
 * Rounds *down*: a fractional weight should never let one unit of raw value
 * round up into more XP than a whole one is worth. A negative cap is treated as
 * zero rather than as an inverted range.
 */
export function weighted(rawValue: number, policy: XpSourcePolicy): number {
  if (!policy.enabled || rawValue <= 0) return 0;
  const xp = Math.floor(rawValue * policy.weight);
  if (policy.dailyCap === null) return Math.max(0, xp);
  return Math.max(0, Math.min(xp, Math.max(0, policy.dailyCap)));
}

/** What one member earned on one day, from counters alone. */
export interface DayInput {
  readonly discordId: string;
  readonly day: string;
  readonly counters: ActivityCounters;
  /** Hypixel guild experience earned that day, when the member is linked. */
  readonly gexp?: number;
  /** Days on the platform as of `day`. Awards one day's worth, not a lump. */
  readonly tenureDays?: number;
  /** Events attended that day. */
  readonly events?: number;
}

/**
 * The full set of awards for one member-day.
 *
 * Zero-XP sources are omitted rather than written as `amount: 0`: a ledger full
 * of empty rows makes the interesting ones harder to find, and an absent row and
 * a zero row mean the same thing to every reader.
 */
export function awardsFor(input: DayInput, policy: XpPolicy): readonly XpAward[] {
  const awards: XpAward[] = [];

  for (const [source, counter] of Object.entries(MESSAGE_SOURCES) as [XpSource, keyof ActivityCounters][]) {
    push(awards, input, policy, source, input.counters[counter]);
  }
  push(awards, input, policy, "GEXP", input.gexp ?? 0);
  push(awards, input, policy, "EVENT", input.events ?? 0);
  // Tenure accrues one day at a time. The stored `tenureDays` is the running
  // total and belongs on the balance; awarding it whole every night would pay a
  // year-old member 365 days of tenure every single night.
  push(awards, input, policy, "TENURE", (input.tenureDays ?? 0) > 0 ? 1 : 0);

  return awards;
}

function push(
  into: XpAward[],
  input: DayInput,
  policy: XpPolicy,
  source: XpSource,
  rawValue: number,
): void {
  const rule = policyFor(policy, source);
  const amount = weighted(rawValue, rule);
  if (amount <= 0) return;
  into.push({
    discordId: input.discordId,
    source,
    amount,
    rawValue,
    day: input.day,
    dedupeKey: dedupeKey(source, input.discordId, input.day),
  });
}

/**
 * The idempotency key for a derived award: one per (source, member, day). The
 * repository upserts on it, so re-running the job for today overwrites this
 * morning's partial figure with the current one.
 */
export function dedupeKey(source: XpSource, discordId: string, day: string): string {
  return `${source.toLowerCase()}:${discordId}:${day}`;
}

/**
 * Roll a ledger up into per-source totals. Used to rebuild a balance, so it
 * takes signed amounts: a MANUAL deduction has to be able to pull a total down.
 */
export function totalsBySource(
  awards: readonly { readonly source: XpSource; readonly amount: number }[],
): Readonly<Partial<Record<XpSource, number>>> {
  const totals: Partial<Record<XpSource, number>> = {};
  for (const a of awards) totals[a.source] = (totals[a.source] ?? 0) + a.amount;
  return totals;
}
