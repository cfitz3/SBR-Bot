/**
 * `/whois` and `/serverinfo` — the two lookups every Discord server expects,
 * answered by the member-facing bot.
 *
 * `/whois` was two commands. `/userinfo` printed the Discord half, `/avatar`
 * printed one field of it larger, and neither knew whether the account it was
 * describing belonged to a member of this guild — so the question people
 * actually ask ("who is this, and are they one of ours?") took two commands and
 * still did not answer. One card answers it.
 *
 * What a card carries decides who sees it. The Discord half is visible to
 * anyone who clicks the member, so `public:true` posts it. Guild standing and a
 * member's record are not: standing is theirs to publish, and the record port
 * only ever reads the caller's own. Those two sections exist on the private
 * card and nowhere else, which is one rule rather than three conditions.
 */
import { copy } from "@sbr/brand";
import { card, facts, field } from "@sbr/embed-kit";
import type {
  DiscordGuildInfo,
  DiscordUserInfo,
  EmbedView,
  LinkedIdentityDTO,
  MemberRecordDTO,
  ServerActivityDTO,
  XpStandingDTO,
} from "@sbr/shared-types";
import type { CommandHandler, CommandReply, CommandSpec } from "./types.js";
import { flattenEmbed } from "@sbr/shared-types";
import { renderMemberRecordField } from "./render.js";

const E = copy.error;
const C = copy.embed.card;
const F = copy.embed.field;

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
    text: E.surface.discordOnly,
  };
}

/** `<t:1700000000:D> (2y ago)` — absolute for the record, relative to read at a glance. */
function stamp(epochMs: number): string {
  const seconds = Math.floor(epochMs / 1000);
  return `<t:${String(seconds)}:D> (<t:${String(seconds)}:R>)`;
}

/** `2y ago` on its own, for a line that already says what the date is. */
function ago(epochMs: number): string {
  return `<t:${String(Math.floor(epochMs / 1000))}:R>`;
}

/**
 * Whose card to show. The user option wins; otherwise the caller.
 *
 * No IGN path on purpose: this command is about a Discord account, and silently
 * resolving a Minecraft name to whoever last linked it would answer a different
 * question than the one that was asked.
 */
function target(ctx: { readonly userId: string; readonly args: { getUser(name: string): string | null } }): string {
  return ctx.args.getUser("member") ?? ctx.userId;
}

/**
 * Everything `/whois` may add to the Discord half, each part independently
 * absent for its own reason.
 *
 * `undefined` and `null` are different answers throughout and both are used:
 * `undefined` means the section was never asked for — a public card, or a
 * deployment with XP switched off — and is left off entirely, while `null`
 * means it was asked and the answer is "none yet", which is worth printing.
 * Collapsing the two would turn "XP is off here" into "you have earned
 * nothing", and those are not the same claim.
 */
export interface WhoisExtras {
  readonly link?: LinkedIdentityDTO | null;
  readonly standing?: XpStandingDTO | null;
  readonly record?: MemberRecordDTO | null;
}

