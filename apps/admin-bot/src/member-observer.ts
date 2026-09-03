/**
 * Watches members arrive and leave, and says so on the member bus.
 *
 * This process observes because it already holds `GuildMembers` — observing is
 * automated work, and adding a privileged intent to the shared member-facing
 * application just to notice a join would be paying a permission for a message.
 * It only observes: the greeting itself is posted by SBR Bot, because a welcome
 * from a staff bot most members cannot see or message would be the platform
 * speaking out of the wrong mouth.
 *
 * Everything a greeter could need travels on the payload. A member who has left
 * cannot be fetched afterwards, and half a farewell is worse than none.
 */
import { Events, type Client, type GuildMember, type PartialGuildMember } from "discord.js";
import type { Logger } from "@sbr/observability";
import type { MemberBusMessage } from "@sbr/redis";

export interface MemberObserverDeps {
  /** Discord guild id → this platform's guild id, or null if unmapped. */
  resolveGuild(discordGuildId: string): Promise<string | null>;
  publish(message: MemberBusMessage): Promise<void>;
  /**
   * Mark an arriving member's auto-roles as out of date.
   *
   * Separate from the bus message on purpose. The bus carries a fact for
   * whoever wants to greet them; this is the one consumer that has to act
   * before the next sweep, because a member who joins and is given nothing for
   * fifteen minutes reads as a broken server rather than a slow one.
   *
   * Marking, not applying. The mark is what the sweep drains and what the
   * immediate path is nudged by; the effector in this process is still the only
   * thing that touches a role, and it is still reached through the same
   * preflight. A gateway handler that wrote a role directly would be exactly
   * the shortcut around the refusal rules that the effector exists to prevent.
   */
  markRolesDirty(guildId: string, discordIds: readonly string[]): Promise<void>;
  readonly logger: Logger;
}

/**
 * Strips anything that could turn a display name into a ping or wreck the
 * layout of the message it lands in.
 *
 * Done here, at the edge, as well as in the renderer: a nickname is the one
 * piece of a welcome message that the person being welcomed chooses, so it gets
 * treated as hostile input at every boundary it crosses rather than at one.
 */
export function safeUsername(raw: string): string {
  return raw
    .replace(/@(everyone|here)/g, "@​$1")
    .replace(/[\r\n]+/g, " ")
    .replace(/[`*_~|]/g, "")
    .trim()
    .slice(0, 64);
}

export function attachMemberObserver(client: Client, deps: MemberObserverDeps): void {
  const announce = async (
    member: GuildMember | PartialGuildMember,
    kind: MemberBusMessage["kind"],
  ): Promise<void> => {
    // Bots are not members. Welcoming one is noise in the channel members
    // read, and marking its roles dirty spends a reconciliation pass on an
    // account whose roles are held by whoever invited it rather than by any
    // rule this platform owns. Both directions: a farewell for a removed
    // integration is the same noise.
    if (member.user?.bot === true) return;

    const guildId = await deps.resolveGuild(member.guild.id);
    // An unmapped server is not an error. The bot is in servers this platform
    // has never been told about, and they are not owed a greeting.
    if (guildId === null) return;

    // Only on the way in. A member who has left has no roles to reconcile, and
    // their grants are closed by the sweep's own "not present" branch.
    if (kind === "member-join") {
      await deps.markRolesDirty(guildId, [member.id]).catch(() => undefined);
    }

    await deps.publish({
      kind,
      guildId,
      discordId: member.id,
      // `user` can be partial on a leave; the id is the only guaranteed field,
      // so the name falls back to something renderable rather than "undefined".
      username: safeUsername(member.user?.username ?? member.displayName ?? "a member"),
      serverName: member.guild.name,
      memberCount: member.guild.memberCount ?? null,
    });
  };

  client.on(Events.GuildMemberAdd, (member) => {
    void announce(member, "member-join").catch((error: unknown) => {
      // Warn and carry on: nothing downstream of a welcome message is worth
      // an unhandled rejection in the process that runs staff commands.
      deps.logger.warn("member join not announced", { discordId: member.id, error: String(error) });
    });
  });

  client.on(Events.GuildMemberRemove, (member) => {
    void announce(member, "member-leave").catch((error: unknown) => {
      deps.logger.warn("member leave not announced", { discordId: member.id, error: String(error) });
    });
  });
}
