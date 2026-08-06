/**
 * Bridge-bot transports: discord.js (member slash commands + Discord→game relay)
 * and Mineflayer (in-game guild chat → Discord relay). Both feed the shared
 * dispatcher / BridgeService; parsing helpers are pure for tests.
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { createBot, type Bot } from "mineflayer";
import type { BridgeApp } from "./composition.js";

/** Parse a Hypixel guild-chat line into { name, message }, or null. */
export function parseGuildChat(line: string): { name: string; message: string } | null {
  // e.g. "Guild > [MVP+] Steve [Officer]: anyone for f7?"
  const m = /^Guild > (?:\[[^\]]+\]\s*)?(\w{1,16})(?:\s*\[[^\]]+\])?:\s?(.+)$/.exec(line);
  if (!m) return null;
  return { name: m[1]!, message: m[2]! };
}

export function buildCommands(): unknown[] {
  return [
    new SlashCommandBuilder()
      .setName("link")
      .setDescription("Link your Minecraft account (Hypixel Discord social must match)")
      .addStringOption((o) => o.setName("ign").setDescription("Your Minecraft username").setRequired(true)),
    new SlashCommandBuilder().setName("networth").setDescription("Show your networth estimate"),
    new SlashCommandBuilder().setName("help").setDescription("List member commands"),
  ].map((c) => c.toJSON());
}

function argsOf(i: ChatInputCommandInteraction): Record<string, string> {
  const args: Record<string, string> = {};
  const ign = i.options.getString("ign");
  if (ign) args.ign = ign;
  return args;
}

export function createInteractionHandler(app: BridgeApp) {
  return async (i: ChatInputCommandInteraction): Promise<void> => {
    const guildId = i.guildId ? await app.resolveGuild(i.guildId) : null;
    // Commands work in DMs too (self stats/link), so fall back to a sentinel guild.
    const reply = await app.dispatcher.dispatch(i.commandName, {
      guildId: guildId ?? "global",
      userId: i.user.id,
      surface: "BRIDGE_BOT",
      args: argsOf(i),
    });
    await i.reply(reply.ephemeral ? { content: reply.text, flags: MessageFlags.Ephemeral } : { content: reply.text });
  };
}

export interface BridgeTransportOptions {
  readonly discordToken: string;
  readonly clientId: string | undefined;
  readonly discordGuildId: string | undefined;
  readonly bridgeChannelId: string | undefined;
  readonly mc: { host: string; port: number; username: string } | null;
}

export interface BridgeHandles {
  discord: Client;
  mc: Bot | null;
  destroy(): Promise<void>;
}

export async function startBridge(app: BridgeApp, opts: BridgeTransportOptions): Promise<BridgeHandles> {
  const internalGuildId = opts.discordGuildId ? await app.resolveGuild(opts.discordGuildId) : null;

  const discord = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  const handle = createInteractionHandler(app);
  discord.on(Events.InteractionCreate, (i) => {
    if (i.isChatInputCommand()) void handle(i);
  });
  discord.once(Events.ClientReady, (c) => app.log.info("bridge discord gateway ready", { tag: c.user.tag }));

  // In-game connector (Mineflayer). Only started with credentials.
  let mc: Bot | null = null;
  if (opts.mc) {
    mc = createBot({ host: opts.mc.host, port: opts.mc.port, username: opts.mc.username, auth: "microsoft" });
    mc.on("messagestr", (str: string) => {
      const parsed = parseGuildChat(str);
      if (parsed && internalGuildId) void relayGameToDiscord(app, discord, opts.bridgeChannelId, internalGuildId, parsed);
    });
    mc.on("error", (e: Error) => app.log.error("mineflayer error", { error: e.message }));
  }

  // Discord → in-game relay (only messages in the configured bridge channel).
  discord.on(Events.MessageCreate, (msg: Message) => {
    if (msg.author.bot || !mc) return;
    if (opts.bridgeChannelId && msg.channelId !== opts.bridgeChannelId) return;
    if (!internalGuildId) return;
    void relayDiscordToGame(app, mc, internalGuildId, msg);
  });

  if (opts.clientId) {
    const rest = new REST().setToken(opts.discordToken);
    await rest.put(Routes.applicationCommands(opts.clientId), { body: buildCommands() });
    app.log.info("bridge slash commands registered");
  }

  await discord.login(opts.discordToken);

  return {
    discord,
    mc,
    async destroy() {
      await discord.destroy();
      mc?.quit();
    },
  };
}

async function relayGameToDiscord(
  app: BridgeApp,
  discord: Client,
  bridgeChannelId: string | undefined,
  guildId: string,
  parsed: { name: string; message: string },
): Promise<void> {
  const decision = await app.bridge.processInbound({
    guildId,
    direction: "GAME_TO_DISCORD",
    authorId: parsed.name,
    authorName: parsed.name,
    content: parsed.message,
  });
  if (decision.action !== "DELIVER" || !bridgeChannelId) return;
  const channel = await discord.channels.fetch(bridgeChannelId).catch(() => null);
  if (channel && channel.isTextBased() && "send" in channel) {
    await channel.send(`**${parsed.name}**: ${decision.formatted}`);
  }
}

async function relayDiscordToGame(app: BridgeApp, mc: Bot, guildId: string, msg: Message): Promise<void> {
  const decision = await app.bridge.processInbound({
    guildId,
    direction: "DISCORD_TO_GAME",
    authorId: msg.author.id,
    authorName: msg.member?.displayName ?? msg.author.username,
    content: msg.content,
  });
  if (decision.action === "DELIVER") mc.chat(`/gc ${decision.formatted}`);
}
