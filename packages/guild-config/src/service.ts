/**
 * GuildConfigService — per-guild channels, feature flags, and the bridge kill
 * switch.
 *
 * Reads are cached for a few seconds: the bridge asks whether it is suspended on
 * every relayed line, and a database round trip per chat message is not a cost
 * worth paying for a value that changes a handful of times a year. Writes clear
 * the entry so a staffer never has to wonder whether their toggle took effect.
 */
import type { Logger } from "@sbr/observability";
import {
  err,
  ok,
  type ConfigChannelSlot,
  type GuildConfigService,
  type GuildRuntimeConfig,
  type MemberRole,
  type RecruitmentSettings,
  type Result,
} from "@sbr/shared-types";
import type { ConfigBroadcaster, GuildConfigRepository } from "./ports.js";

export interface GuildConfigServiceDeps {
  readonly repo: GuildConfigRepository;
  readonly logger: Logger;
  readonly ttlMs?: number;
  readonly now?: () => number;
  /**
   * Optional: announce writes so other processes drop their cached copy. Absent
   * in tests and in single-process tools, where there is nobody to tell.
   */
  readonly broadcast?: ConfigBroadcaster;
}

/** Column behind each `/set-channel` slot name. */
const CHANNEL_COLUMNS: Record<ConfigChannelSlot, string> = {
  bridge: "bridgeChannelId",
  staff: "staffChannelId",
  log: "logChannelId",
  applications: "applicationsChannelId",
  events: "eventsChannelId",
};

const DEFAULT_TTL_MS = 10_000;

export class GuildConfigServiceImpl implements GuildConfigService {
  private readonly repo: GuildConfigRepository;
  private readonly log: Logger;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; value: GuildRuntimeConfig | null }>();
  private readonly broadcast: ConfigBroadcaster | null;

  constructor(deps: GuildConfigServiceDeps) {
    this.repo = deps.repo;
    this.log = deps.logger.child({ service: "guild-config" });
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.now = deps.now ?? (() => Date.now());
    this.broadcast = deps.broadcast ?? null;
  }

  /**
   * Drop a guild's cached copy.
   *
   * Called by whatever subscribes to the config channel, so a change made in
   * another process is picked up on the next read instead of after this
   * instance's TTL. Deliberately not a refetch: the next reader will do that,
   * and a guild nobody asks about should not cost a query per edit.
   */
  invalidate(guildId: string): void {
    this.cache.delete(guildId);
  }

  async get(guildId: string): Promise<Result<GuildRuntimeConfig | null>> {
    const cached = this.cache.get(guildId);
    if (cached && this.now() - cached.at < this.ttlMs) return ok(cached.value);

    try {
      const row = await this.repo.get(guildId);
      const value: GuildRuntimeConfig | null = row ? { guildId, ...row } : null;
      this.cache.set(guildId, { at: this.now(), value });
      return ok(value);
    } catch (error) {
      this.log.error("guild config read failed", {
        guildId,
        error: error instanceof Error ? error.message : "unknown",
      });
      // Serve the last known value rather than failing the caller: a stale
      // config is far better than a dead bridge.
      if (cached) return ok(cached.value);
      return err(new Error("guild config unavailable"));
    }
  }

  async isFeatureEnabled(guildId: string, feature: string): Promise<boolean> {
    const config = await this.get(guildId);
    if (!config.ok || config.value === null) return false;
    return config.value.features[feature] === true;
  }

  async setChannel(guildId: string, slot: ConfigChannelSlot, channelId: string | null): Promise<Result<void>> {
    return this.write(guildId, () => this.repo.update(guildId, { [CHANNEL_COLUMNS[slot]]: channelId }));
  }

  async setFeature(guildId: string, feature: string, enabled: boolean): Promise<Result<void>> {
    return this.write(guildId, () => this.repo.setFeature(guildId, feature, enabled));
  }

  async setBridgeSuspended(guildId: string, suspended: boolean): Promise<Result<void>> {
    return this.write(guildId, () => this.repo.update(guildId, { bridgeSuspended: suspended }));
  }

  async setRecruitment(guildId: string, input: RecruitmentSettings): Promise<Result<void>> {
    // Only write the thresholds that were actually named. An omitted `minWeight`
    // means "leave the bar alone", not "clear it" — collapsing the two would
    // erase a guild's entry requirements every time someone reopened
    // applications.
    const patch: Record<string, string | number | boolean | null> = { applicationsOpen: input.open };
    if (input.minWeight !== undefined) patch.minWeight = input.minWeight;
    if (input.minNetworth !== undefined) patch.minNetworth = input.minNetworth;
    return this.write(guildId, () => this.repo.update(guildId, patch));
  }

  async setRoleMapping(guildId: string, role: MemberRole, discordRoleId: string | null): Promise<Result<void>> {
    return this.write(guildId, () => this.repo.setRoleMapping(guildId, role, discordRoleId));
  }

  private async write(guildId: string, apply: () => Promise<void>): Promise<Result<void>> {
    try {
      await apply();
      this.cache.delete(guildId); // never leave a staffer looking at their own stale write
      // Announced after the row is durable, so a subscriber that reacts by
      // reading cannot beat the write it is reacting to. A failed publish costs
      // other processes their few seconds of TTL, not the write — reporting the
      // save as failed here would be a lie about what is now in Postgres.
      if (this.broadcast) {
        await this.broadcast.publish(guildId).catch((error: unknown) => {
          this.log.warn("config change published nowhere", {
            guildId,
            error: error instanceof Error ? error.message : "unknown",
          });
        });
      }
      return ok(undefined);
    } catch (error) {
      this.log.error("guild config write failed", {
        guildId,
        error: error instanceof Error ? error.message : "unknown",
      });
      return err(new Error("couldn't save that setting"));
    }
  }
}