export function renderWhoisEmbed(
  info: DiscordUserInfo,
  extras: WhoisExtras = {},
  now: Date = new Date(),
): EmbedView {
  const member = info.member;

  // The headline is the membership, because that is the question. A card that
  // led with the account id would make the reader hunt for the one line they
  // came for.
  const headline = [
    member === null
      ? "Not in this server."
      : member.joinedAt === null
        ? "In this server; Discord has no join date for them."
        : `Here since ${ago(member.joinedAt)}.`,
    info.bot ? "A bot account." : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");

  const serverFacts =
    member === null
      ? null
      : facts([
          { label: "Joined", value: member.joinedAt === null ? null : stamp(member.joinedAt) },
          ...(member.nickname === null ? [] : [{ label: "Nickname", value: member.nickname }]),
          ...(member.boostingSince === null
            ? []
            : [{ label: "Boosting since", value: stamp(member.boostingSince) }]),
          ...(member.timedOutUntil !== null && member.timedOutUntil > now.getTime()
            ? [{ label: "Timed out until", value: stamp(member.timedOutUntil) }]
            : []),
        ]);

  // The count leads the value rather than the field name. Discord renders a
  // field name in bold with no room for anything else, so a count parked there
  // reads as part of the label and gives the eye nothing to anchor on.
  const roles = member === null ? null : member.roleIds.slice(0, MAX_ROLES_SHOWN).map((id) => `<@&${id}>`);
  const extraRoles = member === null ? 0 : member.roleIds.length - (roles?.length ?? 0);
  const rolesValue =
    member === null
      ? null
      : member.roleIds.length === 0
        ? C.noRoles
        : `**${String(member.roleIds.length)}** — ${(roles ?? []).join(" ")}${
            extraRoles > 0 ? ` +${String(extraRoles)} more` : ""
          }`;

  return card({
    // The title says what the card is; the author row says who it is about.
    // Linking the title to the avatar is what is left of `/avatar`: the
    // full-size image is one click away and its url is in the text fallback.
    title: C.whois,
    ...(info.avatarUrl === null ? {} : { url: info.avatarUrl }),
    subject: {
      author: { name: info.displayName, ...(info.avatarUrl === null ? {} : { iconUrl: info.avatarUrl }) },
      ...(info.avatarUrl === null ? {} : { thumbnailUrl: info.avatarUrl }),
    },
    headline,
    fields: [
      field(
        F.account,
        facts([
          { label: "Mention", value: `<@${info.id}>` },
          { label: "Id", value: `\`${info.id}\`` },
          { label: "Created", value: stamp(info.createdAt) },
        ]),
        true,
      ),
      serverFacts === null ? null : field(F.thisServer, serverFacts, true),
      rolesValue === null ? null : field(F.roles, rolesValue),
      linkField(extras.link),
      standingField(extras.standing),
      extras.record === undefined || extras.record === null
        ? null
        : renderMemberRecordField(extras.record, now),
    ],
    tone: "INFO",
    timestamp: now.toISOString(),
  });
}

/**
 * Link status, and only ever as a fact about this account.
 *
 * Public on purpose: an IGN is on the roster, on every leaderboard and in guild
 * chat, so naming it here discloses nothing. What it adds is the join between
 * the two identities, which is exactly what somebody reading a Discord name in
 * a channel is trying to work out.
 */
function linkField(link: LinkedIdentityDTO | null | undefined): ReturnType<typeof field> {
  if (link === undefined) return null;
  if (link === null) return field(F.link, C.notLinked);
  const verified = link.verifiedAt === null ? null : `verified ${ago(Date.parse(link.verifiedAt))}`;
  return field(F.link, [`**${link.ign}**`, verified].filter((p): p is string => p !== null).join(" · "));
}

/** Guild standing as one line. `/me` is where the per-source breakdown lives. */
function standingField(standing: XpStandingDTO | null | undefined): ReturnType<typeof field> {
  if (standing === undefined) return null;
  if (standing === null) return field(F.guildStanding, C.noXpYet);
  const parts = [
    `Level **${String(standing.level)}**`,
    `${standing.totalXp.toLocaleString("en-US")} XP`,
    standing.rank === null ? null : `#${String(standing.rank)}`,
    standing.tenureDays === 0 ? null : `${standing.tenureDays.toLocaleString("en-US")} days here`,
  ].filter((part): part is string => part !== null);
  return field(F.guildStanding, parts.join(" · "));
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

const whois: CommandHandler = async (ctx, deps) => {
  if (deps.discord === undefined) return noDiscord();

  const targetId = target(ctx);
  const info = await deps.discord.lookupUser(ctx.guildId, targetId);
  if (info === null) return { ephemeral: true, text: C.noSuchAccount };

  const isPublic = ctx.args.getBoolean("public") === true;
  const self = targetId === ctx.userId;

  // Absorbed individually. A card with the Discord half on it is worth sending
  // when the platform half did not arrive; a card that failed because standing
  // was unreadable would lose the part that never depended on us.
  const link = await deps.identity.resolveByDiscordId(targetId).catch(() => null);
  const linked = link !== null && link.ok ? link.value : null;

  const standing = isPublic || deps.xp === undefined
    ? undefined
    : await deps.xp.standing(ctx.guildId, targetId).catch(() => null);

  // Self only, and by the port's own rule rather than by a check written here:
  // `MemberRecordSource` takes one member's id and has no write path precisely
  // so that a member surface cannot be talked into reading somebody else's.
  const record =
    isPublic || self === false || deps.record === undefined
      ? undefined
      : await deps.record
          .forMember(ctx.guildId, ctx.userId)
          .then((r) => (r.ok ? r.value : null))
          .catch(() => null);

  const embed = renderWhoisEmbed(info, {
    link: linked,
    ...(standing === undefined ? {} : { standing }),
    ...(record === undefined ? {} : { record }),
  });

  // The avatar url rides in the text fallback so the thing `/avatar` existed to
  // hand over is still one copy away, on a surface with no embeds too.
  const text = [flattenEmbed(embed), info.avatarUrl].filter((p): p is string => !!p).join("\n");
  return { ephemeral: !isPublic, text, embed };
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
  if (info === null) return { ephemeral: true, text: E.generic.loadFailed };
  const embed = renderServerInfoEmbed(info, week);
  return { ephemeral: false, text: flattenEmbed(embed), embed };
};

export function infoSpecs(): CommandSpec[] {
  return [
    {
      name: "whois",
      category: "EXTRAS",
      description: "Who a member is here — Discord account, roles, link and standing",
      options: [
        {
          // Discord-only by construction: a chat line can name a player but not
          // a Discord account, so this option cannot be given positionally.
          name: "member",
          description: "Whose card to show (defaults to you)",
          type: "user",
          inGamePositional: false,
        },
        {
          name: "public",
          description: "Post it in the channel. Standing and your record are left off a public card",
          type: "boolean",
          inGamePositional: false,
        },
      ],
      cooldownMs: 5_000,
      handler: whois,
    },
    {
      name: "serverinfo",
      category: "EXTRAS",
      description: "This Discord server at a glance",
      cooldownMs: 10_000,
      handler: serverinfo,
    },
  ];
}
