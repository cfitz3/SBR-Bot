/**
 * The feature catalogue: the flags this platform actually honours.
 *
 * `GuildConfig.features` has always been a free-form `Record<string, boolean>`
 * with two write surfaces — `/feature-toggle` and the panel's Settings page —
 * and, until this module, no readers at all. `isFeatureEnabled` existed and was
 * called from nowhere. That combination is worse than having no flags: typing
 * `/feature-toggle feature:starbord enabled:false` stored a flag that looked
 * like it had done something, and the panel's "add a flag" box invited exactly
 * that. A switch wired to nothing is a lie told in the operator's own words.
 *
 * So the set is declared here, once, and it is the only set anything writes.
 * Each entry carries its own default, because "off until somebody turns it on"
 * is wrong for most of these: a guild that binds a milestones channel wants
 * milestones, and asking them to then also find a flag would be a second step
 * that only exists because the first one was incomplete.
 *
 * Adding a flag means adding it here *and* honouring it somewhere. The two
 * halves in one commit is the whole point of the catalogue.
 */

export interface FeatureDefinition {
  readonly key: string;
  /** What it is called in the toggle menu and on the panel. */
  readonly label: string;
  /**
   * What turning it off actually stops. Written for the person deciding, so it
   * names the visible consequence rather than the module.
   */
  readonly description: string;
  /**
   * The value used when the guild has never touched it.
   *
   * These read "on" because every one of them already has a real enabler — a
   * bound channel, a configured tag, a template. The flag is a way to silence
   * something without dismantling its configuration, not a second setup step.
   */
  readonly default: boolean;
}

export const FEATURE_CATALOGUE: readonly FeatureDefinition[] = [
  {
    key: "welcome",
    label: "Welcome messages",
    description: "Greet members when they join the Discord server.",
    default: true,
  },
  {
    key: "level_announcements",
    label: "Level-up announcements",
    description: "Post in the levels channel when a member gains a level.",
    default: true,
  },
  {
    key: "milestone_announcements",
    label: "Milestone announcements",
    description: "Post in the milestones channel when a member passes a tracked milestone.",
    default: true,
  },
  {
    key: "goal_announcements",
    label: "Goal announcements",
    description: "Post when a member reaches a goal they set for themselves.",
    default: true,
  },
  {
    key: "leaderboard_digest",
    label: "Weekly leaderboard digest",
    description: "Post the weekly standings to the digest channel.",
    default: true,
  },
  {
    key: "autoresponder",
    label: "Autoresponders",
    description: "Answer messages that match a configured tag pattern.",
    default: true,
  },
] as const;

/** Every catalogue key, for a caller that wants the set rather than the shape. */
export const FEATURE_KEYS: readonly string[] = FEATURE_CATALOGUE.map((f) => f.key);

const BY_KEY = new Map(FEATURE_CATALOGUE.map((f) => [f.key, f] as const));

/** The definition for a key, or null when nothing honours it. */
export function featureDefinition(key: string): FeatureDefinition | null {
  return BY_KEY.get(key) ?? null;
}

/**
 * Whether anything reads this key.
 *
 * The command refuses to write one that nothing reads. The panel still shows
 * stored keys that fail this test — hiding them would leave old junk in the
 * column with no way to see or clear it.
 */
export function isKnownFeature(key: string): boolean {
  return BY_KEY.has(key);
}

/** The catalogue default, or `false` for a key nothing honours. */
export function featureDefault(key: string): boolean {
  return BY_KEY.get(key)?.default ?? false;
}

/** One feature's state for a guild, as the toggle menu and the panel show it. */
export interface FeatureState extends FeatureDefinition {
  readonly enabled: boolean;
  /** False when the guild has never touched it and `enabled` is the default. */
  readonly configured: boolean;
}

/**
 * The whole catalogue resolved against a guild's stored flags.
 *
 * Catalogue order, not alphabetical and not storage order: these are read as a
 * list of decisions, and a list that reorders itself as flags are set is a list
 * nobody can learn the shape of.
 */
export function resolveFeatures(stored: Readonly<Record<string, boolean>>): readonly FeatureState[] {
  return FEATURE_CATALOGUE.map((definition) => {
    const value = stored[definition.key];
    return {
      ...definition,
      enabled: value ?? definition.default,
      configured: value !== undefined,
    };
  });
}

/**
 * Stored keys the catalogue does not recognise.
 *
 * Typos, and flags from features that were removed. They are surfaced rather
 * than swept up automatically: deleting a column entry on somebody's behalf
 * because this build does not recognise it would turn a rollback into data
 * loss.
 */
export function unrecognizedFeatures(stored: Readonly<Record<string, boolean>>): readonly string[] {
  return Object.keys(stored)
    .filter((key) => !BY_KEY.has(key))
    .sort((a, b) => a.localeCompare(b));
}
