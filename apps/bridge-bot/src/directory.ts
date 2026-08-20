/**
 * The discord.js half of `/userinfo`, `/serverinfo` and `/avatar`.
 *
 * Nothing but reads, and deliberately so: the handlers behind this port are
 * member-facing, so the narrowest thing that answers them is the right thing to
 * wire. It fetches a user, a member and a guild, and copies out flat values —
 * no discord.js object crosses back into the command layer, which is what keeps
 * those handlers testable without a gateway.
 *
 * Every fetch swallows its own failure into `null`. A member who has left, an
 * id typed in from another server and a momentary API hiccup all produce the
 * same shape, and the card says which of those it is from what came back rather
 * than from an exception.
 */
import type { Client } from "discord.js";
import type { DiscordDirectory, DiscordGuildInfo, DiscordUserInfo } from "@sbr/shared-types";

/** Discord's own cap; the renderer trims further for width. */
const MAX_ROLES = 50;

export function createDiscordDirectory(client: Client): DiscordDirectory {
  return {
    async lookupUser(guildId, userId): Promise<DiscordUserInfo | null> {
      const user = await client.users.fetch(userId).catch(() => null);
      if (user === null) return null;

      const guild = await client.guilds.fetch(guildId).catch(() => null);
      // `fetch` rather than the cache: a member who has never spoken is not
      // cached, and reporting them as "not in this server" would be wrong.
      const member = guild === null ? null : await guild.members.fetch(userId).catch(() => null);

      return {
        id: user.id,
        username: user.username,
        displayName: member?.nickname ?? user.displayName ?? user.username,
        bot: user.bot,
        avatarUrl: member?.displayAvatarURL({ size: 512 }) ?? user.displayAvatarURL({ size: 512 }) ?? null,
        createdAt: user.createdTimestamp,
        member:
          member === null
            ? null
            : {
                nickname: member.nickname,
                joinedAt: member.joinedTimestamp,
                boostingSince: member.premiumSinceTimestamp,
                // Highest first, and `@everyone` dropped: it is on every member
                // and so tells the reader nothing about this one.
                roleIds: [...member.roles.cache.values()]
                  .filter((role) => role.id !== guildId)
                  .sort((a, b) => b.position - a.position)
                  .slice(0, MAX_ROLES)
                  .map((role) => role.id),
                timedOutUntil: member.communicationDisabledUntilTimestamp,
              },
      };
    },

    async guildInfo(guildId): Promise<DiscordGuildInfo | null> {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (guild === null) return null;

      return {
        id: guild.id,
        name: guild.name,
        iconUrl: guild.iconURL({ size: 512 }),
        createdAt: guild.createdTimestamp,
        ownerId: guild.ownerId,
        // `memberCount` is the number the gateway hands us at ready. Paging the
        // member list to count them ourselves would be the same answer bought
        // with a rate limit.
        memberCount: guild.memberCount,
        channelCount: guild.channels.cache.size,
        roleCount: guild.roles.cache.size,
        emojiCount: guild.emojis.cache.size,
        boostTier: Number(guild.premiumTier),
        boostCount: guild.premiumSubscriptionCount ?? 0,
      };
    },
  };
}
