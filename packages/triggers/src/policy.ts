/**
 * What a guild has told the bot to watch for, and what to do about it.
 *
 * The shape is deliberately two halves — a condition and an action, each a
 * tagged union — rather than a "starboard config" with a star count in it. A
 * starboard is one pairing of the two: enough people react with a chosen emoji,
 * so the message is reposted somewhere. Written as a starboard, the next
 * request ("pin it instead", "watch for a phrase") is a second feature with its
 * own settings, its own panel card and its own place to go wrong. Written as a
 * pair of unions, it is a new variant in one switch.
 *
 * Rules live in guild config rather than a table of their own: there are at
 * most a handful, they are read on the message hot path, and the config layer
 * already has the caching and pub/sub invalidation that makes that affordable.
 */
import type { TriggerAction, TriggerCondition, TriggerRule } from "@sbr/shared-types";

export const TRIGGERS_SETTING_KEY = "triggers";

/**
 * A cap, not a limitation anybody will meet.
 *
 * Every rule is evaluated against every reaction and every message in scope, so
 * the list is a per-event cost. Ten is far past what a guild has ever asked for
 * and still cheap enough that a chatty server does not pay for it.
 */
export const MAX_TRIGGER_RULES = 10;

/** Discord will not accept a reaction from fewer than one person. */
export const MIN_REACTION_THRESHOLD = 1;
/** Past this, a rule that never fires reads as a broken feature. */
export const MAX_REACTION_THRESHOLD = 50;

/** Long enough for a phrase, short enough that it is not a paragraph matcher. */
export const MAX_PATTERN_LENGTH = 120;
/** The reply action's ceiling. Longer belongs in an autoresponder tag. */
export const MAX_REPLY_LENGTH = 400;
/** Rule ids are ours, not Discord's, and are used in customIds and log lines. */
export const RULE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SNOWFLAKE = /^\d{17,20}$/;

export const DEFAULT_TRIGGERS: readonly TriggerRule[] = Object.freeze([]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ids(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && SNOWFLAKE.test(v)) : [];
}

/**
 * An emoji as Discord reports it on a reaction.
 *
 * A unicode emoji is itself; a custom one is `name:id`, because the id alone
 * would make the panel show a rule nobody can read and the name alone would
 * match a different server's emoji of the same name.
 */
export function normalizeEmoji(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const emoji = raw.trim().replace(/^<a?:/, "").replace(/>$/, "");
  if (emoji.length === 0 || emoji.length > 64) return null;
  return emoji;
}

function parseCondition(raw: unknown): TriggerCondition | null {
  if (!isRecord(raw)) return null;
  if (raw["kind"] === "REACTION_COUNT") {
    const emoji = normalizeEmoji(raw["emoji"]);
    const threshold = typeof raw["threshold"] === "number" ? Math.trunc(raw["threshold"]) : NaN;
    if (emoji === null || !Number.isFinite(threshold)) return null;
    if (threshold < MIN_REACTION_THRESHOLD || threshold > MAX_REACTION_THRESHOLD) return null;
    return { kind: "REACTION_COUNT", emoji, threshold };
  }
  if (raw["kind"] === "MESSAGE_CONTAINS") {
    const phrase = typeof raw["phrase"] === "string" ? raw["phrase"].trim() : "";
    if (phrase.length === 0 || phrase.length > MAX_PATTERN_LENGTH) return null;
    return { kind: "MESSAGE_CONTAINS", phrase };
  }
  return null;
}

function parseAction(raw: unknown): TriggerAction | null {
  if (!isRecord(raw)) return null;
  if (raw["kind"] === "REPOST") {
    const channelId = raw["channelId"];
    if (typeof channelId !== "string" || !SNOWFLAKE.test(channelId)) return null;
    return { kind: "REPOST", channelId };
  }
  if (raw["kind"] === "PIN") return { kind: "PIN" };
  if (raw["kind"] === "REPLY") {
    const text = typeof raw["text"] === "string" ? raw["text"].trim() : "";
    if (text.length === 0 || text.length > MAX_REPLY_LENGTH) return null;
    return { kind: "REPLY", text };
  }
  return null;
}

/**
 * Read the stored list, dropping only the rules that cannot be run.
 *
 * Per rule rather than all-or-nothing: one malformed entry — a channel that was
 * deleted and written back as null by an older panel, say — should cost that
 * rule and not the guild's starboard. A rule that is dropped here is also
 * invisible in the panel, which is the honest rendering: it is not running.
 */
export function parseTriggers(raw: unknown): readonly TriggerRule[] {
  const list = isRecord(raw) ? raw["rules"] : raw;
  if (!Array.isArray(list)) return DEFAULT_TRIGGERS;

  const seen = new Set<string>();
  const rules: TriggerRule[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const id = typeof entry["id"] === "string" ? entry["id"] : "";
    if (!RULE_ID.test(id) || seen.has(id)) continue;
    const when = parseCondition(entry["when"]);
    const then = parseAction(entry["then"]);
    if (when === null || then === null) continue;
    seen.add(id);
    rules.push({
      id,
      label: typeof entry["label"] === "string" && entry["label"].trim() !== "" ? entry["label"].trim() : id,
      // Absent means on: a rule that exists is a rule somebody added, and the
      // flag exists to switch one off without losing how it was set up.
      enabled: entry["enabled"] !== false,
      when,
      then,
      channels: ids(entry["channels"]),
      exemptChannels: ids(entry["exemptChannels"]),
      // Both default to the safe reading: bots do not trip triggers, and a
      // member cannot star themselves onto the board.
      includeBots: entry["includeBots"] === true,
      includeSelf: entry["includeSelf"] === true,
    });
    if (rules.length === MAX_TRIGGER_RULES) break;
  }
  return rules;
}

/** The strict half, for the panel: the first thing wrong with this blob, or null. */
export function validateTriggers(raw: unknown): string | null {
  const list = isRecord(raw) ? raw["rules"] : raw;
  if (!Array.isArray(list)) return "rules must be a list";
  if (list.length > MAX_TRIGGER_RULES) return `at most ${MAX_TRIGGER_RULES} rules`;

  const seen = new Set<string>();
  for (const entry of list) {
    if (!isRecord(entry)) return "each rule must be an object";
    const id = entry["id"];
    if (typeof id !== "string" || !RULE_ID.test(id)) {
      return "each rule needs an id of lowercase letters, digits and dashes";
    }
    if (seen.has(id)) return `two rules share the id "${id}"`;
    seen.add(id);
    if (typeof entry["label"] !== "string" || entry["label"].trim() === "") {
      return `rule "${id}" needs a name`;
    }
    if (parseCondition(entry["when"]) === null) {
      return `rule "${id}" needs a reaction count between ${MIN_REACTION_THRESHOLD} and ${MAX_REACTION_THRESHOLD}, or a phrase to watch for`;
    }
    if (parseAction(entry["then"]) === null) {
      return `rule "${id}" needs a channel to repost to, a pin, or a reply of at most ${MAX_REPLY_LENGTH} characters`;
    }
    for (const key of ["channels", "exemptChannels"] as const) {
      const value = entry[key];
      if (value !== undefined && !Array.isArray(value)) return `rule "${id}": ${key} must be a list`;
      if (Array.isArray(value) && value.some((v) => typeof v !== "string" || !SNOWFLAKE.test(v))) {
        return `rule "${id}": ${key} must be Discord channel ids`;
      }
    }
  }
  return null;
}
