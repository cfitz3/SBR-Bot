/**
 * Bridge-bot transports: discord.js (member slash commands + Discord→game relay)
 * and Mineflayer (in-game guild chat → Discord relay). Both feed the shared
 * dispatcher / BridgeService; parsing helpers are pure for tests.
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import { createBot, type Bot } from "mineflayer";
import {
  buildBridgeRegistry,
  communityButtonReplies,
  parseRsvpState,
  readLevelOptOuts,
} from "@sbr/commands-bridge";
import { EchoLedger } from "@sbr/bridge";
import type { ModAckOutcome } from "@sbr/redis";
import {
  ComponentRouter,
  customId,
  interactionArgs,
  respond,
  toActionRow,
  toEmbed,
  toSlashCommands,
} from "@sbr/discord-kit";
import type { GuildRosterDTO, GuildRosterSource } from "@sbr/shared-types";
import { startLevelAnnouncer } from "./levels.js";
import { startGoalWatcher } from "./goals.js";
import { startMilestoneAnnouncer } from "./milestones.js";
import { createAutoresponder } from "./autoresponder.js";
import { createStickyKeeper } from "./sticky.js";
import { startReminderSweeper } from "./reminders.js";
import { greetGuildJoin, startGreeter, type GreeterDeps } from "./welcome.js";
import { deliverEventReminder } from "./events.js";
import { EventBoardGateway } from "./event-board.js";
import { LeaderboardDigest } from "./leaderboard-digest.js";
import type { BridgeApp } from "./composition.js";
import { isRosterEnd, parseGuildOnline } from "./roster.js";
import { acceptCommand, denyCommand, parseJoinEvent, type GuildJoinEvent } from "./join.js";
import { CommandQueue, type CommandOptions } from "./command-queue.js";
import { CommandEcho } from "./command-echo.js";
import { isPunitiveNotice, parseModNotice, type ModNotice } from "./mod-notice.js";
import {
  JOIN_WINDOW_MS,
  JoinQueueService,
  chatLine,
  formatRemaining,
  remainingWindowMs,
  staffReport,
  type AdmitResult,
  type JoinActionFailure,
  type JoinActionResult,
} from "@sbr/screening";
import type { ActionRowView } from "@sbr/shared-types";
import { eventJobRepository, guildRepository } from "@sbr/db";
import { TicketGateway } from "./tickets.js";
import {
  capturedFrom,
  handleTicketModal,
  registerTicketComponents,
  ticketArchivePort,
  ticketConfigPort,
  ticketDiscordPort,
} from "./tickets-discord.js";
import { RoleMenuGateway } from "./role-menus.js";
import { registerRoleMenuComponents, roleMenuMessagePort } from "./role-menus-discord.js";
import { createBridgeRoleEffector } from "./role-effector.js";
import { createDiscordDirectory } from "./directory.js";

export interface GuildChatLine {
  readonly name: string;
  /** The trailing `[Officer]`-style guild rank, when Hypixel included one. */
  readonly rank: string | null;
  readonly message: string;
}

/** Parse a Hypixel guild-chat line into { name, rank, message }, or null. */
export function parseGuildChat(line: string): GuildChatLine | null {
  // e.g. "Guild > [MVP+] Steve [Officer]: anyone for f7?"
  const m = /^Guild > (?:\[[^\]]+\]\s*)?(\w{1,16})(?:\s*\[([^\]]+)\])?:\s?(.+)$/.exec(line);
  if (!m) return null;
  return { name: m[1]!, rank: m[2] ?? null, message: m[3]! };
}

/**
 * The registration payload, derived from the handler registry rather than
 * written out beside it — the two lists used to drift, which is how a command
 * could appear in Discord with no handler behind it.
 */
export function buildCommands(app?: BridgeApp): unknown[] {
  return toSlashCommands(app?.dispatcher.commands ?? buildBridgeRegistry());
}

export function createAutocompleteHandler(app: BridgeApp) {
  return async (i: AutocompleteInteraction): Promise<void> => {
    const focused = i.options.getFocused(true);
    // Resolved to the internal Guild.id, as dispatch does: handlers query by it,
    // and passing the Discord snowflake straight through matched no rows, so
    // guild-scoped suggestions came back empty.
    const guildId = i.guildId ? await app.resolveGuild(i.guildId) : null;
    const choices = await app.dispatcher.autocomplete(
      i.commandName,
      { name: focused.name, value: focused.value },
      // Suggestions are caller-specific (`/setprofile` lists *your* profiles).
      { guildId: guildId ?? "global", userId: i.user.id },
    );
    // A late respond throws "Unknown interaction"; there is nothing to recover.
    await i.respond([...choices]).catch(() => {});
  };
}

export function createInteractionHandler(app: BridgeApp) {
  return async (i: ChatInputCommandInteraction): Promise<void> => {
    const guildId = i.guildId ? await app.resolveGuild(i.guildId) : null;
    // Commands work in DMs too (self stats/link), so fall back to a sentinel guild.
    const reply = await app.dispatcher.dispatch(i.commandName, {
      guildId: guildId ?? "global",
      userId: i.user.id,
      // `/link` matches this against the Hypixel social field, which stores a
      // username rather than a snowflake.
      username: i.user.username,
      // Only when there is one: a command run in a DM has no guild channel.
      ...(i.channelId === null ? {} : { channelId: i.channelId }),
      surface: "BRIDGE_BOT",
      args: interactionArgs(i),
    });
    await respond(i, reply);
  };
}

/**
 * RSVP and run-signup buttons. All the state a press needs lives in the
 * customId, so a button posted last week still routes correctly after a
 * restart — nothing here reads from process memory.
 *
 * Replies are always ephemeral: the shared post already shows the roster, and
 * a public "you joined" per press would bury it.
 */
export function registerCommunityButtons(app: BridgeApp, components: ComponentRouter): void {
  components.register("rsvp", async (interaction, [eventId, rawState]) => {
    const state = parseRsvpState(rawState);
    if (!eventId || state === null) {
      await interaction.reply({ content: "That button is from an older version and no longer works.", ephemeral: true });
      return;
    }
    const reply = await communityButtonReplies.rsvp(eventId, interaction.user.id, state, app.handlerDeps);
    await interaction.reply({ content: reply.text, ephemeral: true });
  });

  components.register("run", async (interaction, [postId, action]) => {
    if (!postId || !action) {
      await interaction.reply({ content: "That button is from an older version and no longer works.", ephemeral: true });
      return;
    }
    // Only `close` needs the guild, and only to decide whether the presser is
    // staff; a failed resolve leaves the author's own close working.
    const guildId = interaction.guildId ? await app.resolveGuild(interaction.guildId).catch(() => null) : null;
    const reply = await communityButtonReplies.run(postId, interaction.user.id, action, guildId, app.handlerDeps);
    await interaction.reply({ content: reply.text, ephemeral: true });
  });
}

/**
 * The Accept / Deny controls on a live join notice.
 *
 * These exist because the five-minute window is shorter than the round trip
 * through a slash command: staff see the notice, and the answer has to be one
 * press away rather than "switch to the admin bot, type the name, hope you
 * spelled it right". All the state a press needs is the IGN in the customId, so
 * a notice still works after a restart — which matters most, since a restart is
 * exactly when a request goes unanswered.
 *
 * Permission is `canManageRoster`, which is the same floor `/join-accept` uses.
 * The check is per press rather than per post: a notice can outlive somebody's
 * staff role, and the button is not a capability token.
 */
export function registerJoinButtons(app: BridgeApp, components: ComponentRouter, queue: JoinQueueService): void {
  components.register("join", async (interaction, [action, ign]) => {
    if (!action || !ign) {
      await interaction.reply({ content: "That button is from an older version and no longer works.", ephemeral: true });
      return;
    }
    const guildId = interaction.guildId ? await app.resolveGuild(interaction.guildId).catch(() => null) : null;
    if (guildId === null) {
      await interaction.reply({ content: "This server isn't registered with the platform.", ephemeral: true });
      return;
    }
    if (!(await app.canManageRoster(guildId, interaction.user.id).catch(() => false))) {
      await interaction.reply({ content: "You don't have permission to answer join requests.", ephemeral: true });
      return;
    }

    // Deferred: both branches type a command into Minecraft behind a paced
    // queue and may read the database first, which is comfortably longer than
    // Discord's three-second reply budget on a bad day.
    await interaction.deferReply({ ephemeral: true });
    const text =
      action === "a"
        ? admitLine(await queue.admit(guildId, ign, interaction.user.id))
        : denyLine(await queue.deny(guildId, ign, interaction.user.id), ign);
    await interaction.editReply({ content: text, allowedMentions: { parse: [] } });
  });
}

