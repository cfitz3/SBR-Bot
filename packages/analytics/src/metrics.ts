/**
 * Adapters from the domain packages' fire-and-forget metrics ports onto the
 * analytics stream.
 *
 * The shapes here are declared rather than imported from `@sbr/moderation` and
 * `@sbr/bridge`: those packages depend on nothing in this direction and adding
 * the edge to satisfy a type would invert the dependency for no benefit.
 * Structural typing makes the result assignable to `ModerationMetrics` and
 * `RelayMetrics` anyway, and the compiler still fails at the composition root
 * if either port changes shape — which is the check that actually matters.
 *
 * Every method swallows its own failures. A metrics buffer that is full or a
 * Redis that is down must not surface as a failed punishment or a chat message
 * that did not arrive; a lost count is the cheaper loss, by a wide margin.
 */
import type { AnalyticsService, CommandSurface } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";

export interface DomainMetricsOptions {
  readonly analytics: AnalyticsService;
  /** The process doing the emitting — BRIDGE_BOT, ADMIN_BOT or WEB_PANEL. */
  readonly surface: CommandSurface;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export interface DomainMetrics {
  actionApplied(guildId: string, type: string): void;
  filterHit(guildId: string, ruleId: string, action: string): void;
  relayed(guildId: string, direction: string): void;
}

export function createDomainMetrics(opts: DomainMetricsOptions): DomainMetrics {
  const now = opts.now ?? (() => new Date());
  const log = opts.logger.child({ service: "metrics" });

  const send = (type: string, guildId: string, props: Readonly<Record<string, unknown>>): void => {
    void opts.analytics
      .emit({ type, guildId, surface: opts.surface, ts: now().toISOString(), props })
      .catch((error: unknown) => {
        log.debug("metric dropped", { type, error: error instanceof Error ? error.message : "unknown" });
      });
  };

  return {
    actionApplied(guildId, type) {
      send("mod.action", guildId, { type });
    },
    filterHit(guildId, ruleId, action) {
      send("filter.hit", guildId, { rule: ruleId, action });
    },
    relayed(guildId, direction) {
      send("bridge.relay", guildId, { direction });
    },
  };
}
