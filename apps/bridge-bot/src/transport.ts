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
  lfgButtons,
  parseRsvpState,
  renderLfgEmbed,
  type LfgBoard,
} from "@sbr/commands-bridge";
import { EchoLedger } from "@sbr/bridge";
import { ComponentRouter, interactionArgs, respond, toActionRow, toEmbed, toSlashCommands } from "@sbr/discord-kit";
import type { GuildRosterDTO, GuildRosterSource, LFGPostDTO } from "@sbr/shared-types";
import { startMilestoneAnnouncer } from "./milestones.js";
import type { BridgeApp } from "./composition.js";
import { isRosterEnd, parseGuildOnline } from "./roster.js";
import { acceptCommand, parseJoinEvent, type GuildJoinEvent } from "./join.js";
import { chatLine, staffReport } from "@sbr/screening";

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

/** A text channel this bot can actually post in — i.e. not a partial group DM. */
type SendableChannel = Extract<TextBasedChannel, { send: unknown; messages: unknown }>;

/**
 * The LFG board: an `LfgBoard` backed by the guild's `lfg` channel binding.
 *
 * Every failure is swallowed and logged. The post in the database is the record
 * of the run; the message is only a view of it, and losing the view must never
 * turn a successful join into an error in somebody's face. The one thing worth
 * being careful about is the binding: a message is only recorded once the send
 * has actually succeeded, so a post never points at a message that isn't there.
 */
export function createLfgBoard(app: BridgeApp, discord: Client): LfgBoard {
  async function textChannel(channelId: string): Promise<SendableChannel | null> {
    const channel = await discord.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return null;
    return channel as SendableChannel;
  }

  return {
    async publish(post: LFGPostDTO): Promise<void> {
      const channelId = await app.handlerDeps.config.getChannel(post.guildId, "lfg").catch(() => null);
      // No board configured is a normal state, not a fault: the command still
      // answered in the channel it was run in.
      if (!channelId) return;
      const channel = await textChannel(channelId);
      if (!channel) {
        app.log.warn("lfg channel is bound to something I can't post in", { channelId });
        return;
      }
      const message = await channel
        .send({
          embeds: [toEmbed(renderLfgEmbed(post))],
          components: lfgButtons(post).map(toActionRow),
          // The post carries a title and notes somebody typed; a stray @everyone
          // in them is not a licence to ping the server.
          allowedMentions: { users: [...post.members] },
        })
        .catch((e: unknown) => {
          app.log.warn("could not publish lfg post", { postId: post.id, error: String(e) });
          return null;
        });
      if (!message) return;
      await app.handlerDeps.community.bindLfgMessage(post.id, channel.id, message.id);
    },

    async refresh(post: LFGPostDTO): Promise<void> {
      if (post.channelId === null || post.messageId === null) return;
      const channel = await textChannel(post.channelId);
      if (!channel) return;
      const message = await channel.messages.fetch(post.messageId).catch(() => null);
      // A deleted message is not an error worth reporting: somebody tidied the
      // channel, and the run carries on without its card.
      if (!message) return;
      await message
        .edit({
          embeds: [toEmbed(renderLfgEmbed(post))],
          components: lfgButtons(post).map(toActionRow),
          allowedMentions: { users: [...post.members] },
        })
        .catch((e: unknown) => {
          app.log.warn("could not refresh lfg post", { postId: post.id, error: String(e) });
        });
    },
  };
}

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
  destroy(): Promise<void>;
}

export interface BridgeStatus {
  readonly discordReady: boolean;
  /** Gateway round-trip in ms; -1 from discord.js before the first heartbeat. */
  readonly gatewayPingMs: number | null;
  /** Configured *and* spawned — a bot mid-reconnect is not a live bridge. */
  readonly mcSpawned: boolean;
  readonly mcConfigured: boolean;
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
  // The board needs the client, and the client is built from the app, so it is
  // handed over here rather than composed in.
  app.setLfgBoard(createLfgBoard(app, discord));

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

