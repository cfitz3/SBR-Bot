/**
 * Counting what moderation did, for the Analytics page.
 *
 * A port rather than an `AnalyticsService` dependency, and every method is
 * synchronous and returns nothing. That is the whole design: these calls sit
 * inside a message pipeline and a punishment path, and telemetry must never be
 * able to delay or fail either. `void` in the signature makes awaiting one
 * impossible rather than merely discouraged, and an implementation that throws
 * is a bug in the implementation, not something each call site guards.
 *
 * The dimension names match `ROLLUP_DIMENSIONS` in `@sbr/analytics` exactly —
 * `mod.action` breaks down by `type`, `filter.hit` by `rule` and `action`. A
 * name that does not match is not an error anywhere; it just produces a series
 * nobody charts, which is why they are fixed here rather than passed in.
 */
export interface ModerationMetrics {
  /** One applied action. Rejected ones are not counted — nothing happened. */
  actionApplied(guildId: string, type: string): void;
  /**
   * One rule firing on one message. A message matching three rules records
   * three hits: the question this answers is "which rule is doing the work",
   * and collapsing them to one per message would answer it wrongly.
   */
  filterHit(guildId: string, ruleId: string, action: string): void;
}
