/**
 * The trigger runner: rules in, one action out, exactly once.
 *
 * Three concerns meet here and none of them belongs in the matcher. The rules
 * have to be cached, because they are consulted on every reaction and every
 * message in a server that may have no rules at all. The firing has to be
 * claimed, because a message at ten stars keeps receiving an eleventh and every
 * one of them satisfies the rule again. And the action has to go through a port,
 * because "repost somebody's message into a public channel" is the behaviour
 * most worth having a test for, and a test cannot hold a gateway.
 *
 * What is deliberately not here: any decision about *whether* a rule matches.
 * That lives in `@sbr/triggers` where it is pure and offline-testable; this file
 * only fetches, claims and acts.
 */
import { firedByMessage, firedByReaction, firingKey, renderTriggerPostEmbed } from "@sbr/triggers";
import type { MessageEvent, ReactionEvent } from "@sbr/triggers";
import type { EmbedView, TriggerRule } from "@sbr/shared-types";

/** How long a compiled rule list is reused before it is re-read. */
export const RULE_CACHE_MS = 60_000;

/**
 * How long a firing is remembered.
 *
 * Long past the point where an old message is still collecting reactions, so a
 * thread somebody revives a week later does not repost itself; short enough
 * that the keyspace is bounded by a fortnight of guild activity rather than by
 * the guild's whole history.
 */
export const FIRING_TTL_SECONDS = 14 * 24 * 60 * 60;

/** What a repost needs to know about the message it is quoting. */
export interface TriggerSubject {
  readonly authorName: string;
  readonly authorAvatarUrl: string | null;
  readonly content: string;
  readonly imageUrl: string | null;
  readonly hasOtherAttachments: boolean;
  readonly jumpUrl: string;
  /** The original's ISO timestamp — the card is dated by the message, not the repost. */
  readonly postedAt: string;
}

/** The three things a rule can ask for, as calls rather than as a client. */
export interface TriggerEffects {
  repost(channelId: string, embed: EmbedView): Promise<void>;
  pin(channelId: string, messageId: string): Promise<void>;
  reply(channelId: string, messageId: string, text: string): Promise<void>;
}

export interface TriggerRunnerDeps {
  listRules(guildId: string): Promise<readonly TriggerRule[]>;
  /** True exactly once per key. See `FiringLedger`. */
  claim(guildId: string, key: string, ttlSeconds: number): Promise<boolean>;
  effects: TriggerEffects;
  log: { warn(message: string, meta?: Record<string, unknown>): void };
  /** Injectable so the test does not sleep. */
  now?(): number;
}

export interface TriggerRunner {
  onReaction(guildId: string, event: ReactionEvent, subject: TriggerSubject): Promise<void>;
  onMessage(guildId: string, event: MessageEvent, subject: TriggerSubject): Promise<void>;
  /** Drop a guild's cached rules — the panel just changed them. */
  invalidate(guildId: string): void;
}

interface Entry {
  readonly rules: readonly TriggerRule[];
  readonly readAt: number;
}

export function createTriggerRunner(deps: TriggerRunnerDeps): TriggerRunner {
  const now = (): number => deps.now?.() ?? Date.now();
  const cache = new Map<string, Entry>();

  async function rulesFor(guildId: string): Promise<readonly TriggerRule[]> {
    const hit = cache.get(guildId);
    if (hit !== undefined && now() - hit.readAt < RULE_CACHE_MS) return hit.rules;

    // A failed read reuses whatever is cached rather than falling silent: the
    // rules were right a minute ago, and a config blip is not a reason for a
    // board to stop working.
    const rules = await deps.listRules(guildId).catch(() => null);
    if (rules === null) return hit?.rules ?? [];

    cache.set(guildId, { rules, readAt: now() });
    return rules;
  }

  /**
   * Act on one rule, once.
   *
   * The claim comes before the action rather than after it, so a repost that
   * fails to send is still counted as fired. That is the safer end to be wrong
   * at: the alternative retries on every subsequent reaction, and a channel the
   * bot cannot post in would generate one attempt per star forever.
   *
   * A ledger that throws means the answer is unknown, and unknown is treated as
   * "already fired" — silence beats a duplicate repost of somebody's message.
   */
  async function act(
    guildId: string,
    rule: TriggerRule,
    event: { readonly channelId: string; readonly messageId: string },
    subject: TriggerSubject,
    reaction: { readonly emoji: string; readonly count: number } | null,
  ): Promise<void> {
    const claimed = await deps
      .claim(guildId, firingKey(rule, event.messageId), FIRING_TTL_SECONDS)
      .catch((error: unknown) => {
        deps.log.warn("trigger ledger unavailable — skipping", { rule: rule.id, error: String(error) });
        return false;
      });
    if (!claimed) return;

    try {
      switch (rule.then.kind) {
        case "REPOST":
          await deps.effects.repost(
            rule.then.channelId,
            renderTriggerPostEmbed({
              label: rule.label,
              authorName: subject.authorName,
              authorAvatarUrl: subject.authorAvatarUrl,
              content: subject.content,
              imageUrl: subject.imageUrl,
              hasOtherAttachments: subject.hasOtherAttachments,
              channelId: event.channelId,
              jumpUrl: subject.jumpUrl,
              reaction,
              postedAt: subject.postedAt,
            }),
          );
          return;
        case "PIN":
          await deps.effects.pin(event.channelId, event.messageId);
          return;
        case "REPLY":
          await deps.effects.reply(event.channelId, event.messageId, rule.then.text);
          return;
      }
    } catch (error: unknown) {
      // Best-effort by design: a missing permission on one channel must not
      // stop the other rules on the same message from running.
      deps.log.warn("trigger action did not land", {
        rule: rule.id,
        action: rule.then.kind,
        error: String(error),
      });
    }
  }

  return {
    async onReaction(guildId, event, subject) {
      const rules = await rulesFor(guildId);
      if (rules.length === 0) return;
      for (const rule of firedByReaction(rules, event)) {
        await act(guildId, rule, event, subject, { emoji: event.emoji, count: event.count });
      }
    },

    async onMessage(guildId, event, subject) {
      const rules = await rulesFor(guildId);
      if (rules.length === 0) return;
      for (const rule of firedByMessage(rules, event)) {
        await act(guildId, rule, event, subject, null);
      }
    },

    invalidate(guildId) {
      cache.delete(guildId);
    },
  };
}
