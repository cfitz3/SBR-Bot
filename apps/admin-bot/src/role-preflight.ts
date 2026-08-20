/**
 * Whether this bot may hand out a given role — decided here, before anything is
 * attempted against Discord.
 *
 * This is the safety half of the auto-role feature and it is deliberately a
 * pure module: no gateway, no HTTP, no Prisma. A refusal has to be computable
 * from facts alone, because the same rules have to run in three places — the
 * panel, so a bad rule cannot be saved; the effector, so a rule saved before the
 * server was reorganised cannot be executed; and the picker, so a role that
 * could never be granted is greyed out rather than offered.
 *
 * The posture is that a refusal is cheap and a wrong grant is not. A bot that
 * hands out Administrator because somebody picked the wrong row in a dropdown
 * is the worst thing this feature could do, so anything carrying real authority
 * is refused outright — even though a guild might genuinely want to automate a
 * moderator role. That is a deliberate limitation, not an oversight: staff
 * promotion should be a human act with a name attached to it.
 */
import { PermissionFlagsBits } from "discord.js";

/** Everything the decision needs to know about one role. */
export interface RoleFacts {
  readonly id: string;
  readonly name: string;
  /** Higher is more senior. Discord's own ordering. */
  readonly position: number;
  /** Owned by an integration — Discord itself refuses to assign these. */
  readonly managed: boolean;
  /** `@everyone`, whose id is the guild id. Not a role anyone can be given. */
  readonly isEveryone: boolean;
  /** Discord's packed permission bitfield. */
  readonly permissions: bigint;
}

/** Everything the decision needs to know about us. */
export interface BotFacts {
  /** The position of the bot's own highest role. */
  readonly highestPosition: number;
  readonly canManageRoles: boolean;
}

export type RoleRefusal =
  | "BOT_LACKS_MANAGE_ROLES"
  | "UNKNOWN_ROLE"
  | "EVERYONE"
  | "MANAGED"
  | "DANGEROUS_PERMISSION"
  | "ABOVE_BOT";

/**
 * Permissions that make a role a grant of authority rather than a label.
 *
 * `ModerateMembers` is on the list because a timeout is a punishment, and
 * `ManageWebhooks` because a webhook can impersonate anybody in the server —
 * neither is obviously "dangerous" at a glance, which is exactly why they are
 * written down instead of left to judgement.
 */
export const DANGEROUS_PERMISSIONS: readonly (readonly [string, bigint])[] = Object.freeze([
  ["Administrator", PermissionFlagsBits.Administrator],
  ["Manage Server", PermissionFlagsBits.ManageGuild],
  ["Manage Roles", PermissionFlagsBits.ManageRoles],
  ["Manage Channels", PermissionFlagsBits.ManageChannels],
  ["Manage Webhooks", PermissionFlagsBits.ManageWebhooks],
  ["Ban Members", PermissionFlagsBits.BanMembers],
  ["Kick Members", PermissionFlagsBits.KickMembers],
  ["Timeout Members", PermissionFlagsBits.ModerateMembers],
]);

/** The dangerous permissions a role actually carries, for the refusal message. */
export function dangerousPermissionsOf(permissions: bigint): readonly string[] {
  return DANGEROUS_PERMISSIONS.filter(([, bit]) => (permissions & bit) === bit).map(([name]) => name);
}

/**
 * Null when the role may be assigned, otherwise why not.
 *
 * Order is not arbitrary. `BOT_LACKS_MANAGE_ROLES` comes first because when it
 * is true nothing else matters and reporting a role-specific reason would send
 * an operator to fix the wrong thing. `ABOVE_BOT` comes last because it is the
 * one an operator can fix by dragging a role, and it is more useful to hear
 * "that role is Administrator" than "move me above Administrator".
 */
export function refuseRole(role: RoleFacts | null, bot: BotFacts): RoleRefusal | null {
  if (!bot.canManageRoles) return "BOT_LACKS_MANAGE_ROLES";
  if (role === null) return "UNKNOWN_ROLE";
  if (role.isEveryone) return "EVERYONE";
  if (role.managed) return "MANAGED";
  if (dangerousPermissionsOf(role.permissions).length > 0) return "DANGEROUS_PERMISSION";
  // Equal is refused as well as above: Discord requires a *strictly* higher role
  // to assign one, so a tie fails at the API with a bare 50013.
  if (role.position >= bot.highestPosition) return "ABOVE_BOT";
  return null;
}

/**
 * The refusal as a sentence an operator can act on.
 *
 * Written for the panel rather than the log: every one of these names the thing
 * to change, because "MANAGED" on its own tells somebody nothing about why the
 * role they picked is greyed out.
 */
export function describeRefusal(reason: RoleRefusal, role: RoleFacts | null): string {
  switch (reason) {
    case "BOT_LACKS_MANAGE_ROLES":
      return "The admin bot does not have the Manage Roles permission in this server.";
    case "UNKNOWN_ROLE":
      return "That role no longer exists in this server.";
    case "EVERYONE":
      return "@everyone is held by everyone already — it cannot be granted or removed.";
    case "MANAGED":
      return "That role belongs to an integration, and Discord does not allow anyone to assign it.";
    case "DANGEROUS_PERMISSION": {
      const carried = role === null ? [] : dangerousPermissionsOf(role.permissions);
      const list = carried.length > 0 ? carried.join(", ") : "server management permissions";
      return `That role carries ${list}, so it is not something a rule may hand out. Promote staff by hand.`;
    }
    case "ABOVE_BOT":
      return "That role sits at or above the admin bot's own highest role. Drag the bot's role above it.";
  }
}