/** Why a guild command never left the building. Shared by both button branches. */
function actionFailure(reason: JoinActionFailure): string {
  switch (reason) {
    case "BAD_NAME":
      return "That isn't a Minecraft username, so nothing was sent.";
    case "BAD_DURATION":
      return "That isn't a mute duration (try `30m`), so nothing was sent.";
    case "BAD_REASON":
      return "That reason contains characters we won't type in-game, so nothing was sent.";
    case "NOT_SENT":
      return "The bridge couldn't take the command — it may be offline or backed up. Nothing was sent.";
  }
}

/**
 * The reply to an Accept press.
 *
 * An invite is reported as a different thing from an accept, never as a quieter
 * one: it needs the applicant to act, so a staffer told only "done" would walk
 * away believing somebody is in the guild who is not.
 */
function admitLine(result: AdmitResult): string {
  if (!result.ok) return actionFailure(result.reason);
  if (result.via === "INVITE") {
    return `**${result.ign}**'s request had already expired, so an invite was sent instead. They aren't in the guild until they accept it themselves.`;
  }
  const left = result.remainingMs > 0 ? ` (${formatRemaining(result.remainingMs)})` : "";
  return `Accepted **${result.ign}**${left}.`;
}

function denyLine(result: JoinActionResult, ign: string): string {
  if (!result.ok) return actionFailure(result.reason);
  return `Denied **${result.ign || ign}**.`;
}

/** A text channel this bot can actually post in — i.e. not a partial group DM. */
type SendableChannel = Extract<TextBasedChannel, { send: unknown; messages: unknown }>;

export interface BridgeTransportOptions {
  readonly discordToken: string;
  readonly discordGuildId: string | undefined;
  readonly mc: { host: string; port: number; username: string; version: string } | null;
}

export interface BridgeHandles {
  discord: Client;
  mc: Bot | null;
  /** Register persistent button namespaces (`rsvp`, `run`, …) against this. */
  components: ComponentRouter;
  /** Live `/g online` roster, for `/online`. Answers null while the bridge is down. */
  roster: GuildRosterSource;
  /**
   * Live connection state for the heartbeat the Health page reads.
   *
   * A function rather than a snapshot for the same reason `mc` is a getter:
   * both sockets come and go beneath the handle, and a value captured at boot
   * would report the bridge healthy for as long as the process survived it.
   */
  status(): BridgeStatus;
  /**
   * Queue a moderation command for this bridge's guild. Returns false when the
   * guild does not match or the backlog is full — never throws, because the
   * caller is a Redis subscriber with nobody to report to.
   */
  sendGameCommand(guildId: string, command: string): boolean;
  destroy(): Promise<void>;
}

export interface BridgeStatus {
  readonly discordReady: boolean;
  /** Gateway round-trip in ms; -1 from discord.js before the first heartbeat. */
  readonly gatewayPingMs: number | null;
  /** Configured *and* spawned — a bot mid-reconnect is not a live bridge. */
  readonly mcSpawned: boolean;
  readonly mcConfigured: boolean;
  /**
   * The outbound guild-command queue, flat because the heartbeat carries
   * `Record<string, string | number | boolean | null>` and a nested object
   * would need a parallel encoding on both ends to say the same thing.
   *
   * Rides to Redis through the existing status passthrough, which is what puts
   * "is the relay backed up" in front of an operator instead of leaving it in a
   * log line in whichever process happens to be holding the socket.
   */
  readonly relayQueued: number;
  readonly relaySent: number;
  readonly relayDropped: number;
  readonly relayExpired: number;
  readonly relayEvicted: number;
}

/**
 * How long to keep collecting chat after asking `/g online`. Collection
 * normally ends early on the "Online Members:" line; this only bounds the case
 * where the reply never arrives (muted, kicked mid-request, in limbo).
 */
const ROSTER_TIMEOUT_MS = 4_000;

/**
 * Reuse window for a roster. `/g online` is a command sent from the bridge
 * account, and Hypixel's per-account command limit is strict enough that a
 * handful of members running `/online` at once could get the account silenced —
 * which takes the whole relay down, not just this command. Everyone inside the
 * window shares one answer.
 */
const ROSTER_CACHE_MS = 20_000;

/**
 * Pacing for moderation commands arriving on the bus. The same per-account
 * command limit that motivates `ROSTER_CACHE_MS` applies here, except the
 * caller is a panel operator who could issue a hundred bans in a loop.
 *
 * Backlog is deliberately small: a queue longer than this is not a burst, it is
 * a mistake, and refusing loudly beats silently typing it out over an hour.
 */
const GAME_COMMAND_SPACING_MS = 1_200;
const GAME_COMMAND_BACKLOG = 50;
/** Ten minutes. Beyond that a mute is arriving against a punishment that may already have expired. */
const GAME_COMMAND_MAX_AGE_MS = 10 * 60_000;

/**
 * An answer to a join request: `/g accept Steve`, `/guild deny Steve`.
 *
 * Anchored and shaped tightly enough that it cannot match a kick reason or a
 * relayed chat line containing the word "accept" — the consequence of a false
 * positive is a command that jumps the queue and displaces a punishment.
 */
const JOIN_ANSWER = /^\/(?:g|guild) (?:accept|deny) [A-Za-z0-9_]{1,16}$/i;

/** How long to let Minecraft flush its disconnect before abandoning the wait. */
const MC_QUIT_TIMEOUT_MS = 5_000;

/**
 * Reconnect backoff. Hypixel drops idle or duplicated sessions routinely, and a
 * bridge that stays down after the first disconnect is worse than no bridge —
 * it looks connected from Discord's side while silently relaying nothing.
 *
 * Backoff is exponential and capped: a login loop against Hypixel gets the
 * account rate-limited, so the ceiling matters more than the floor.
 */
const MC_RECONNECT_BASE_MS = 5_000;
const MC_RECONNECT_MAX_MS = 5 * 60_000;

/** Kick reasons arrive as chat-component JSON; flatten to something readable. */
function flattenChat(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason === null || typeof reason !== "object") return String(reason);
  const node = reason as { text?: unknown; extra?: unknown; translate?: unknown };
  const head = typeof node.text === "string" ? node.text : typeof node.translate === "string" ? node.translate : "";
  const tail = Array.isArray(node.extra) ? node.extra.map(flattenChat).join("") : "";
  const flat = `${head}${tail}`.trim();
  return flat.length > 0 ? flat : JSON.stringify(reason);
}

/** How long to wait for the gateway to report ready before giving up. */
const READY_TIMEOUT_MS = 30_000;

/**
 * Publish this bot's slash commands.
 *
 * The application id comes from the authenticated session rather than a
 * configured client id: the two are equal only by convention, and the moment
 * they drift — as they do whenever the bridge and admin bots are distinct
 * Discord applications sharing one DISCORD_CLIENT_ID — Discord answers 20012.
 *
 * Scope follows DISCORD_GUILD_ID. Guild-scoped registrations apply instantly
 * (global ones take up to an hour) and shadow same-named global commands, so a
 * single managed server is better served by them. Note that `put` *replaces*
 * the whole scope: anything previously registered here and no longer in
 * `buildCommands()` disappears.
 */
async function registerCommands(
  app: BridgeApp,
  client: Client<true>,
  token: string,
  discordGuildId: string | undefined,
): Promise<void> {
  const applicationId = client.application.id;
  const rest = new REST().setToken(token);

  if (!discordGuildId) {
    await rest.put(Routes.applicationCommands(applicationId), { body: buildCommands(app) });
    app.log.info("bridge slash commands registered", { applicationId, scope: "global (up to 1h to appear)" });
    return;
  }

  await rest.put(Routes.applicationGuildCommands(applicationId, discordGuildId), { body: buildCommands(app) });
  // Guild and global registrations are separate lists that Discord shows *both*
  // of in the picker, so a leftover global set from an earlier boot appears as a
  // duplicate of every command. Exactly one scope may be populated.
  await rest.put(Routes.applicationCommands(applicationId), { body: [] });
  app.log.info("bridge slash commands registered", { applicationId, scope: `guild ${discordGuildId}` });
}