  discord.on(Events.InteractionCreate, (i) => {
    // Each branch catches its own failure: an unhandled rejection here would
    // take the process down over a single bad interaction.
    if (i.isChatInputCommand()) {
      void handle(i).catch((e: unknown) => app.log.error("interaction failed", { error: String(e) }));
    } else if (i.isAutocomplete()) {
      void complete(i).catch((e: unknown) => app.log.error("autocomplete failed", { error: String(e) }));
    } else if (i.isButton()) {
      void components.handle(i).catch((e: unknown) => app.log.error("component failed", { error: String(e) }));
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

    bot.on("messagestr", (str: string) => {
      // Roster capture takes every line, guild chat or not: the `/g online`
      // reply is a server message block, not chat, so it never parses as chat.
      captureRosterLine(str);

      // Join notices are server messages too, so this must come before the
      // guild-chat parse rather than inside it.
      const join = parseJoinEvent(str);
      if (join) {
        relay("join-screening", () => handleJoin(bot, join));
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
    });
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
   * Screen a join request, or record a completed join.
   *
   * Nothing here throws into the chat handler: `relay` catches, and every step
   * that could fail is allowed to leave the rest working. In particular a
   * failure to resolve the applicant's uuid ends the screening — we will not
   * accept somebody we could not identify — while a failure to post the staff
   * report only costs the report, because the row is already written.
   */
  async function handleJoin(bot: Bot, event: GuildJoinEvent): Promise<void> {
    if (seenRecently(`${event.kind}:${event.ign.toLowerCase()}`)) return;

    const guildId = await resolveInternalGuild();
    if (!guildId) return;

    const resolved = await app.handlerDeps.players.resolveIgn(event.ign);
    if (!resolved) {
      app.log.warn("join event for an unresolvable name — not screened", { ign: event.ign, kind: event.kind });
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
      await postStaffReport(guildId, `**${resolved.ign} joined the guild.**
${staffReport(screening)}`);
      return;
    }

    if (shouldAccept) {
      // A raw command, not `/gc`: this is an instruction to Hypixel, not a line
      // of guild chat, so it must not go through the echo-suppressing sender.
      if (spawned) bot.chat(acceptCommand(resolved.ign));
      await app.screening.decide(id, "ACCEPTED", "AUTO");
    } else if (screening.verdict === "DENY") {
      await app.screening.decide(id, "DENIED", "AUTO");
    }

    // The public line is deliberately vague — see `chatLine`. Said only when we
    // actually acted, so a request quietly queued for staff does not announce
    // itself to the guild.
    if (shouldAccept || screening.verdict === "DENY") {
      sayInGuildChat(bot, chatLine(screening), true);
    }

    await postStaffReport(
      guildId,
      shouldAccept
        ? `**Auto-accepted ${resolved.ign}.**
${staffReport(screening)}`
        : `**Join request from ${resolved.ign} — ${screening.verdict.toLowerCase()}.**
${staffReport(screening)}`,
    );
  }

  /**
   * Post to the guild's `staff` channel. Silent when the slot is unbound: a
   * guild that has not configured one still gets screening, recorded and
   * decided, it just has nowhere for the write-up to go.
   */
  async function postStaffReport(guildId: string, content: string): Promise<void> {
    const channelId = await app.handlerDeps.config.getChannel(guildId, "staff");
    if (!channelId) return;
    const channel = await discord.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return;
    // The report quotes a stranger's IGN and a third-party listing reason,
    // neither of which we control; mentions stay unparsed.
    await channel.send({ content, allowedMentions: { parse: [] } }).catch((e: unknown) => {
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
      return {
        discordReady: discord.isReady(),
        // discord.js reports -1 until the first gateway heartbeat lands;
        // forwarding that verbatim would render as a negative latency.
        gatewayPingMs: Number.isFinite(ping) && ping >= 0 ? Math.round(ping) : null,
        mcSpawned: spawned,
        mcConfigured: opts.mc !== null,
      };
    },
    async destroy() {
      // Stop reconnecting before closing anything, so the `end` this triggers
      // isn't answered with a fresh login.
      announcer.stop();
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
  });
  if (decision.action === "DELIVER") send(decision.formatted);
}
