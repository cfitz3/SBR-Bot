import { rankOfRole, type MemberRole, type ModActionType } from "@sbr/shared-types";

/**
 * Re-exported under this package's own name — the ordering itself moved to
 * @sbr/shared-types once identity needed it too, and one order is the point.
 */
export function rankOf(role: MemberRole): number {
  return rankOfRole(role);
}

/** Actions that punish a person — subject to rank-hierarchy and self-target guards. */
const PUNITIVE = new Set<ModActionType>([
  "WARN",
  "MUTE",
  "KICK",
  "BAN",
  "GUILD_EXPEL",
  "ROLE_CHANGE",
]);

export function isPunitive(type: ModActionType): boolean {
  return PUNITIVE.has(type);
}

/** Actions the bot enforces via a Discord API call (needs the Discord permission). */
const DISCORD_ENFORCED = new Set<ModActionType>(["MUTE", "KICK", "BAN", "UNBAN", "ROLE_CHANGE"]);

export function needsBotPermission(type: ModActionType): boolean {
  return DISCORD_ENFORCED.has(type);
}
