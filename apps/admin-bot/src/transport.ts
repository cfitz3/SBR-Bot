/**
 * discord.js transport for the admin bot. Translates a slash-command interaction
 * into an AdminContext (resolving the Discord guild → internal id), runs it
 * through the dispatcher, and replies. Arg extraction is a pure helper for tests.
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
} from "discord.js";
import type { AdminApp } from "./composition.js";

/** Minimal view over interaction options so buildArgs is unit-testable. */
export interface OptionReader {
  getUserId(name: string): string | null;
  getString(name: string): string | null;
  getBoolean(name: string): boolean | null;
}

export function buildArgs(opts: OptionReader): Record<string, string> {
  const args: Record<string, string> = {};
  const target = opts.getUserId("target");
  if (target) args.target = target;
  const reason = opts.getString("reason");
  if (reason) args.reason = reason;
  const duration = opts.getString("duration");
  if (duration) args.duration = duration;
  if (opts.getBoolean("confirm")) args.confirm = "true";
  return args;
}

export function buildCommands(): unknown[] {
  return [
    new SlashCommandBuilder()
      .setName("warn")
      .setDescription("Issue a formal warning")
      .addUserOption((o) => o.setName("target").setDescription("Member to warn").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Reason")),
    new SlashCommandBuilder()
      .setName("mute")
      .setDescription("Mute a member across Discord + guild chat")
      .addUserOption((o) => o.setName("target").setDescription("Member").setRequired(true))
      .addStringOption((o) => o.setName("duration").setDescription("e.g. 1h, 30m").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Reason")),
    new SlashCommandBuilder()
      .setName("ban")
      .setDescription("Ban a member")
      .addUserOption((o) => o.setName("target").setDescription("Member").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Reason"))
      .addStringOption((o) => o.setName("duration").setDescription("Optional temp-ban duration"))
      .addBooleanOption((o) => o.setName("confirm").setDescription("Confirm this destructive action")),
    new SlashCommandBuilder()
      .setName("infractions")
      .setDescription("View a member's infraction history")
      .addUserOption((o) => o.setName("target").setDescription("Member").setRequired(true)),
  ].map((c) => c.toJSON());
}

function optionReader(i: ChatInputCommandInteraction): OptionReader {
  return {
    getUserId: (n) => i.options.getUser(n)?.id ?? null,
    getString: (n) => i.options.getString(n),
    getBoolean: (n) => i.options.getBoolean(n),
  };
}

export function createInteractionHandler(app: AdminApp) {
  return async (i: ChatInputCommandInteraction): Promise<void> => {
    if (!i.guildId) {
      await i.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
      return;
    }
    const internalGuildId = await app.resolveGuild(i.guildId);
    if (!internalGuildId) {
      await i.reply({ content: "This server isn't set up on the platform.", flags: MessageFlags.Ephemeral });
      return;
    }
    const reply = await app.dispatcher.dispatch(i.commandName, {
      guildId: internalGuildId,
      actorId: i.user.id,
      args: buildArgs(optionReader(i)),
    });
    await i.reply(reply.ephemeral ? { content: reply.text, flags: MessageFlags.Ephemeral } : { content: reply.text });
  };
}

export async function startAdminGateway(app: AdminApp, token: string, clientId: string | undefined): Promise<Client> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const handle = createInteractionHandler(app);

  client.on(Events.InteractionCreate, (i) => {
    if (i.isChatInputCommand()) void handle(i);
  });
  client.once(Events.ClientReady, (c) => app.log.info("admin gateway ready", { tag: c.user.tag }));

  if (clientId) {
    const rest = new REST().setToken(token);
    await rest.put(Routes.applicationCommands(clientId), { body: buildCommands() });
    app.log.info("admin slash commands registered");
  }

  await client.login(token);
  return client;
}