export async function startBridge(app: BridgeApp, opts: BridgeTransportOptions): Promise<BridgeHandles> {
  // Resolved on demand and then cached, NOT once at boot: the Guild row is often
  // created (`npm run db:seed`) after the bot is already running, and a single
  // boot-time lookup would pin `null` forever — every relayed message silently
  // dropped, with nothing in the logs to say why, until someone restarted.
  let internalGuildId: string | null = null;
  let warnedUnregistered = false;

  async function resolveInternalGuild(): Promise<string | null> {
    if (internalGuildId) return internalGuildId;
    if (!opts.discordGuildId) return null;

    internalGuildId = await app.resolveGuild(opts.discordGuildId);
    if (internalGuildId) {
      app.log.info("bridge guild resolved", { discordGuildId: opts.discordGuildId, guildId: internalGuildId });
    } else if (!warnedUnregistered) {
      warnedUnregistered = true; // once, not once per chat line
      app.log.warn("discord server not registered on the platform — relay is inactive; run `npm run db:seed`", {
        discordGuildId: opts.discordGuildId,
      });
    }
    return internalGuildId;
  }

  /**
   * Where the relay lands, resolved per message rather than captured at boot.
   *
   * The binding is the only source, and it is changed from the panel or
   * `/set-channel` while the bot is running — so a channel move takes effect on
   * the next message rather than the next deploy. The service caches, so this is
   * not a query per chat line. An unbound guild relays nowhere, which is the
   * honest answer: there is no env var to fall back to any more, and a bot
   * quietly posting into a channel nobody configured was the failure the
   * fallback used to cause.
   */
  async function resolveBridgeChannel(guildId: string): Promise<string | null> {
    return app.handlerDeps.config.getChannel(guildId, "bridge");
  }

  const discord = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  const handle = createInteractionHandler(app);
  const complete = createAutocompleteHandler(app);
  // Buttons whose state lives in the customId, so they survive a restart.
  // Namespaces are registered by the domains that own them (RSVP, run sign-up).
  const components = new ComponentRouter({
    onError: (namespace, error) => app.log.error("component handler threw", { namespace, error: String(error) }),
  });
  registerCommunityButtons(app, components);

  // Tickets. Built here rather than in the composition root because every one
  // of its side effects needs the live client, and registered against the same
  // stateless-id router as every other persistent control.
  const tickets = new TicketGateway({
    community: app.handlerDeps.community,
    config: app.handlerDeps.config,
    tickets: ticketConfigPort(),
    archive: ticketArchivePort(),
    discord: ticketDiscordPort(discord, app.log),
    guildName: async (guildId) => (await guildRepository.displayName(guildId)) ?? "this server",
    // The guild-wide half of the staff check, over the same resolver every
    // other capability goes through — so ticket staff are granted on the
    // permissions page rather than only by tagging a Discord role per category.
    capability: (guildId, discordId, capability) =>
      app.handlerDeps.identity.hasCapability(guildId, discordId, capability),
    log: app.log,
  });
  const ticketRouting = {
    gateway: tickets,
    resolveGuild: (discordGuildId: string) => app.resolveGuild(discordGuildId),
    log: app.log,
  };
  registerTicketComponents(components, ticketRouting);
  app.setTickets(tickets);

  // Self-service role menus. The message and the press are this bot's, because
  // members interact with this bot; the grant is a call to the admin bot's
  // effector, which is the only process permitted to write roles.
  const roleMenus = new RoleMenuGateway({
    config: app.handlerDeps.config,
    messages: roleMenuMessagePort(discord, app.log),
    roles: createBridgeRoleEffector({
      baseUrl: app.config.internalApi.baseUrl,
      token: app.config.internalApi.token,
      logger: app.log,
    }),
    log: app.log,
  });
  registerRoleMenuComponents(components, {
    menus: () => roleMenus,
    resolveGuild: (discordGuildId: string) => app.resolveGuild(discordGuildId),
    log: app.log,
  });
  app.setRoleMenus(roleMenus);

  // The tracker board. Like the tickets gateway it needs the live client, and
  // like the reminder sink it posts into the guild's `events` channel — but
  // only when the event has no channel of its own recorded yet, which the
  // gateway decides rather than this wiring.
  app.setEventBoard(
    new EventBoardGateway({
      events: eventJobRepository,
      getChannel: (guildId) => app.handlerDeps.config.getChannel(guildId, "events"),
      discord: {
        async post(channelId, embed) {
          const channel = await discord.channels.fetch(channelId).catch(() => null);
          if (!channel || !channel.isTextBased() || !("send" in channel)) return null;
          const message = await (channel as SendableChannel)
            // The standings are a column of `<@id>` mentions and none of them
            // is a ping: the board is redrawn every half hour and would
            // otherwise notify the top ten each time.
            .send({ embeds: [toEmbed(embed)], allowedMentions: { parse: [] } })
            .catch(() => null);
          return message?.id ?? null;
        },
        async edit(channelId, messageId, embed) {
          const channel = await discord.channels.fetch(channelId).catch(() => null);
          if (!channel || !channel.isTextBased() || !("messages" in channel)) return false;
          const message = await channel.messages.fetch(messageId).catch(() => null);
          if (message === null) return false;
          const edited = await message
            .edit({ embeds: [toEmbed(embed)], allowedMentions: { parse: [] } })
            .catch(() => null);
          return edited !== null;
        },
        async findBoard(channelId, eventId) {
          const channel = await discord.channels.fetch(channelId).catch(() => null);
          if (!channel || !channel.isTextBased() || !("messages" in channel)) return null;
          const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
          if (recent === null) return null;
          // The board stamps `id <eventId>` in its footer, which is what makes
          // one identifiable at all. Restricted to this bot's own messages so a
          // member quoting the id in a footer-shaped line cannot hand us a
          // message we would then try to edit.
          const found = recent.find(
            (m) =>
              m.author.id === discord.user?.id &&
              m.embeds.some((e) => (e.footer?.text ?? "").includes(`id ${eventId}`)),
          );
          return found?.id ?? null;
        },
      },
      log: app.log,
    }),
  );
  // The weekly digest. Same shape as the board above and posted into a
  // different slot — `leaderboard`, which a guild binds to opt in at all.
  //
  // The leaderboard service is an optional port, so the digest exists only when
  // it is installed. Left null the internal route answers 503, which is the
  // honest answer: this deployment cannot rank anybody, rather than nobody
  // ranked this week.
  const digestSource = app.handlerDeps.leaderboards;
  if (digestSource !== undefined) {
    app.setLeaderboardDigest(
      new LeaderboardDigest({
        leaderboards: digestSource,
        getChannel: (guildId) => app.handlerDeps.config.getChannel(guildId, "leaderboard"),
        discord: {
          async post(channelId, embed) {
            const channel = await discord.channels.fetch(channelId).catch(() => null);
            if (!channel || !channel.isTextBased() || !("send" in channel)) return false;
            const message = await (channel as SendableChannel)
              // The rows are IGNs and mentions; none of them is a ping.
              // Notifying the top ten of four boards every Sunday is how a
              // digest channel becomes a muted one.
              .send({ embeds: [toEmbed(embed)], allowedMentions: { parse: [] } })
              .catch(() => null);
            return message !== null;
          },
        },
        log: app.log,
      }),
    );
  }

  // Read-only, and the last of the late-bound ports: `/whois` and `/serverinfo`
  // are a view of Discord itself, so they can only be answered on this side of
  // the line.
  app.setDiscordDirectory(createDiscordDirectory(discord));

  // The moderation log. Automod runs in this process, so this is the only place
  // an automatic punishment can be announced from. Mentions are parsed off: the
  // card names the member it is about, and a mod log that pings somebody every
  // time they are muted is a mod log staff mute.
  app.setModLogPoster(async (channelId, embed) => {
    const channel = await discord.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return false;
    const sent = await channel
      .send({ embeds: [toEmbed(embed)], allowedMentions: { parse: [] } })
      .catch(() => null);
    return sent !== null;
  });

  // The announcer needs a live client, so like the board it is built here and
  // torn down with the transport.
  const announcer = startMilestoneAnnouncer({
    milestones: app.milestones,
    getChannel: (guildId) => app.handlerDeps.config.getChannel(guildId, "milestones"),
    async post(channelId, embed, mentionDiscordId) {
      const channel = await discord.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !("send" in channel)) return false;
      const message = await (channel as SendableChannel)
        .send({
          embeds: [toEmbed(embed)],
          // Only the member being congratulated is pingable. The label comes
          // from guild configuration, and a role or everyone mention typed into
          // one must not become a server-wide ping.
          allowedMentions: mentionDiscordId === null ? { parse: [] } : { users: [mentionDiscordId] },
        })
        .catch(() => null);
      return message !== null;
    },
    log: app.log,
  });

  // Goals reached. Same channel as milestones — a member who set out for
  // something and arrived belongs where the guild already looks for that news.
  const goalWatcher = startGoalWatcher({
    goals: app.goals,
    currentValue: (uuid, metric) => app.goalValue(uuid, metric),
    ignFor: (discordId) => app.ignForDiscordId(discordId),
    getChannel: (guildId) => app.handlerDeps.config.getChannel(guildId, "milestones"),
    async post(channelId, embed, mentionDiscordId) {
      const channel = await discord.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !("send" in channel)) return false;
      const message = await (channel as SendableChannel)
        .send({
          embeds: [toEmbed(embed)],
          allowedMentions: mentionDiscordId === null ? { parse: [] } : { users: [mentionDiscordId] },
        })
        .catch(() => null);
      return message !== null;
    },
    log: app.log,
  });

  // Level-ups ride the same pattern, with one addition: the opt-out list is a
  // guild setting, read once per pass rather than once per row.
  const levelAnnouncer = startLevelAnnouncer({
    levels: app.levelUps,
    getChannel: (guildId) => app.handlerDeps.config.getChannel(guildId, "levels"),
    mutedIds: (guildId) => readLevelOptOuts(app.handlerDeps.config, guildId),
    async post(channelId, embed, mentionDiscordId) {
      const channel = await discord.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !("send" in channel)) return false;
      const message = await (channel as SendableChannel)
        .send({
          embeds: [toEmbed(embed)],
          // The one person being congratulated, and nobody else.
          allowedMentions: { users: [mentionDiscordId] },
        })
        .catch(() => null);
      return message !== null;
    },
    log: app.log,
  });

  // Canned replies, cached per guild: this reads the same store the panel edits
  // and `/tag` posts from.
  const autoresponder = createAutoresponder({ listTags: (guildId) => app.tags.listTags(guildId) });

  // Sticky messages. The keeper is handed to the app because the staff bot's
  // `/sticky` reaches it over the loopback API — the message has to be this
  // bot's, in the channel this bot can see.
  const sticky = createStickyKeeper({
    config: app.handlerDeps.config,
    async post(channelId, content) {
      const channel = await discord.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !("send" in channel)) return null;
      const message = await (channel as SendableChannel)
        .send({
          content,
          // Staff-typed text reposted to a whole channel forever. Nothing in it
          // may ping, or one sticky becomes an @everyone every few minutes.
          allowedMentions: { parse: [] },
        })
        .catch(() => null);
      return message?.id ?? null;
    },
    async remove(channelId, messageId) {
      const channel = await discord.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !("messages" in channel)) return;
      await (channel as SendableChannel).messages.delete(messageId).catch(() => null);
    },
    log: app.log,
  });
  app.setSticky(sticky);

  // Reminders go back to the channel they were set in, so this needs no
  // configuration at all — only a client to post with.
  const reminderSweeper = startReminderSweeper({
    reminders: app.reminders,
    async post(reminder) {
      const channel = await discord.channels.fetch(reminder.channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !("send" in channel)) return false;
      const message = await (channel as SendableChannel)
        .send({
          content: `<@${reminder.discordId}> — ${reminder.text}`,
          // The text is the member's own words. They may address only themselves.
          allowedMentions: { users: [reminder.discordId] },
        })
        .catch(() => null);
      return message !== null;
    },
    log: app.log,
  });

  // Arrivals and departures come from the admin bot, which holds the intent.
  // Started here for the same reason as the announcer: it needs a live client.
  const greeterDeps: GreeterDeps = {
    readSetting: (guildId, key) => app.handlerDeps.config.getSetting(guildId, key),
    getChannel: (guildId, slot) => app.handlerDeps.config.getChannel(guildId, slot),
    lookupProfile: (guildId, discordId) => app.welcomeProfile(guildId, discordId),
    async post(request) {
      const channel = await discord.channels.fetch(request.channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !("send" in channel)) return false;
      // Belt and braces with the renderer's own escaping: the template is
      // written by an admin and the nickname in it is chosen by the person
      // being welcomed, so neither one gets to decide who the server pings.
      const allowedMentions =
        request.mentionDiscordId === null
          ? { parse: [] as never[] }
          : { parse: [] as never[], users: [request.mentionDiscordId] };
      const payload =
        request.mode === "EMBED"
          ? { embeds: [toEmbed({ title: request.title, description: request.text, color: "SUCCESS" })], allowedMentions }
          : { content: request.text, allowedMentions };
      const message = await (channel as SendableChannel).send(payload).catch(() => null);
      if (message === null) return false;

      if (request.deleteAfterSeconds !== null) {
        // Fire and forget, unref'd: a bot that restarts before the timer fires
        // leaves one welcome message behind, which is a far smaller problem
        // than a process kept alive by a queue of pending deletions.
        const timer = setTimeout(() => {
          void message.delete().catch(() => undefined);
        }, request.deleteAfterSeconds * 1_000);
        timer.unref?.();
      }
      return true;
    },
    async dm(discordId, text) {
      const user = await discord.users.fetch(discordId).catch(() => null);
      if (user === null) return false;
      // Closed DMs are the common case, not an error worth a log line each time.
      const sent = await user.send({ content: text, allowedMentions: { parse: [] } }).catch(() => null);
      return sent !== null;
    },
    log: app.log,
  };
  const greeter = await startGreeter(app.memberBus, greeterDeps);

  // Reminders arrive from the workers on the bridge bus; the composition holds
  // the subscription and this is the end of it that can speak.
  app.setEventReminderSink((message) => {
    void deliverEventReminder(
      {
        getChannel: (guildId) => app.handlerDeps.config.getChannel(guildId, "events"),
        async post(channelId, embed, mentionDiscordIds) {
          const channel = await discord.channels.fetch(channelId).catch(() => null);
          if (!channel || !channel.isTextBased() || !("send" in channel)) return false;
          const sent = await (channel as SendableChannel)
            .send({
              ...(mentionDiscordIds.length === 0
                ? {}
                : { content: mentionDiscordIds.map((id) => `<@${id}>`).join(" ") }),
              embeds: [toEmbed(embed)],
              // Only the members who said they were coming. The title is guild
              // configuration and must not be able to become an @everyone.
              allowedMentions: { parse: [], users: [...mentionDiscordIds] },
            })
            .catch(() => null);
          return sent !== null;
        },
        log: app.log,
      },
      message,
    ).catch((error: unknown) => app.log.error("event reminder failed", { error: String(error) }));
  });

  discord.on(Events.InteractionCreate, (i) => {
    // Each branch catches its own failure: an unhandled rejection here would
    // take the process down over a single bad interaction.
    if (i.isChatInputCommand()) {
      void handle(i).catch((e: unknown) => app.log.error("interaction failed", { error: String(e) }));
    } else if (i.isAutocomplete()) {
      void complete(i).catch((e: unknown) => app.log.error("autocomplete failed", { error: String(e) }));
    } else if (i.isButton() || i.isStringSelectMenu()) {
      // Select menus route through the same table: a ticket panel offering more
      // than five categories has to be a menu, and it carries the same kind of
      // stateless id a button does.
      void components.handle(i).catch((e: unknown) => app.log.error("component failed", { error: String(e) }));
    } else if (i.isModalSubmit()) {
      // Modals do not come through the component router — they are not message
      // components — so they are offered to each owner in turn.
      void handleTicketModal(i, ticketRouting).catch((e: unknown) =>
        app.log.error("modal failed", { error: String(e) }),
      );
    }
  });
  discord.once(Events.ClientReady, (c) => app.log.info("bridge discord gateway ready", { tag: c.user.tag }));

  // In-game connector (Mineflayer). Only started with credentials.
  //
  // Held in a box rather than a bare `let`: reconnects reassign it from inside a
  // callback, which control-flow analysis can't see, so a plain binding would
  // stay narrowed to `null` for the rest of the function.
  const session: { bot: Bot | null } = { bot: null };
  // `bot.chat()` reaches through to `client.chat`, which node-minecraft-protocol
  // only installs once the connection reaches PLAY state. Calling it during the
  // handshake — or during a reconnect — throws "bot._client.chat is not a
  // function", so gate outbound chat on having actually spawned.
  let spawned = false;

  /**
   * Lines this bot has said in guild chat whose echo *should* still reach
   * Discord — see the rule in `relayGameToDiscord` below.
   */
  const echo = new EchoLedger();

  /**
   * Say something in guild chat.
   *
   * `expectEcho` decides what happens when Hypixel reflects the line back:
   * `false` (the default) leaves it unregistered, so the self-authored guard
   * drops it — that is the fix for Discord seeing every relayed message twice.
   * `true` registers it so the echo is relayed once, which is how an answer to
   * an in-game `!command` reaches the Discord side that watched it get asked.
   */
  function sayInGuildChat(bot: Bot, line: string, expectEcho = false): void {
    if (!spawned) return;
    if (expectEcho) echo.expect(line);
    bot.chat(`/gc ${line}`);
  }

  /**
   * Moderation commands arriving from the bus, paced.
   *
   * `deliver` reports false while the session is down; the queue then holds the
   * line and retries rather than dropping a punishment on the floor. Everything
   * about the spacing and the backlog lives in `CommandQueue` — see its header
   * for why the newest is dropped on overflow rather than the oldest.
   */
  const gameCommands = new CommandQueue(
    (command) => {
      const bot = session.bot;
      if (bot === null || !spawned) return false;
      bot.chat(command);
      return true;
    },
    { spacingMs: GAME_COMMAND_SPACING_MS, maxBacklog: GAME_COMMAND_BACKLOG, maxAgeMs: GAME_COMMAND_MAX_AGE_MS },
  );

  /**
   * Answers to a join request, which are the only commands here on somebody
   * else's clock.
   *
   * Hypixel honours `/g accept` for five minutes after a request and then
   * forgets it. Every other command the queue carries is a punishment or a rank
   * change that is just as valid a minute later, so they are content to wait
   * behind whatever backlog exists; these are not. Sent late they do not
   * arrive late, they fail — against a screening row the platform has by then
   * marked ACCEPTED.
   *
   * Recognised by inspecting the command rather than carried as a flag because
   * these arrive by two routes — the bridge's own auto-accept, and the Redis
   * bus when a staffer runs `/join-accept` on the admin bot — and a flag would
   * have to be threaded through a published message format that has no field
   * for it. The rule is about the command itself, so it belongs with the queue
   * that paces it.
   */
  function commandUrgency(command: string): CommandOptions {
    return JOIN_ANSWER.test(command) ? { urgent: true, maxAgeMs: JOIN_WINDOW_MS } : {};
  }

  /**
   * Accept a moderation command for this guild.
   *
   * The guild check is not a formality: one Redis instance backs every guild on
   * the platform, and this account has officer permissions in exactly one of
   * them. A command published for someone else's guild must not be typed here.
   *
   * `hooks` is how a punishment finds out what became of its `/g kick`. Staff
   * commands pass nothing: `/guild accept` already reports through its own
   * button, and the boolean below is the answer it wants.
   */
  function sendGameCommand(
    guildId: string,
    command: string,
    hooks: { onSent?: () => void; onExpired?: () => void } = {},
  ): boolean {
    // Strict, including when the guild is unresolved: an unregistered bridge
    // already relays nothing, and "we don't know whose guild this is" is not a
    // reason to type a kick. Same posture as the relay's own inactive state.
    if (internalGuildId === null || guildId !== internalGuildId) {
      app.log.warn("moderation command ignored: not this bridge's guild", { guildId, bridgeGuildId: internalGuildId });
      return false;
    }
    const accepted = gameCommands.push(command, { ...commandUrgency(command), ...hooks });
    if (!accepted) {
      app.log.warn("moderation command dropped: bridge command backlog full", { guildId, ...gameCommands.stats() });
    }
    return accepted;
  }

  /**
   * The door and the roster, as a service the buttons can call.
   *
   * Built here rather than in the composition root because it needs
   * `sendGameCommand`, and that needs the Mineflayer session, which is created
   * from the app rather than alongside it. It holds no session state itself —
   * the sender it closes over resolves the live bot on every call — so a
   * reconnect does not invalidate it.
   */
  const joinControl = new JoinQueueService({
    screening: app.screening,
    commands: { send: (guildId, command) => sendGameCommand(guildId, command) },
    players: app.players,
    logger: app.log,
  });
  registerJoinButtons(app, components, joinControl);

  /**
   * Persist an in-game moderation notice against this bridge's guild.
   *
   * Silently skipped when the guild is unresolved, exactly as the relay is: an
   * unregistered server has no history to write into.
   */
  async function recordNotice(notice: ModNotice): Promise<void> {
    const guildId = await resolveInternalGuild();
    if (guildId === null) return;
    if (!isPunitiveNotice(notice)) return;
    await app.recordInGameAction(guildId, {
      type: notice.kind as "KICK" | "MUTE" | "UNMUTE",
      targetIgn: notice.target,
      actorIgn: notice.actor,
      durationSeconds: notice.durationSeconds,
    });
  }

  /**
   * The second half of the answer: what the guild made of the line.
   *
   * In-process rather than the Redis echo key the plan sketched, because the
   * bridge that types the command is the same process that reads the notice it
   * produces — so the guard and the confirmation are the same piece of state,
   * and a cross-process key would only add a way for them to disagree.
   */
  const commandEcho = new CommandEcho({
    onSettle: (verdict) => {
      void app.ackGameCommand(verdict);
    },
  });

  app.setGameCommandSink((message) => {
    const { guildId, command, correlationId } = message;
    const ack = (outcome: ModAckOutcome, detail: string): void => {
      void app.ackGameCommand({ guildId, correlationId, outcome, detail });
    };
    // Resolve first: until the guild id is known every command would be typed
    // unconditionally, which is the one failure mode the check above exists for.
    void resolveInternalGuild()
      .then(() => {
        const accepted = sendGameCommand(guildId, command, {
          // Typed, not done. The guild's own answer follows on the same
          // correlation id if Hypixel says anything about it.
          onSent: () => {
            commandEcho.watch(guildId, correlationId, command);
            ack("TYPED", `typed in guild chat: ${command}`);
          },
          onExpired: () => { ack("EXPIRED", "discarded untyped: the session never came back in time"); },
        });
        if (!accepted) {
          // Refused rather than delayed, and the caller has to hear which:
          // waiting out a timeout would leave a ban PENDING that was never
          // going to happen at all.
          ack(
            internalGuildId !== null && guildId === internalGuildId ? "REFUSED_BACKLOG" : "WRONG_GUILD",
            internalGuildId !== null && guildId === internalGuildId
              ? "the bridge's outbound command queue is full"
              : "this is not the bridge for that guild",
          );
        }
      })
      .catch((error: unknown) => {
        app.log.error("moderation command failed", { guildId, error: String(error) });
        ack("WRONG_GUILD", `the bridge could not resolve its guild (${String(error)})`);
      });
  });

  /**
   * Was this guild-chat line said by the bridge account itself?
   *
   * `bot.username` rather than the configured `MC_USERNAME`: with Microsoft
   * auth the configured value is an email address, and the IGN Hypixel prints
   * is only known once the session has logged in.
   */
  function isSelf(bot: Bot, name: string): boolean {
    const self = bot.username;
    return typeof self === "string" && self.toLowerCase() === name.toLowerCase();
  }

  // ── `/g online` roster ────────────────────────────────────────────────────
  //
  // Hypixel answers `/g online` as a block of server messages rather than a
  // packet we can request, so reading it means asking in chat and collecting
  // what comes back. One capture at a time, ended by the block's own last line
  // (or a timeout, if the reply never lands).
  let rosterCapture: { lines: string[]; finish: () => void } | null = null;
  let rosterCached: { roster: GuildRosterDTO; at: number } | null = null;
  let rosterInflight: Promise<GuildRosterDTO | null> | null = null;

  function captureRosterLine(line: string): void {
    const capture = rosterCapture;
    if (!capture) return;
    capture.lines.push(line);
    if (isRosterEnd(line)) capture.finish();
  }

  async function requestRoster(bot: Bot): Promise<GuildRosterDTO | null> {
    const lines: string[] = [];
    const collected = await new Promise<readonly string[]>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rosterCapture = null;
        resolve(lines);
      };
      const timer = setTimeout(finish, ROSTER_TIMEOUT_MS);
      timer.unref();

      rosterCapture = { lines, finish };
      try {
        bot.chat("/g online");
      } catch (error) {
        app.log.warn("roster request failed to send", {
          error: error instanceof Error ? error.message : String(error),
        });
        finish();
      }
    });

    const roster = parseGuildOnline(collected);
    if (roster === null) {
      app.log.warn("roster request produced nothing readable", { lines: collected.length });
      return null;
    }
    rosterCached = { roster, at: Date.now() };
    return roster;
  }

  /**
   * Single-flight and short-lived cache. Both exist to protect the bridge
   * account: several members running `/online` at once must cost Hypixel one
   * command, not one each.
   */
  const rosterSource: GuildRosterSource = {
    async online(): Promise<GuildRosterDTO | null> {
      const cached = rosterCached;
      if (cached && Date.now() - cached.at < ROSTER_CACHE_MS) return cached.roster;
      if (rosterInflight) return rosterInflight;

      const bot = session.bot;
      // Honest null rather than a stale roster: "the bridge is down" is a
      // different answer from "here is who was online a while ago".
      if (!bot || !spawned) return null;

      const run = requestRoster(bot);
      rosterInflight = run;
      try {
        return await run;
      } finally {
        rosterInflight = null;
      }
    },
  };

  // Set once `destroy()` runs, so a deliberate shutdown isn't mistaken for a
  // dropped connection and answered with a reconnect.
  let stopping = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let attempts = 0;

  function connectMinecraft(mcOpts: NonNullable<BridgeTransportOptions["mc"]>): void {
    app.log.info("minecraft connecting", {
      host: mcOpts.host,
      port: mcOpts.port,
      // The pinned version is the single most useful line here when the bridge
      // won't stay up, so it goes in the connect log rather than only in config.
      version: mcOpts.version,
      attempt: attempts + 1,
    });

    const bot = createBot({
      host: mcOpts.host,
      port: mcOpts.port,
      username: mcOpts.username,
      auth: "microsoft",
      // Pinned, not negotiated — see BridgeTransportOptions.mc.version.
      version: mcOpts.version,
    });
    session.bot = bot;

    // One packet is not one line.
    //
    // Hypixel sends its framed announcements — the join request, the `/g online`
    // reply, the guild-info block — as a *single* chat packet whose text carries
    // embedded newlines. Mineflayer hands that to `messagestr` as one string, and
    // every parser below reads a line: they anchor with `^…$`, and the roster
    // collector counts entries. Fed the whole block they all matched nothing, and
    // matched nothing *silently* — which is why a join request produced no log,
    // no lookup and no accept.
    //
    // So the packet is split here, once, and each line is read on its own. This
    // is the right altitude for it: every parser downstream is line-shaped, and
    // fixing them individually would leave the next one to be written with the
    // same trap in it.
    bot.on("messagestr", (str: string) => {
      for (const line of str.split(/\r?\n/)) handleChatLine(bot, line);
    });

    function handleChatLine(bot: Bot, str: string): void {
      // Roster capture takes every line, guild chat or not: the `/g online`
      // reply is a server message block, not chat, so it never parses as chat.
      captureRosterLine(str);

      // Join notices are server messages too, so this must come before the
      // guild-chat parse rather than inside it.
      const join = parseJoinEvent(str);
      if (join) {
        // Logged the moment it is recognised, before any lookup can fail. The
        // original bug was indistinguishable from "nobody has asked to join":
        // this line is what tells the two apart next time.
        app.log.info("guild join event seen", { kind: join.kind, ign: join.ign });
        relay("join-screening", () => handleJoin(bot, join));
        return;
      }

      // Hypixel's own moderation notices. Also server messages, so they are
      // read before the chat parse and never reach the relay — a kick notice
      // belongs in the audit log, not repeated into the Discord channel.
      // Was this the guild answering a command we typed? `observe` settles the
      // waiting punishment either way, and returning true means the line is our
      // own kick coming back — which must not also be recorded as somebody's
      // in-game decision, or a Discord ban becomes two punishments.
      if (commandEcho.observe(str)) return;

      const notice = parseModNotice(str);
      if (notice !== null && isPunitiveNotice(notice)) {
        if (notice.kind === "KICK" && commandEcho.claimedKick(notice.target)) {
          app.log.debug("suppressed our own guild kick notice", { target: notice.target });
          return;
        }
        relay("ingame-moderation", () => recordNotice(notice));
        return;
      }

      const parsed = parseGuildChat(str);
      if (!parsed) return;

      // Hypixel reflects this account's own guild chat back to it. Relayed as
      // though it were somebody else's, that is what put every Discord message
      // in the channel twice — once from its author and once from the bridge.
      //
      // So self-authored chat is dropped, except for lines registered before
      // sending (in-game command answers), which pass through once.
      if (isSelf(bot, parsed.name) && !echo.claim(parsed.message)) {
        app.log.debug("suppressed own guild-chat echo", { message: parsed.message });
        return;
      }

      relay("game→discord", async () => {
        const guildId = await resolveInternalGuild();
        if (guildId) await relayGameToDiscord(app, discord, await resolveBridgeChannel(guildId), guildId, parsed);
      });
      // Guild chat counts towards XP whether or not it relays anywhere — the
      // bridge channel binding is a routing decision, not a statement about who
      // was talking.
      relay("xp:guild-chat", async () => {
        const guildId = await resolveInternalGuild();
        if (guildId) await app.creditGuildChat(guildId, parsed.name, parsed.message);
      });
      // A `!` line is still chat, so it relays above as well as running here —
      // otherwise Discord sees an answer to a question it never saw asked.
      relay("ingame-command", async () => {
        const guildId = await resolveInternalGuild();
        if (!guildId) return;
        const answer = await app.inGame.handle(guildId, parsed.name, parsed.message);
        // null is the common case: not a command, unknown, or on cooldown.
        if (answer === null) return;
        // The answer's own echo *is* wanted on the Discord side — it is the
        // reply to a question Discord watched somebody ask in guild chat.
        sayInGuildChat(bot, answer, true);
      });
    }
    bot.on("spawn", () => {
      spawned = true;
      // Only a successful spawn clears the backoff. Resetting on connect would
      // turn a login that dies before PLAY — exactly the 1.21-vs-1.8 failure —
      // into an un-backed-off hot loop.
      attempts = 0;
      app.log.info("minecraft spawned — in-game relay is live");
    });
    bot.on("error", (e: Error) => app.log.error("mineflayer error", { error: e.message }));
    bot.on("kicked", (reason: unknown) => app.log.warn("minecraft kicked", { reason: flattenChat(reason) }));
    bot.on("end", (reason: string) => {
      spawned = false;
      app.log.info("minecraft disconnected", { reason });
      scheduleReconnect(mcOpts, reason);
    });
  }

  function scheduleReconnect(mcOpts: NonNullable<BridgeTransportOptions["mc"]>, reason: string): void {
    if (stopping || reconnectTimer !== null) return;

    const delay = Math.min(MC_RECONNECT_BASE_MS * 2 ** attempts, MC_RECONNECT_MAX_MS);
    attempts += 1;
    app.log.warn("minecraft reconnecting", { reason, delayMs: delay, attempt: attempts });

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopping) return;
      try {
        connectMinecraft(mcOpts);
      } catch (error) {
        // createBot throws synchronously on a bad version or unresolvable host.
        // Log and let the next disconnect-free path be the backoff itself.
        app.log.error("minecraft reconnect failed to start", {
          error: error instanceof Error ? error.message : String(error),
        });
        scheduleReconnect(mcOpts, "reconnect threw");
      }
    }, delay);
    reconnectTimer.unref();
  }

  if (opts.mc) connectMinecraft(opts.mc);

  // An edited or deleted message is stamped, never rewritten away: a transcript
  // that silently drops what somebody deleted reads as a complete record of a
  // conversation that did not happen that way. Both are best-effort — an
  // uncached message from before the last restart has no content to compare.
  discord.on(Events.MessageUpdate, (_before, after) => {
    relay("tickets:edit", async () => {
      // A partial is an edit to a message from before this process started:
      // we hold no content to record, and guessing "" would erase what the
      // transcript already has.
      if (after.partial) return;
      await tickets.captureEdit(after.id, after.content);
    });
  });
  discord.on(Events.MessageDelete, (message) => {
    relay("tickets:delete", async () => {
      await tickets.captureDelete(message.id);
    });
  });

  // Discord → in-game relay (only messages in the configured bridge channel).
  discord.on(Events.MessageCreate, (msg: Message) => {
    const bot = session.bot;
    if (msg.author.bot || !bot) return;
    relay("xp:discord-message", async () => {
      const guildId = await resolveInternalGuild();
      // Counted before the bridge-channel check on purpose: a message anywhere
      // in the server is Discord activity, and only the *relay* cares which
      // channel it was in.
      if (guildId) await app.creditDiscordMessage(guildId, msg.author.id, msg.content);
    });

    // Automod, ahead of the relay branch and outside it: a rule an admin wrote
    // to stop invite spam should stop it in every channel, not only in the one
    // wired to guild chat. Deleting the message is this handler's job because
    // it is the only place holding the Discord message object; issuing any
    // punishment is the runner's, through the same service `/warn` uses.
    relay("automod:discord", async () => {
      const guildId = await resolveInternalGuild();
      if (!guildId) return;
      const outcome = await app.automod.run({
        guildId,
        surface: "DISCORD",
        text: msg.content,
        // Everyone actually pinged, deduplicated by Discord itself — an @here
        // that reaches two hundred people is one mention, and counting the raw
        // `<@…>` tokens would say otherwise.
        mentionCount: msg.mentions.users.size + msg.mentions.roles.size,
        subject: {
          key: msg.author.id,
          discordId: msg.author.id,
          roleIds: msg.member?.roles.cache.map((role) => role.id) ?? [],
          capabilities: [],
        },
      });
      if (!outcome.blocked) return;
      // Best-effort: the member may have deleted it first, or the bot may not
      // hold Manage Messages here. Either way the match is already recorded.
      await msg.delete().catch((error: unknown) => {
        app.log.warn("automod could not delete a message", { messageId: msg.id, error: String(error) });
      });
    });

    // Transcripts. Cheap for the 99.9% of messages that are not in a ticket:
    // one indexed lookup by channel id and nothing else. Bot messages are
    // captured too — the greeting is part of the conversation — but never count
    // as a staff reply, which is what `fromBot` is for.
    relay("tickets:capture", async () => {
      // Capture and autorespond share a hop because they share the expensive
      // half: `capture` already resolves whether this channel is a ticket, and
      // that answer is exactly what decides which tags are allowed to fire
      // here. Asking twice would double the per-message database work for a
      // feature most messages never touch.
      const inTicket = await tickets.capture(capturedFrom(msg));
      const guildId = await resolveInternalGuild();
      if (!guildId) return;
      const answer = await autoresponder.respond(
        guildId,
        msg.channelId,
        msg.content,
        inTicket ? "TICKET" : "SERVER",
      );
      if (answer === null) return;
      await msg
        .reply({
          content: answer,
          // The reply text is written by staff in the panel. It answers a
          // member, so it may ping the one it is replying to and nobody else.
          allowedMentions: { repliedUser: true, parse: [] },
        })
        .catch((error: unknown) => {
          app.log.warn("autoresponse did not land", { messageId: msg.id, error: String(error) });
        });
    });

    // Sticky messages: keep the channel's note at the bottom. Skipped for bot
    // messages, the sticky itself first among them — a sticky that reacted to
    // its own arrival would repost forever.
    if (!msg.author.bot) {
      relay("sticky:repost", async () => {
        const guildId = await resolveInternalGuild();
        if (!guildId) return;
        await sticky.onMessage(guildId, msg.channelId);
      });
    }

    relay("discord→game", async () => {
      const guildId = await resolveInternalGuild();
      if (!guildId) return;
      // Channel check moved inside the hop because the binding is per guild and
      // read asynchronously; an unbound guild relays nothing rather than
      // relaying every channel it can see.
      const bridgeChannelId = await resolveBridgeChannel(guildId);
      if (bridgeChannelId === null || msg.channelId !== bridgeChannelId) return;
      if (!spawned) {
        app.log.warn("dropped discord→game message: not connected in-game yet", { messageId: msg.id });
        return;
      }
      await relayDiscordToGame(app, guildId, msg, (line) => sayInGuildChat(bot, line));
    });
  });

  // ── join screening ────────────────────────────────────────────────────────
  //
  // Hypixel prints the request notice to everyone with the invite permission,
  // and prints it again if the applicant retries. `seenRecently` collapses that
  // to one screening: a duplicate would double the Hypixel and SkyKings calls
  // and post the staff report twice for one person.
  const recentJoins = new Map<string, number>();
  const JOIN_DEDUPE_MS = 60_000;

  function seenRecently(key: string): boolean {
    const now = Date.now();
    for (const [k, at] of recentJoins) if (now - at > JOIN_DEDUPE_MS) recentJoins.delete(k);
    if (recentJoins.has(key)) return true;
    recentJoins.set(key, now);
    return false;
  }

  /**
   * The Accept / Deny controls for one live request.
   *
   * The IGN is the only state carried, because it is the only state the answer
   * needs — the row is looked up when the button is pressed, not when it is
   * posted. That keeps the notice correct if the row is decided in the meantime
   * by somebody else, or by the expiry sweep.
   */
  function joinControls(ign: string): ActionRowView {
    return {
      buttons: [
        { label: "Accept", style: "SUCCESS", customId: customId("join", "a", ign) },
        { label: "Deny", style: "DANGER", customId: customId("join", "d", ign) },
      ],
    };
  }

  /**
   * The deadline, as Discord's own relative timestamp.
   *
   * Rendered client-side, so it keeps counting down in a channel nobody is
   * refreshing — which is the whole point. Measured from when we saw the
   * request rather than from the stored row: the two are within a second of
   * each other, and this path has to work when there is no row at all.
   */
  function deadlineLine(seenAt: number): string {
    return `Expires <t:${Math.floor((seenAt + JOIN_WINDOW_MS) / 1_000)}:R> — after that they can only be invited.`;
  }

  /**
   * Screen a join request, or record a completed join.
   *
   * Nothing here throws into the chat handler: `relay` catches, and every step
   * that could fail is allowed to leave the rest working. A failure to post the
   * staff report only costs the report, because the row is already written.
   *
   * A name we cannot resolve no longer ends the matter. It ends the *screening*
   * — we will not auto-accept somebody we could not identify — but the request
   * is real and running on a five-minute clock, so staff still get a notice
   * they can act on. Silently returning was the older behaviour, and it meant a
   * Mojang outage looked exactly like nobody having asked to join.
   */
  async function handleJoin(bot: Bot, event: GuildJoinEvent): Promise<void> {
    if (seenRecently(`${event.kind}:${event.ign.toLowerCase()}`)) return;

    // Captured before any awaits: everything below is measured against the
    // moment the request appeared in chat, which is when Hypixel's clock
    // started — not the moment we finished thinking about it.
    const seenAt = Date.now();

    const guildId = await resolveInternalGuild();
    if (!guildId) return;

    const resolved = await app.handlerDeps.players.resolveIgn(event.ign);
    if (!resolved) {
      app.log.warn("join event for an unresolvable name — not screened", { ign: event.ign, kind: event.kind });
      if (event.kind !== "JOINED") {
        await postStaffReport(
          guildId,
          [
            `**Join request from ${event.ign}.**`,
            "We couldn't look up that account, so no screening ran — decide from what you know.",
            deadlineLine(seenAt),
          ].join("\n"),
          [joinControls(event.ign)],
        );
      }
      return;
    }

    // Somebody who is already in is not a candidate for a gate. The screening
    // is still run and recorded, because "who joined, and what did they look
    // like at the time" is the metric this feature exists to capture — it is
    // only the accept/deny half that does not apply.
    const { screening, id, shouldAccept } = await app.screening.screen({
      guildId,
      uuid: resolved.uuid,
      ign: resolved.ign,
    });

    if (event.kind === "JOINED") {
      await app.screening.decide(id, "JOINED", "AUTO");
      await postStaffReport(guildId, `**${resolved.ign} joined the guild.**\n${staffReport(screening)}`);
      // The staff report is the record; this is the greeting, and it is the
      // guild's to switch on. Best effort on purpose — a welcome that did not
      // land must not make the platform think the join went unhandled.
      const linkedDiscordId = await app.linkedDiscordIdForIgn(resolved.ign);
      await greetGuildJoin(
        { guildId, ign: resolved.ign, guildRank: null, discordId: linkedDiscordId },
        greeterDeps,
      ).catch((error: unknown) => {
        app.log.warn("guild join greeting failed", { ign: resolved.ign, error: String(error) });
        return false;
      });
      return;
    }

    // Raw commands, not `/gc`: these are instructions to Hypixel, not lines of
    // guild chat, so they must not go through the echo-suppressing sender.
    //
    // They go through the same paced queue every other game command uses, and
    // they used to go through `bot.chat` directly. That was wrong twice over: a
    // burst of applicants could out-run Hypixel's command limit and silence the
    // account the whole relay depends on, and a request that arrived while the
    // session was down was dropped on the floor *after* the row had already
    // been marked ACCEPTED — the platform's record then said "accepted" about
    // somebody Hypixel had never heard us accept. The queue holds the command
    // through a reconnect instead, and the outcome is only recorded once the
    // command is on its way.
    if (shouldAccept) {
      if (sendGameCommand(guildId, acceptCommand(resolved.ign))) {
        await app.screening.decide(id, "ACCEPTED", "AUTO");
        // The number that decides whether this feature works at all: screening
        // reads three third parties and the send is paced behind a queue. If it
        // creeps towards the window then the budget or the pacing is wrong, and
        // a log line is how anyone would ever find out.
        app.log.info("auto-accepted inside the join window", {
          ign: resolved.ign,
          decisionMs: Date.now() - seenAt,
          windowMs: JOIN_WINDOW_MS,
        });
      } else {
        app.log.warn("auto-accept could not be queued; left pending for staff", { ign: resolved.ign });
      }
    } else if (screening.verdict === "DENY") {
      // Denying in-game as well as on the row. Recording DENIED without sending
      // the command left the applicant sitting in Hypixel's request queue for
      // whoever logged in next to accept by hand, against our own decision.
      if (sendGameCommand(guildId, denyCommand(resolved.ign))) {
        await app.screening.decide(id, "DENIED", "AUTO");
      } else {
        app.log.warn("auto-deny could not be queued; left pending for staff", { ign: resolved.ign });
      }
    }

    // The public line is deliberately vague — see `chatLine`. Said only when we
    // actually acted, so a request quietly queued for staff does not announce
    // itself to the guild.
    const answered = shouldAccept || screening.verdict === "DENY";
    if (answered) {
      sayInGuildChat(bot, chatLine(screening), true);
    }

    // Buttons only on a request still waiting for an answer. Offering them on
    // one we have already answered invites a second command against a row that
    // is no longer PENDING, which Hypixel refuses — loudly, in guild chat.
    const heading = shouldAccept
      ? `**Auto-accepted ${resolved.ign}.**`
      : `**Join request from ${resolved.ign} — ${screening.verdict.toLowerCase()}.**`;
    const lines = answered ? [heading] : [heading, deadlineLine(seenAt)];
    await postStaffReport(
      guildId,
      [...lines, staffReport(screening)].join("\n"),
      answered ? undefined : [joinControls(resolved.ign)],
    );
  }

  /**
   * Post to the guild's `staff` channel. Silent when the slot is unbound: a
   * guild that has not configured one still gets screening, recorded and
   * decided, it just has nowhere for the write-up to go.
   */
  async function postStaffReport(
    guildId: string,
    content: string,
    components?: readonly ActionRowView[],
  ): Promise<void> {
    const channelId = await app.handlerDeps.config.getChannel(guildId, "staff");
    if (!channelId) return;
    const channel = await discord.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return;
    // The report quotes a stranger's IGN and a third-party listing reason,
    // neither of which we control; mentions stay unparsed.
    await channel
      .send({
        content,
        allowedMentions: { parse: [] },
        ...(components?.length ? { components: components.map(toActionRow) } : {}),
      })
      .catch((e: unknown) => {
        app.log.warn("could not post screening report", { error: String(e) });
      });
  }

  /**
   * Run a relay hop detached from its event handler. Without the catch, one bad
   * message becomes an unhandled rejection and Node takes the whole bot down —
   * a chat line is never worth losing the process over.
   */
  function relay(direction: string, hop: () => Promise<void>): void {
    void hop().catch((error: unknown) => {
      app.log.error("relay failed", { direction, error: error instanceof Error ? error.message : String(error) });
    });
  }

  const ready = new Promise<Client<true>>((resolve, reject) => {
    discord.once(Events.ClientReady, resolve);
    const timer = setTimeout(
      () => reject(new Error(`gateway did not become ready within ${READY_TIMEOUT_MS}ms`)),
      READY_TIMEOUT_MS,
    );
    timer.unref();
  });

  try {
    await discord.login(opts.discordToken);
    const readyClient = await ready;
    await registerCommands(app, readyClient, opts.discordToken, opts.discordGuildId);
  } catch (error) {
    // Release the gateway socket and the Minecraft session before the error
    // propagates — otherwise a failed start leaves the account logged in.
    // `stopping` first, or ending the bot here would schedule a reconnect for a
    // process that is on its way out.
    stopping = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    await discord.destroy().catch(() => {});
    session.bot?.end("startup failed");
    throw error;
  }

  return {
    discord,
    // A getter, not a snapshot: reconnects replace the bot instance, and a
    // stale handle would send chat into a dead socket.
    get mc() {
      return session.bot;
    },
    components,
    roster: rosterSource,
    status() {
      const ping = discord.ws.ping;
      const stats = gameCommands.stats();
      return {
        discordReady: discord.isReady(),
        // discord.js reports -1 until the first gateway heartbeat lands;
        // forwarding that verbatim would render as a negative latency.
        gatewayPingMs: Number.isFinite(ping) && ping >= 0 ? Math.round(ping) : null,
        mcSpawned: spawned,
        mcConfigured: opts.mc !== null,
        relayQueued: stats.queued,
        relaySent: stats.sent,
        relayDropped: stats.dropped,
        relayExpired: stats.expired,
        relayEvicted: stats.evicted,
      };
    },
    sendGameCommand,
    async destroy() {
      // Stop reconnecting before closing anything, so the `end` this triggers
      // isn't answered with a fresh login.
      announcer.stop();
      levelAnnouncer.stop();
      goalWatcher.stop();
      reminderSweeper.stop();
      void greeter.stop().catch(() => undefined);
      // Detach first: the bus keeps delivering until the process exits, and a
      // sink pointing at a queue whose session is closing would just age out.
      app.setGameCommandSink(null);
      app.setEventReminderSink(null);
      app.setModLogPoster(null);
      // The board gateway holds the client this is about to destroy; a board
      // pass arriving after it should be told "not ready", not handed a corpse.
      app.setEventBoard(null);
      app.setLeaderboardDigest(null);
      stopping = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      await discord.destroy().catch(() => {});
      if (!session.bot) return;

      // `quit()` only *queues* the disconnect; it returns before the packet is
      // written. Exiting straight after left the account logged in on Hypixel
      // until the server timed the ghost session out, so wait for the socket to
      // actually end (bounded, in case the server never replies).
      const bot = session.bot;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          app.log.warn("minecraft did not close within timeout — forcing socket end");
          try {
            bot.end("shutdown timeout");
          } catch {
            /* already gone */
          }
          finish();
        }, MC_QUIT_TIMEOUT_MS);

        bot.once("end", finish);
        try {
          bot.quit("shutting down");
        } catch {
          finish(); // never connected, or already disconnected
        }
      });
    },
  };
}

