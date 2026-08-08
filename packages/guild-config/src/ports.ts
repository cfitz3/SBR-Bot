/**
 * Port: guild-config persistence. Implemented by `@sbr/db`
 * (`guildConfigRepository`) so neither side depends on the other.
 */
export interface GuildConfigRow {
  readonly bridgeChannelId: string | null;
  readonly staffChannelId: string | null;
  readonly logChannelId: string | null;
  readonly applicationsChannelId: string | null;
  readonly eventsChannelId: string | null;
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
}
