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
import {
  CASE_SELECT_NAMESPACE,
  FEATURE_SELECT_NAMESPACE,
  LOCKDOWN_NAMESPACE,
  buildAdminRegistry,
  parseLockdownId,
} from "@sbr/commands-admin";
import {
  ComponentRouter,
  interactionArgs,
  replyOptions,
  respond,
  toSlashCommands,
  withoutEphemeral,
} from "@sbr/discord-kit";
import { recordArgs } from "@sbr/shared-types";
import { attachDiscordModObserver } from "./discord-mod-observer.js";
import { attachMemberObserver } from "./member-observer.js";
import { attachUtilityComponents } from "./utility-components.js";
import { attachRaidGate } from "./raid-gate.js";
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

/**
 * The case menu under `/audit`, routed back through the dispatcher.
 *
 * Deliberately *not* a second path to the same data. The value picked is a case
 * id and the thing that renders a case id is `/case`, so this synthesises the
 * arguments `/case` would have received and dispatches it — which means the
 * per-guild policy floor, the actor's role check and the handler itself are the
 * same ones a typed `/case` goes through. A menu that read the case out of the
 * service directly would be a permission check nobody remembered to write.
 *
 * The id lives in the option value rather than in the customId, so the menu is
 * stateless in the way every persistent control here is: the reply rendered
 * before a restart still routes afterwards.
 */
export function attachCaseSelect(components: ComponentRouter, app: AdminApp): void {
  components.register(CASE_SELECT_NAMESPACE, async (interaction) => {
    if (!interaction.isStringSelectMenu() || !interaction.guildId) return;
    const internalGuildId = await app.resolveGuild(interaction.guildId);
    if (!internalGuildId) {
      await interaction.reply({ content: "This server isn't set up on the platform.", flags: MessageFlags.Ephemeral });
      return;
    }
    const id = interaction.values[0];
    if (!id) return;
    const reply = await app.dispatcher.dispatch("case", {
      guildId: internalGuildId,
      actorId: interaction.user.id,
      channelId: interaction.channelId,
      args: recordArgs({ id }),
    });
    // Always a fresh ephemeral reply rather than an edit: the overview the menu
    // hangs off is worth keeping on screen, and more than one staffer can be
    // reading the same `/audit` output.
    await interaction.reply({ ...replyOptions({ ...reply, ephemeral: true }) });
  });
}

/**
 * The `/lockdown` buttons.
 *
 * Every button re-enters `AdminDispatcher.dispatch("lockdown", …)` with
 * synthesised arguments rather than calling the safety service directly. The
 * role floor, the guild's policy override and the handler are then the same
 * ones a typed `/lockdown` goes through — a second path into a privileged write
 * is a permission check nobody remembered to write. `action` is deliberately
 * absent from the published command spec, so the click is the only way to reach
 * it: there is no typeable form of "lock the server" that skips the card.
 *
 * The reply decides the message: a refusal comes back ephemeral and is answered
 * with a fresh private message, while a successful lock comes back public and
 * *updates the prompt in place*, so the warning staff saw and the record of what
 * they did are one message that cannot disagree with itself.
 */