async function relayGameToDiscord(
  app: BridgeApp,
  discord: Client,
  bridgeChannelId: string | null,
  guildId: string,
  parsed: GuildChatLine,
): Promise<void> {
  const decision = await app.bridge.processInbound({
    guildId,
    direction: "GAME_TO_DISCORD",
    authorId: parsed.name,
    authorName: parsed.name,
    authorRank: parsed.rank,
    content: parsed.message,
  });
  if (decision.action !== "DELIVER" || !bridgeChannelId) return;
  const channel = await discord.channels.fetch(bridgeChannelId).catch(() => null);
  if (channel && channel.isTextBased() && "send" in channel) {
    // Guild rank included per BRIDGE_BOT.md §3.2 — it is how a Discord reader
    // tells an officer's word from anyone else's. Wrapped in backticks rather
    // than another bold run so it reads as a badge, not part of the name.
    const rank = parsed.rank ? ` \`${parsed.rank.replace(/`/g, "")}\`` : "";
    await channel.send({
      content: `**${parsed.name}**${rank}: ${decision.formatted}`,
      // The relay carries text typed by anyone in the Hypixel guild. `formatRelay`
      // already defangs the mention syntax; this is the layer that holds when the
      // regex misses a form, because Discord will not resolve a ping the API was
      // told not to parse regardless of what the content looks like.
      allowedMentions: { parse: [] },
    });
  }
}

