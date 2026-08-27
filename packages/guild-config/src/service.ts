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
  featureDefault,
  isKnownFeature,
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

  /**
   * Whether a guild has this feature on.
   *
   * An absent flag means the guild has never touched it, which is not the same
   * as having turned it off — so the answer is the catalogue default rather
   * than `false`. The old reading made every flag opt-in and, since nothing
   * read them, made every one of them permanently off.
   *
   * A key nothing honours is off. That is not a policy so much as an
   * observation: `featureDefault` has no entry for it, and neither does any
   * caller.
   */
  async isFeatureEnabled(guildId: string, feature: string): Promise<boolean> {
    const config = await this.get(guildId);
    if (!config.ok || config.value === null) return featureDefault(feature);
    return config.value.features[feature] ?? featureDefault(feature);
  }

  async getChannel(guildId: string, slot: ConfigChannelSlot): Promise<string | null> {
    const config = await this.get(guildId);
    if (!config.ok || config.value === null) return null;
    return config.value.channels[slot] ?? null;
  }

  async setChannel(guildId: string, slot: ConfigChannelSlot, channelId: string | null): Promise<Result<void>> {
    // One write, one place. Until the legacy columns were dropped this also
    // mirrored five of the slots into GuildConfig; that mirror is gone with the
    // columns, so a partial failure can no longer leave two disagreeing copies.
    return this.write(guildId, () => this.repo.setChannelBinding(guildId, slot, channelId));
  }

  async getSetting<T>(guildId: string, key: string): Promise<T | null> {
    try {
      return ((await this.repo.getSetting(guildId, key)) as T | null) ?? null;
    } catch (error) {
      this.log.error("guild setting read failed", {
        guildId,
        key,
        error: error instanceof Error ? error.message : "unknown",
      });
      return null;
    }
  }

  async setSetting(guildId: string, key: string, value: unknown): Promise<Result<void>> {
    return this.write(guildId, () => this.repo.setSetting(guildId, key, value));
  }

  /**
   * Flip one flag, leaving the others alone.
   *
   * A key outside the catalogue is refused rather than stored. Both write
   * surfaces used to accept any string, so a typo became a row that looked
   * like a setting and behaved like nothing at all — and the operator's next
   * question was why the feature they just turned off was still running.
   *
   * Refusing does not clear keys already in the column; those stay visible in
   * the toggle menu and on the panel so they can be recognised and dealt with.
   */
  async setFeature(guildId: string, feature: string, enabled: boolean): Promise<Result<void>> {
    if (!isKnownFeature(feature)) return err(new Error(`unknown feature: ${feature}`));
    return this.write(guildId, () => this.repo.setFeature(guildId, feature, enabled));
  }

  async setBridgeSuspended(guildId: string, suspended: boolean): Promise<Result<void>> {
    return this.write(guildId, () => this.repo.update(guildId, { bridgeSuspended: suspended }));
  }

  async setRecruitment(guildId: string, input: RecruitmentSettings): Promise<Result<void>> {
    // The tri-state weight and networth bars were resolved here. They are no
    // longer requirements, so recruitment writes the one field it still has.
    return this.write(guildId, () => this.repo.update(guildId, { applicationsOpen: input.open }));
  }

  async setRoleMapping(guildId: string, role: MemberRole, discordRoleId: string | null): Promise<Result<void>> {
    return this.write(guildId, () => this.repo.setRoleMapping(guildId, role, discordRoleId));
  }

  /** The set form of `setRoleMapping`, for the panel's Permissions page. */
  async setRoleBinding(guildId: string, role: MemberRole, discordRoleIds: readonly string[]): Promise<Result<void>> {
    return this.write(guildId, () => this.repo.setRoleBinding(guildId, role, discordRoleIds));
  }

  async setHypixelGuild(guildId: string, hypixelGuildId: string | null): Promise<Result<void>> {
    // The one write here whose failure an admin can act on: the id is unique, so
    // a collision means another guild already holds it. `keepMessage` lets that
    // reach them instead of the generic "couldn't save that setting".
    return this.write(guildId, () => this.repo.setHypixelGuild(guildId, hypixelGuildId), true);
  }

  private async write(guildId: string, apply: () => Promise<void>, keepMessage = false): Promise<Result<void>> {
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
      if (keepMessage && error instanceof Error) return err(error);
      return err(new Error("couldn't save that setting"));
    }
  }
}
