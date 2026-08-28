/**
 * Which rules a message or a reaction has just satisfied.
 *
 * Pure, and given plain events rather than discord.js objects, for the usual
 * reason: this is the part that decides whether the bot reposts somebody's
 * message into a public channel, and it should be testable without a gateway.
 * The caller does the fetching and the acting; this decides.
 */
import type { TriggerRule } from "@sbr/shared-types";

/** A reaction as the gateway reports it, once the count is known. */
export interface ReactionEvent {
  readonly channelId: string;
  readonly messageId: string;
  /** Unicode emoji, or `name:id` for a custom one — as `normalizeEmoji` produces. */
  readonly emoji: string;
  /** How many people have reacted with it, the reactor included. */
  readonly count: number;
  readonly authorId: string;
  readonly authorIsBot: boolean;
  /**
   * Whether the message's author is among the reactors. Only consulted by rules
   * that exclude self-reactions, and only to subtract one from the count.
   */
  readonly authorReacted: boolean;
}

/** A message as the gateway reports it. */
export interface MessageEvent {
  readonly channelId: string;
  readonly messageId: string;
  readonly content: string;
  readonly authorId: string;
  readonly authorIsBot: boolean;
}

function inScope(rule: TriggerRule, channelId: string): boolean {
  if (rule.exemptChannels.includes(channelId)) return false;
  return rule.channels.length === 0 || rule.channels.includes(channelId);
}

/**
 * The reaction rules this event satisfies.
 *
 * The threshold is compared against the count *net of the author's own
 * reaction* unless the rule opts in, because the alternative is a board a
 * member can put themselves on with two friends and a self-star. It is a
 * subtraction rather than a refusal to run: the author reacting to their own
 * message is not misconduct, it just does not count.
 *
 * Firing is a property of the count, not of who reacted last — so the caller
 * must deduplicate. Every reaction past the threshold satisfies the rule again,
 * and a board that reposts a popular message once per star is the bug this
 * comment exists to prevent.
 */
export function firedByReaction(
  rules: readonly TriggerRule[],
  event: ReactionEvent,
): readonly TriggerRule[] {
  return rules.filter((rule) => {
    if (!rule.enabled || rule.when.kind !== "REACTION_COUNT") return false;
    if (!inScope(rule, event.channelId)) return false;
    if (event.authorIsBot && !rule.includeBots) return false;
    if (event.emoji !== rule.when.emoji) return false;
    const counted = rule.includeSelf || !event.authorReacted ? event.count : event.count - 1;
    return counted >= rule.when.threshold;
  });
}

/**
 * The message rules this event satisfies.
 *
 * Substring, case-insensitively, and not a regex: a pattern staff can type into
 * a panel field is a pattern that can be catastrophically slow, and the guild
 * already has a compiled-pattern surface for the cases that need one
 * (autoresponder tags). This is for "somebody said the words".
 */
export function firedByMessage(
  rules: readonly TriggerRule[],
  event: MessageEvent,
): readonly TriggerRule[] {
  const haystack = event.content.toLowerCase();
  return rules.filter((rule) => {
    if (!rule.enabled || rule.when.kind !== "MESSAGE_CONTAINS") return false;
    if (!inScope(rule, event.channelId)) return false;
    if (event.authorIsBot && !rule.includeBots) return false;
    return haystack.includes(rule.when.phrase.toLowerCase());
  });
}

/**
 * The key one firing is deduplicated under.
 *
 * Rule *and* message: two rules watching the same message are two separate
 * things staff asked for, and a message that has already been reposted should
 * not be reposted again by the same rule when the next person reacts.
 */
export function firingKey(rule: TriggerRule, messageId: string): string {
  return `${rule.id}:${messageId}`;
}
