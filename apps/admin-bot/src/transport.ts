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
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { buildAdminRegistry } from "@sbr/commands-admin";
import { ComponentRouter, interactionArgs, respond, toSlashCommands } from "@sbr/discord-kit";
import type { AdminApp } from "./composition.js";

/**
 * The registration payload, derived from the wired handler registry. Keeping it
 * derived means a staff command can never be published to Discord without a
 * handler behind it.
 */
export function buildCommands(app?: AdminApp): unknown[] {
  return toSlashCommands(app?.dispatcher.commands ?? buildAdminRegistry());
}

export function createAutocompleteHandler(app: AdminApp) {
  return async (i: AutocompleteInteraction): Promise<void> => {
    // Suggestions are guild-scoped — `/wordlist-remove` must offer this
    // server's rules, so an unmapped guild gets nothing rather than someone
    // else's list.
    if (!i.guildId) return;
    const internalGuildId = await app.resolveGuild(i.guildId);
    if (!internalGuildId) return;
    const focused = i.options.getFocused(true);
    const choices = await app.dispatcher.autocomplete(
      i.commandName,
      { name: focused.name, value: focused.value },
      { guildId: internalGuildId, userId: i.user.id },
    );
    await i.respond([...choices]).catch(() => {});
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
      // `/purge` and `/lockdown` with no channel option act on where they were
      // typed, which is what a staffer in the offending channel expects.
      channelId: i.channelId,
      args: interactionArgs(i),
    });
    await respond(i, reply);
  };
}

/** How long to wait for the gateway to report ready before giving up. */
const READY_TIMEOUT_MS = 30_000;

export interface AdminHandles {
  readonly client: Client;
  /** Register persistent button namespaces (application accept/deny) here. */
  readonly components: ComponentRouter;
}

export async function startAdminGateway(
  app: AdminApp,
  token: string,
  discordGuildId?: string,
): Promise<AdminHandles> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const handle = createInteractionHandler(app);
  const complete = createAutocompleteHandler(app);
  // Buttons whose state lives in the customId, so they survive a restart
  // (application accept/deny). Namespaces are registered by their owning domain.
  const components = new ComponentRouter({
    onError: (namespace, error) => app.log.error("component handler threw", { namespace, error: String(error) }),
  });

  client.on(Events.InteractionCreate, (i) => {
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

  const ready = new Promise<Client<true>>((resolve, reject) => {
    client.once(Events.ClientReady, resolve);
    const timer = setTimeout(
      () => reject(new Error(`gateway did not become ready within ${READY_TIMEOUT_MS}ms`)),
      READY_TIMEOUT_MS,
    );
    timer.unref();
  });

  try {
    await client.login(token);
    const readyClient = await ready;
    // Hand the live client to the Discord-effects adapter; until this point
    // `/kick`, `/purge` and `/lockdown` report "not connected" instead of throwing.
    app.effects.attach(readyClient);
    app.log.info("admin gateway ready", { tag: readyClient.user.tag });

    // Register against the application the *token* belongs to, read back from the
    // authenticated session. A separately-configured client id is the same value
    // only by convention: the moment the two drift — as they do whenever the admin
    // and bridge bots are distinct Discord applications sharing one
    // DISCORD_CLIENT_ID — Discord rejects the write with error 20012.
    //
    // Scope follows DISCORD_GUILD_ID. Guild-scoped registrations apply instantly
    // (global ones take up to an hour) and shadow same-named global commands, so
    // a single managed server is better served by them. Note that `put` *replaces*
    // the whole scope: anything previously registered here and no longer in
    // `buildCommands()` disappears.
    const applicationId = readyClient.application.id;
    const rest = new REST().setToken(token);
    if (discordGuildId) {
      await rest.put(Routes.applicationGuildCommands(applicationId, discordGuildId), { body: buildCommands(app) });
      // Guild and global registrations are separate lists that Discord shows
      // *both* of in the picker, so a leftover global set from an earlier boot
      // appears as a duplicate of every command. Exactly one scope may be
      // populated.
      await rest.put(Routes.applicationCommands(applicationId), { body: [] });
    } else {
      await rest.put(Routes.applicationCommands(applicationId), { body: buildCommands(app) });
    }
    app.log.info("admin slash commands registered", {
      applicationId,
      scope: discordGuildId ? `guild ${discordGuildId}` : "global (up to 1h to appear)",
    });

    return { client, components };
  } catch (error) {
    // Release the gateway socket and REST handles before the error propagates;
    // exiting with them mid-flight aborts the process instead of failing cleanly.
    await client.destroy().catch(() => {});
    throw error;
  }
}
