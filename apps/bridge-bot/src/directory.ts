/**
 * The discord.js half of `/whois` and `/serverinfo`.
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
 *
 * The guild id it is handed is the platform's, not Discord's. Every command
 * runs against an internal `Guild.id` — the interaction handler resolves the
 * snowflake to one before dispatch — so the translation back belongs here, in
 * the only layer that knows Discord exists. It was missing, which is why
 * `/serverinfo` answered "I can't see this server": the fetch was being given a
 * cuid and Discord, reasonably, had no server by that name. `/userinfo` failed
 * more quietly still, reporting every member as not in the server, because a
 * guild that cannot be fetched has no members to find.
 */
import type { Client } from "discord.js";
import type { DiscordDirectory, DiscordGuildInfo, DiscordUserInfo } from "@sbr/shared-types";

/** Discord's own cap; the renderer trims further for width. */
const MAX_ROLES = 50;

export function createDiscordDirectory(
  client: Client,
  /** Internal `Guild.id` → Discord snowflake. Null when the guild is unknown to us. */
  resolveDiscordId: (guildId: string) => Promise<string | null>,
): DiscordDirectory {
  /** One place to fetch a guild, so neither command can forget the translation. */
  async function fetchGuild(guildId: string) {
    const snowflake = await resolveDiscordId(guildId).catch(() => null);
    if (snowflake === null) return null;
    return client.guilds.fetch(snowflake).catch(() => null);
  }

  return {
    async lookupUser(guildId, userId): Promise<DiscordUserInfo | null> {
      const user = await client.users.fetch(userId).catch(() => null);
      if (user === null) return null;

      const guild = await fetchGuild(guildId);
      // `fetch` rather than the cache: a member who has never spoken is not
      // cached, and reporting them as "not in this server" would be wrong.
      const member = guild === null ? null : await guild.members.fetch(userId).catch(() => null);
      // `@everyone` carries the *guild's* snowflake as its id, which is not the
      // id this port was called with. Read it off the guild we actually fetched.
      const everyone = guild?.id ?? null;

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
                  .filter((role) => role.id !== everyone)
                  .sort((a, b) => b.position - a.position)
                  .slice(0, MAX_ROLES)
                  .map((role) => role.id),
                timedOutUntil: member.communicationDisabledUntilTimestamp,
              },
      };
    },

    async guildInfo(guildId): Promise<DiscordGuildInfo | null> {
      const guild = await fetchGuild(guildId);
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