/**
 * `send` rather than a Bot, so the relay goes out through the one sender that
 * knows about echo suppression. A direct `bot.chat` here is exactly the bug
 * this pass fixed — the line would come straight back and be posted to Discord
 * a second time under the bot's name.
 */
async function relayDiscordToGame(
  app: BridgeApp,
  guildId: string,
  msg: Message,
  send: (line: string) => void,
): Promise<void> {
  const decision = await app.bridge.processInbound({
    guildId,
    direction: "DISCORD_TO_GAME",
    authorId: msg.author.id,
    authorName: msg.member?.displayName ?? msg.author.username,
    content: msg.content,
    // What the gateway sees right now, so the guard can tell "this person is
    // not a member" from "the member scan has not run yet". `msg.member` is
    // present for any message sent in a server the bot is in.
    live: {
      isGuildMember: msg.member !== null,
      roleIds: msg.member?.roles.cache.map((role) => role.id) ?? [],
    },
  });
  if (decision.action === "DELIVER") {
    send(decision.formatted);
    return;
  }
  // Every other drop reason is deliberately silent — a shadow-mute that
  // announced itself would not be one, and a muted member already knows. But
  // `NO_PERMISSION` is now the common answer for a guild member who simply has
  // not linked yet, and a message that vanishes with no explanation reads as
  // the bridge being broken.
  if (decision.reason === "NO_PERMISSION") await hintUnlinked(app, msg);
}

