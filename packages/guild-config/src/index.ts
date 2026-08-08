/**
 * @sbr/guild-config — per-guild channels, feature flags, and the bridge kill
 * switch, over a repository port implemented by @sbr/db.
 */
export { GuildConfigServiceImpl, type GuildConfigServiceDeps } from "./service.js";
export type { ConfigBroadcaster, GuildConfigRepository, GuildConfigRow } from "./ports.js";
