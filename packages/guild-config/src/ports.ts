import type { ConfigChannelSlot } from "@sbr/shared-types";

/**
 * Port: guild-config persistence. Implemented by `@sbr/db`
 * (`guildConfigRepository`) so neither side depends on the other.
 */
export interface GuildConfigRow {
  /** Channel bindings by slot — the only place a channel is recorded. */
  readonly channels: Readonly<Partial<Record<ConfigChannelSlot, string>>>;
  readonly prefixes: readonly string[];
  readonly timezone: string;
  readonly applicationsOpen: boolean;
  readonly bridgeSuspended: boolean;
  readonly features: Readonly<Record<string, boolean>>;
  readonly minWeight: number | null;
  readonly minNetworth: number | null;
  readonly roleMappings: Readonly<Record<string, string>>;
}

/**
 * Port: the fan-out that tells other processes a guild's config moved.
 *
 * Declared here so the service can announce its own writes. Putting it at this
 * layer rather than in the panel is deliberate — an admin-bot `/set-channel` and
 * a panel toggle are the same event to every subscriber, and a publish that only
 * fires on one of those paths is a cache-coherence bug waiting for the other.
 */
export interface ConfigBroadcaster {
  publish(guildId: string): Promise<void>;
}

export interface GuildConfigRepository {
  get(guildId: string): Promise<GuildConfigRow | null>;
  update(guildId: string, patch: Record<string, string | number | boolean | null>): Promise<void>;
  setFeature(guildId: string, feature: string, enabled: boolean): Promise<void>;
  /** Bind or clear one platform role's Discord role id, leaving the rest alone. */
  setRoleMapping(guildId: string, role: string, discordRoleId: string | null): Promise<void>;
  /**
   * Bind or clear one channel slot. Null deletes the binding rather than storing
   * an empty string, so "unset" and "set to nothing" cannot diverge.
   */
  setChannelBinding(guildId: string, slot: ConfigChannelSlot, channelId: string | null): Promise<void>;
  /**
   * Bind or clear the Hypixel guild this platform guild tracks. Null unlinks.
   *
   * The odd one out on this port: it writes `Guild`, not `GuildConfig`. It lives
   * here anyway because it is guild configuration to everyone who sets it, and
   * because it has to share the service's cache-clear and broadcast — a link
   * that landed in Postgres while the bots kept serving the old picture would be
   * the exact drift `ConfigBroadcaster` exists to prevent.
   *
   * Rejects with an Error, rather than overwriting, when another guild already
   * holds that Hypixel id; the column is unique and the collision is a real
   * answer, not a failure.
   */
  setHypixelGuild(guildId: string, hypixelGuildId: string | null): Promise<void>;
  /** Read one admin setting; null when the guild has never set it. */
  getSetting(guildId: string, key: string): Promise<unknown>;
  /** Upsert one admin setting. Null deletes it, restoring the platform default. */
  setSetting(guildId: string, key: string, value: unknown): Promise<void>;
}