/** How long a hint stays before deleting itself, and how long until the next one. */
const HINT_TTL_MS = 20_000;
const HINT_COOLDOWN_MS = 30 * 60_000;

/** Last hint per author. In memory on purpose: a restart re-showing it is free. */
const lastHintAt = new Map<string, number>();

/**
 * Tell somebody why their message did not cross, once every half hour at most.
 *
 * Throttled and self-deleting because the alternative is a bridge channel full
 * of bot replies the moment a non-member starts talking — which is the same
 * noise the drop was avoiding, just louder.
 */
async function hintUnlinked(app: BridgeApp, msg: Message): Promise<void> {
  const now = Date.now();
  const previous = lastHintAt.get(msg.author.id);
  if (previous !== undefined && now - previous < HINT_COOLDOWN_MS) return;
  lastHintAt.set(msg.author.id, now);
  // Bounded: the map would otherwise grow by one entry per person who ever
  // spoke here and never shrink.
  if (lastHintAt.size > 500) {
    for (const [id, at] of lastHintAt) if (now - at >= HINT_COOLDOWN_MS) lastHintAt.delete(id);
  }

  const sent = await msg
    .reply({
      content:
        "That did not reach guild chat — the bridge only carries messages from guild members. " +
        "Run `/link` to connect your Minecraft account, then try again.",
      allowedMentions: { repliedUser: false },
    })
    .catch(() => null);
  if (sent === null) {
    // Missing Send Messages in the bridge channel is the usual cause, and it is
    // worth saying out loud: from the member's side the bridge just eats input.
    app.log.warn("could not explain a refused relay", { channelId: msg.channelId });
    return;
  }
  setTimeout(() => void sent.delete().catch(() => {}), HINT_TTL_MS).unref();
}
