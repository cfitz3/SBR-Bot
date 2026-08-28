/**
 * `/userinfo`, `/serverinfo`, `/avatar` — the three lookups every Discord
 * server expects to have, answered by the member-facing bot.
 *
 * They read nothing this platform stores: no XP, no infractions, no link. That
 * is the point of keeping them in their own file and behind their own port —
 * they are a view of Discord, which is why an unwired deployment can lose all
 * three without losing anything else, and why a member can run them about
 * anybody without that being a disclosure of guild records. `/me` and
 * `/standing` remain the commands that speak for the platform.
 */
import { copy } from "@sbr/brand";
import { card, facts, field } from "@sbr/embed-kit";
import type { DiscordGuildInfo, DiscordUserInfo, EmbedView, ServerActivityDTO } from "@sbr/shared-types";
import type { CommandHandler, CommandReply, CommandSpec } from "./types.js";
import { flattenEmbed } from "@sbr/shared-types";

/** Discord renders more roles than this as a wall; the count carries the rest. */
const MAX_ROLES_SHOWN = 12;

const C = copy.embed.card;
const F = copy.embed.field;

/** Thousands separators everywhere: these are counts people compare. */
const count = (n: number): string => n.toLocaleString("en-US");

/**
 * The one honest answer when the bot has no gateway.
 *
 * Ephemeral: it is a fact about the deployment, not about the question, and
 * nobody else in the channel needs to read it.
 */
function noDiscord(): CommandReply {
  return {
    ephemeral: true,
    text: "That one only works from Discord — I can't see the server from here.",
  };
}

/** `<t:1700000000:D> (2y ago)` — absolute for the record, relative to read at a glance. */
function stamp(epochMs: number): string {
  const seconds = Math.floor(epochMs / 1000);
  return `<t:${String(seconds)}:D> (<t:${String(seconds)}:R>)`;
}

/**
 * Whose card to show. The user option wins; otherwise the caller.
 *
 * No IGN path on purpose: these commands are about Discord accounts, and
 * silently resolving a Minecraft name to whoever last linked it would answer a
 * different question than the one that was asked.
 */
function target(ctx: { readonly userId: string; readonly args: { getUser(name: string): string | null } }): string {
  return ctx.args.getUser("member") ?? ctx.userId;
}

export function renderUserInfoEmbed(info: DiscordUserInfo): EmbedView {
  const fields = [
    { name: "Account", value: `<@${info.id}>\n\`${info.id}\``, inline: true },
    { name: "Created", value: stamp(info.createdAt), inline: true },
  ];

  const member = info.member;
  if (member === null) {
    // Discord knows them, this server does not. Saying "joined —" would read as
    // a missing date rather than a missing membership, which is the whole fact.
    fields.push({ name: "Membership", value: "Not in this server", inline: true });
  } else {
    fields.push({
      name: "Joined",
      value: member.joinedAt === null ? "Unknown" : stamp(member.joinedAt),
      inline: true,
    });
    if (member.nickname !== null) fields.push({ name: "Nickname", value: member.nickname, inline: true });
    if (member.boostingSince !== null) {
      fields.push({ name: "Boosting since", value: stamp(member.boostingSince), inline: true });
    }
    if (member.timedOutUntil !== null && member.timedOutUntil > Date.now()) {
      fields.push({ name: "Timed out until", value: stamp(member.timedOutUntil), inline: false });
    }
    const shown = member.roleIds.slice(0, MAX_ROLES_SHOWN).map((id) => `<@&${id}>`);
    const extra = member.roleIds.length - shown.length;
    fields.push({
      name: `Roles (${String(member.roleIds.length)})`,
      value:
        shown.length === 0
          ? "None"
          : extra > 0
            ? `${shown.join(" ")} +${String(extra)} more`
            : shown.join(" "),
      inline: false,
    });
  }

  return {
    title: info.displayName,
    ...(info.bot ? { description: "A bot account." } : {}),
    fields,
    color: "INFO",
    ...(info.avatarUrl === null ? {} : { thumbnailUrl: info.avatarUrl }),
  };
}

/**
 * The server card.
 *
 * Two halves from two places, and the card says which is which. Discord knows
 * the server's shape — how many accounts are in it, how many channels and roles
 * it has, when it was made. It does not know how many of those accounts this
 * platform tracks, how many have linked a Minecraft name, or who has been
 * talking, so the week comes from our own counters and is simply absent when a
 * deployment keeps none.
 *
 * Created lives as a fact rather than in the native timestamp: the timestamp
 * says how fresh a reading is, and a server's founding date is neither a
 * reading nor fresh.
 */
