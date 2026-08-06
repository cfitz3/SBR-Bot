import type { MemberRole, ModActionType } from "@sbr/shared-types";

const RANK_ORDER: Record<MemberRole, number> = {
  MEMBER: 0,
  MODERATOR: 1,
  OFFICER: 2,
  ADMIN: 3,
  OWNER: 4,
};

export function rankOf(role: MemberRole): number {
  return RANK_ORDER[role];
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