export function attachLockdownButtons(components: ComponentRouter, app: AdminApp): void {
  components.register(LOCKDOWN_NAMESPACE, async (interaction, segments) => {
    const parsed = parseLockdownId(segments);
    if (!parsed || !interaction.guildId) return;
    const internalGuildId = await app.resolveGuild(interaction.guildId);
    if (!internalGuildId) {
      await interaction.reply({
        content: "This server isn't set up on the platform.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const reply = await app.dispatcher.dispatch("lockdown", {
      guildId: internalGuildId,
      actorId: interaction.user.id,
      channelId: interaction.channelId,
      args: recordArgs({
        action: parsed.action,
        ...(parsed.channelId ? { channel: parsed.channelId } : {}),
        ...(parsed.duration ? { duration: parsed.duration } : {}),
        reason: parsed.reason,
      }),
    });

    if (reply.ephemeral) {
      await interaction.reply(replyOptions(reply));
      return;
    }
    // `interaction.update()` rejects the ephemeral flag outright, and this reply
    // is public by construction, so drop it rather than pass it along. The V2
    // flag stays: without it the update is a message shape Discord no longer
    // recognises, and it takes the card with it.
    await interaction.update(withoutEphemeral(replyOptions(reply)));
  });
}

/** How long to wait for the gateway to report ready before giving up. */
/**
 * The feature menu's click.
 *
 * It does not write the flag itself. It synthesises the argument the handler
 * expects and dispatches `feature-toggle` through the ordinary path, so the
 * actor's role check and the guild's policy floor are the same ones a typed
 * `/feature-toggle` goes through. A component handler that wrote the config
 * directly would be an ADMIN-gated write reachable by anyone who could see the
 * message — which is exactly the failure that is invisible from the outside.
 */
export function attachFeatureMenu(components: ComponentRouter, app: AdminApp): void {
  components.register(FEATURE_SELECT_NAMESPACE, async (interaction) => {
    if (!interaction.isStringSelectMenu() || !interaction.guildId) return;
    const internalGuildId = await app.resolveGuild(interaction.guildId);
    if (!internalGuildId) {
      await interaction.reply({
        content: "This server isn't set up on the platform.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const set = interaction.values[0];
    if (!set) return;
    const reply = await app.dispatcher.dispatch("feature-toggle", {
      guildId: internalGuildId,
      actorId: interaction.user.id,
      channelId: interaction.channelId,
      args: recordArgs({ set }),
    });
    // `update`, not `reply`: the card is the state of the switches, and a second
    // copy of it below the first would leave the stale one on screen, still
    // clickable and still describing a world that has moved.
    //
    // No ephemeral flag — an update inherits the original message's visibility,
    // and naming it again is the one thing discord.js rejects here.
    await interaction.update(withoutEphemeral(replyOptions({ ...reply, ephemeral: true })));
  });
}

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
  // GuildMembers is privileged and must also be enabled for this application in
  // the Discord developer portal. Without it the gateway still connects, but
  // `members.fetch()` returns only the bot — the panel's member picker and the
  // Discord-side member scan both come back empty rather than erroring, so the
  // internal API logs a warning when it sees that shape.
  // GuildModeration is what delivers ban and unban events. It is not privileged
  // — unlike GuildMembers below — so it costs nothing but has to be asked for:
  // without it the gateway simply never mentions that anybody was banned, and
  // the observer attached further down would sit silent forever.
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
    ],
  });
  const handle = createInteractionHandler(app);
  const complete = createAutocompleteHandler(app);
  // Buttons whose state lives in the customId, so they survive a restart
  // (application accept/deny). Namespaces are registered by their owning domain.
  const components = new ComponentRouter({
    onError: (namespace, error) => app.log.error("component handler threw", { namespace, error: String(error) }),
  });

  attachCaseSelect(components, app);

  // The feature card's select menu. Its state lives in the option value, so it
  // keeps working on a message posted before the last restart.
  attachFeatureMenu(components, app);

  attachLockdownButtons(components, app);

  // The staff utilities put their verbs on cards; every click re-enters the
  // dispatcher, so the role floor and the destructive gate stay on one path.
  attachUtilityComponents(components, app);

  // Joins and leaves go straight onto the bus; nothing is rendered here.
  attachMemberObserver(client, {
    resolveGuild: (id) => app.resolveGuild(id),
    publish: (message) => app.memberBus.publish(message),
    markRolesDirty: (guildId, ids) => app.rolesDirty.mark(guildId, ids),
    logger: app.log,
  });

  // Punishments taken by hand in Discord, adopted into the platform so the
  // audit, the mod log and the guild-chat side all learn about them.
  attachDiscordModObserver(client, {
    resolveGuild: (id) => app.resolveGuild(id),
    record: (input) => app.recordDiscordAction(input),
    logger: app.log,
  });
  // The anti-raid posture, applied. Attached beside the observer rather than
  // inside it: observing is for whoever greets a member, gating is a privileged
  // decision, and folding the two together would mean a failure in one silently
  // skipped the other.
  attachRaidGate(client, app.raidGate);

  client.on(Events.InteractionCreate, (i) => {
    // Each branch catches its own failure: an unhandled rejection here would
    // take the process down over a single bad interaction.
    if (i.isChatInputCommand()) {
      void handle(i).catch((e: unknown) => app.log.error("interaction failed", { error: String(e) }));
    } else if (i.isAutocomplete()) {
      void complete(i).catch((e: unknown) => app.log.error("autocomplete failed", { error: String(e) }));
    } else if (i.isButton() || i.isStringSelectMenu()) {
      // Selects route the same way buttons do — the `/audit` case menu is a
      // persistent control with its state in the option values, and routing
      // only buttons meant it silently did nothing.
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