export function renderServerInfoEmbed(
  info: DiscordGuildInfo,
  activity?: ServerActivityDTO | null,
): EmbedView {
  const week = activity ?? null;

  return card({
    title: info.name,
    headline: C.serverHeadline.replace("{n}", count(info.memberCount)),
    ...(info.iconUrl === null ? {} : { thumbnailUrl: info.iconUrl }),
    fields: [
      // Our own numbers, and only ours: the Discord count is the headline, so
      // repeating it here would be the card disagreeing with itself about which
      // number the answer is. Tracked is smaller than Discord's count and
      // should be — bots are in one and not the other.
      week === null
        ? null
        : field(
            F.members,
            facts([
              { label: "Tracked here", value: count(week.trackedMembers) },
              { label: "Linked", value: count(week.linkedMembers) },
              { label: "Active this week", value: count(week.activeMembers) },
            ]),
            true,
          ),
      field(
        F.server,
        facts([
          { label: "Channels", value: count(info.channelCount) },
          { label: "Roles", value: count(info.roleCount) },
          { label: "Emoji", value: count(info.emojiCount) },
          { label: "Boosts", value: `${count(info.boostCount)} (tier ${String(info.boostTier)})` },
          { label: "Owner", value: info.ownerId === null ? null : `<@${info.ownerId}>` },
          { label: "Created", value: stamp(info.createdAt) },
        ]),
        true,
      ),
      week === null
        ? field(F.messagesWeek, C.serverNoActivity)
        : field(
            F.messagesWeek,
            facts([
              { label: "Discord", value: count(week.discordMessages) },
              { label: "Guild chat", value: count(week.guildChatMessages) },
            ]),
          ),
      week === null ? null : field(F.busiestWeek, busiest(week)),
    ],
    tone: "INFO",
  });
}

/**
 * The week's loudest member, named the way they would recognise.
 *
 * A mention rather than a stored display name: nicknames change and ours would
 * be the one that is out of date. The IGN rides alongside when they are linked,
 * because half this server knows people by their Minecraft name and not by
 * their Discord one.
 */
function busiest(week: ServerActivityDTO): string {
  const top = week.top;
  if (top === null) return C.serverNobodyActive;
  const who = top.ign === null ? `<@${top.discordId}>` : `<@${top.discordId}> (${top.ign})`;
  const lines = facts([
    { label: "Discord", value: count(top.discordMessages) },
    { label: "Guild chat", value: count(top.guildChatMessages) },
  ]);
  return `${who}\n${lines}`;
}

const userinfo: CommandHandler = async (ctx, deps) => {
  if (deps.discord === undefined) return noDiscord();
  const info = await deps.discord.lookupUser(ctx.guildId, target(ctx));
  if (info === null) return { ephemeral: true, text: "Discord has no account with that id." };
  const embed = renderUserInfoEmbed(info);
  return { ephemeral: false, text: flattenEmbed(embed), embed };
};

const serverinfo: CommandHandler = async (ctx, deps) => {
  if (deps.discord === undefined) return noDiscord();
  // Both halves at once: the week is a database read and the shape is a
  // gateway read, and neither is a reason for the other to wait.
  const [info, week] = await Promise.all([
    deps.discord.guildInfo(ctx.guildId),
    // A counter store that is unwired, or that throws, costs the card its
    // activity section and nothing else.
    deps.serverActivity === undefined
      ? Promise.resolve(null)
      : deps.serverActivity.serverWeek(ctx.guildId).catch(() => null),
  ]);
  if (info === null) return { ephemeral: true, text: "Couldn't read this server. Try /health." };
  const embed = renderServerInfoEmbed(info, week);
  return { ephemeral: false, text: flattenEmbed(embed), embed };
};

const avatar: CommandHandler = async (ctx, deps) => {
  if (deps.discord === undefined) return noDiscord();
  const info = await deps.discord.lookupUser(ctx.guildId, target(ctx));
  if (info === null) return { ephemeral: true, text: "Discord has no account with that id." };
  if (info.avatarUrl === null) {
    return { ephemeral: true, text: `${info.displayName} is using a default Discord avatar.` };
  }
  // The url is the reply. A link in `url` makes the title clickable and gives
  // people the full-size image without a second round trip.
  const embed: EmbedView = {
    title: info.displayName,
    color: "INFO",
    url: info.avatarUrl,
    thumbnailUrl: info.avatarUrl,
  };
  return { ephemeral: false, text: info.avatarUrl, embed };
};

/**
 * Discord-only by construction: every one of them needs the gateway, and the
 * `member` option cannot be given positionally from guild chat because a chat
 * line can name a player but not a Discord account.
 */
const MEMBER_OPTION = {
  name: "member",
  description: "Whose card to show (defaults to you)",
  type: "user" as const,
  inGamePositional: false,
};

export function infoSpecs(): CommandSpec[] {
  return [
    {
      name: "userinfo",
      description: "Discord account details for a member",
      options: [MEMBER_OPTION],
      cooldownMs: 5_000,
      handler: userinfo,
    },
    {
      name: "serverinfo",
      description: "This Discord server at a glance",
      cooldownMs: 10_000,
      handler: serverinfo,
    },
    {
      name: "avatar",
      description: "Someone's Discord avatar, full size",
      options: [MEMBER_OPTION],
      cooldownMs: 5_000,
      handler: avatar,
    },
  ];
}
