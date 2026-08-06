/**
 * AnalyticsServiceImpl — cheap, guild-scoped event capture. Wraps command usage
 * into a uniform event envelope and appends to the buffer; never blocks the hot
 * path with aggregation (that's the workers' rollup job).
 */
import type { AnalyticsEvent, AnalyticsService, CommandUsageDTO } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import type { AnalyticsBuffer } from "./ports.js";

export interface AnalyticsServiceDeps {
  readonly buffer: AnalyticsBuffer;
  readonly logger: Logger;
}

export class AnalyticsServiceImpl implements AnalyticsService {
  private readonly buffer: AnalyticsBuffer;
  private readonly log: Logger;

  constructor(deps: AnalyticsServiceDeps) {
    this.buffer = deps.buffer;
    this.log = deps.logger.child({ service: "analytics" });
  }

  async capture(usage: CommandUsageDTO): Promise<void> {
    const event: AnalyticsEvent = {
      type: "command.used",
      guildId: usage.guildId,
      surface: usage.surface,
      ts: usage.invokedAt,
      props: {
        command: usage.command,
        success: usage.success,
        latencyMs: usage.latencyMs,
        discordId: usage.discordId,
      },
    };
    await this.safeAppend(event);
  }

  async emit(event: AnalyticsEvent): Promise<void> {
    await this.safeAppend(event);
  }

  private async safeAppend(event: AnalyticsEvent): Promise<void> {
    try {
      await this.buffer.append(event);
    } catch (error) {
      // Analytics must never break the caller — drop and log.
      this.log.warn("analytics append failed (dropped)", {
        type: event.type,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }
}
