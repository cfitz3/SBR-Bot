/**
 * The discord.js half of the `/perm` console.
 *
 * Same line the ticket and role-menu systems draw: `perm-console.ts` decides
 * everything and knows nothing about Discord, and this turns a press into a
 * call and a reply into a message. Every control's state is in its customId, so
 * a console posted before a restart still works after one.
 *
 * Two things are deliberate:
 *
 * - **A press edits the console in place.** The card is public because half the
 *   point of a perm is other people seeing that a five-stack already exists, and
 *   a new message per press would bury the one everybody is reading. Failures
 *   are the exception: those are ephemeral, addressed to the person who pressed.
 * - **Nothing trusts the button.** The console is shown to a whole channel, so
 *   every action re-checks the presser against the perm it names — the check
 *   lives in `perm-console.ts`, and this file has no permission logic of its own
 *   to drift out of step with it.
 */
import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import {
  activityRows,
  addRoleRows,
  permConsoleCopy,
  permConsoleReplies,
  PERM_IGN_MODAL,
  PERM_NAME_MODAL,
  PERM_NS,
  type HandlerDeps,
} from "@sbr/commands-bridge";
import { replyOptions, toActionRow, type ComponentRouter, type ReplyView } from "@sbr/discord-kit";
import type { LFGActivity } from "@sbr/shared-types";

/** The modal inputs. Ids rather than positions: an optional field may be absent. */
const NAME_FIELD = "name";
const NOTES_FIELD = "notes";
const IGN_FIELD = "ign";

/** Discord's caps, spelled once. A party name is free text somebody typed. */
const MAX_NAME = 60;
const MAX_NOTES = 200;
const MAX_IGN = 16;

export interface PermRoutingDeps {
  /** Discord server id → platform guild id. Null when it is not registered. */
  readonly resolveGuild: (discordGuildId: string) => Promise<string | null>;
  readonly deps: HandlerDeps;
}

/**
 * `perm:<action>[:<argument>]` — the console's controls.
 *
 * The two that need free text do not act here at all: they open a modal, and
 * `handlePermModal` finishes the job when it comes back. A modal is where free
 * text belongs, because it is validated on submit in front of the person who
 * typed it rather than in front of the channel.
 */
export function registerPermComponents(router: ComponentRouter, routing: PermRoutingDeps): void {
  router.register(PERM_NS, async (interaction, [action, argument]) => {
    const guildId = await platformGuild(interaction, routing);
    if (guildId === null) return;

    const userId = interaction.user.id;
    const chosen = interaction.isStringSelectMenu() ? interaction.values[0] : undefined;

    switch (action) {
      case "open":
        if (chosen === undefined) return stale(interaction);
        return show(interaction, await permConsoleReplies.open(guildId, chosen, userId, routing.deps));

      case "page": {
        const page = Number(argument);
        if (!Number.isInteger(page)) return stale(interaction);
        return show(interaction, await permConsoleReplies.page(guildId, page, routing.deps));
      }

      case "seat":
        if (argument === undefined || chosen === undefined) return stale(interaction);
        return show(interaction, await permConsoleReplies.seat(guildId, argument, userId, chosen, routing.deps));

      case "leave":
        if (argument === undefined) return stale(interaction);
        return show(interaction, await permConsoleReplies.leave(guildId, argument, userId, routing.deps));

      case "drop":
        if (argument === undefined || chosen === undefined) return stale(interaction);
        return show(interaction, await permConsoleReplies.drop(guildId, argument, userId, chosen, routing.deps));

      case "default":
        if (argument === undefined) return stale(interaction);
        return show(interaction, await permConsoleReplies.setDefault(guildId, argument, userId, routing.deps));

      case "disband":
        if (argument === undefined) return stale(interaction);
        return show(interaction, await permConsoleReplies.disband(guildId, argument, userId, routing.deps));

      // The activity is asked before the name so the modal can carry it, and so
      // a party can never exist without one.
      case "new":
        return menu(interaction, permConsoleCopy.pickActivity, activityRows());

      // Which roles exist is a fact about the activity, so the perm is read
      // rather than the roles being typed. A perm that vanished between the
      // card being drawn and the button being pressed is a stale control.
      case "add": {
        if (argument === undefined) return stale(interaction);
        const perm = await routing.deps.perms.getPerm(guildId, argument);
        if (!perm.ok) return stale(interaction);
        return menu(interaction, permConsoleCopy.pickRole, addRoleRows(argument, perm.value.activity));
      }

      case "activity":
        if (chosen === undefined) return stale(interaction);
        return interaction.showModal(nameModal(chosen as LFGActivity));

      case "addrole":
        if (argument === undefined || chosen === undefined) return stale(interaction);
        return interaction.showModal(ignModal(argument, chosen));

      default:
        return stale(interaction);
    }
  });
}

/**
 * The two modals coming back.
 *
 * Returns false when the id belongs to something else, so the transport can
 * offer a submission to each owner in turn — modals are not message components
 * and have no router to dispatch them.
 */
export async function handlePermModal(
  interaction: ModalSubmitInteraction,
  routing: PermRoutingDeps,
): Promise<boolean> {
  const id = interaction.customId;
  if (!id.startsWith(`${PERM_NS}:`)) return false;
  if (!id.startsWith(`${PERM_NAME_MODAL}:`) && !id.startsWith(`${PERM_IGN_MODAL}:`)) return false;

  const guildId = interaction.guildId === null ? null : await routing.resolveGuild(interaction.guildId);
  if (guildId === null) {
    await ephemeral(interaction, "This server isn't registered with the platform.");
    return true;
  }

  // Both branches write to the database and then read the party back, which is
  // more than Discord's three-second reply budget on a bad day.
  //
  // Ephemeral, because a modal is only ever reached from an ephemeral menu: the
  // person who typed the name is the person who gets the answer, and the public
  // console is refreshed by the next press on it rather than by a second card
  // landing in the channel underneath the first.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const userId = interaction.user.id;

  if (id.startsWith(`${PERM_NAME_MODAL}:`)) {
    const activity = id.slice(`${PERM_NAME_MODAL}:`.length) as LFGActivity;
    const reply = await permConsoleReplies.create(
      guildId,
      userId,
      activity,
      fieldValue(interaction, NAME_FIELD),
      fieldValue(interaction, NOTES_FIELD),
      routing.deps,
    );
    await interaction.editReply(edit(reply)).catch(() => {});
    return true;
  }

  const [permId, role] = id.slice(`${PERM_IGN_MODAL}:`.length).split(":");
  if (permId === undefined || role === undefined) {
    await interaction.editReply({ content: permConsoleCopy.staleControl }).catch(() => {});
    return true;
  }
  const reply = await permConsoleReplies.add(
    guildId,
    permId,
    userId,
    role,
    fieldValue(interaction, IGN_FIELD),
    routing.deps,
  );
  await interaction.editReply(edit(reply)).catch(() => {});
  return true;
}

/**
 * A reply as an edit of a deferred one.
 *
 * `flags` is dropped because the deferral already decided ephemerality, and
 * `editReply` rejects the flag rather than ignoring it.
 */
function edit(reply: ReplyView): Omit<ReturnType<typeof replyOptions>, "flags"> {
  const { flags: _flags, ...rest } = replyOptions(reply);
  return rest;
}

// ── replies ──────────────────────────────────────────────────────────────────

/**
 * A console reply, onto the message that produced it.
 *
 * An error comes back ephemeral because it is about the presser, not about the
 * party: replacing a card a channel is reading with "that party is full" would
 * take the roster away from everybody to tell one person something.
 */
async function show(interaction: MessageComponentInteraction, reply: ReplyView): Promise<void> {
  if (reply.ephemeral) {
    await interaction.reply({ content: reply.text, flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  const options = replyOptions(reply);
  await interaction
    .update({
      // `update` keeps whatever it is not given, and the console always carries
      // an embed — so without this the summary line of the *previous* card
      // would sit above the new one.
      content: options.content ?? "",
      embeds: options.embeds ?? [],
      components: options.components ?? [],
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
}

/** A one-control menu, ephemeral, standing in front of a modal. */
async function menu(
  interaction: MessageComponentInteraction,
  prompt: string,
  rows: readonly Parameters<typeof toActionRow>[0][],
): Promise<void> {
  await interaction
    .reply({ content: prompt, components: rows.map(toActionRow), flags: MessageFlags.Ephemeral })
    .catch(() => {});
}

async function stale(interaction: MessageComponentInteraction): Promise<void> {
  await interaction
    .reply({ content: permConsoleCopy.staleControl, flags: MessageFlags.Ephemeral })
    .catch(() => {});
}

async function ephemeral(interaction: ModalSubmitInteraction, text: string): Promise<void> {
  await interaction.reply({ content: text, flags: MessageFlags.Ephemeral }).catch(() => {});
}

/** The platform guild, or nothing — with the presser told which it was. */
async function platformGuild(
  interaction: MessageComponentInteraction,
  routing: PermRoutingDeps,
): Promise<string | null> {
  const guildId = interaction.guildId === null ? null : await routing.resolveGuild(interaction.guildId).catch(() => null);
  if (guildId === null) {
    await interaction
      .reply({ content: "This server isn't registered with the platform.", flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return null;
  }
  return guildId;
}

// ── modals ───────────────────────────────────────────────────────────────────

/**
 * The new-party modal. The activity rides in the id, so a member who took a
 * minute over the name does not lose the choice they already made.
 */
function nameModal(activity: LFGActivity): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${PERM_NAME_MODAL}:${activity}`)
    .setTitle(permConsoleCopy.nameModalTitle)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(NAME_FIELD)
          .setLabel(permConsoleCopy.nameLabel)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(MAX_NAME),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(NOTES_FIELD)
          .setLabel(permConsoleCopy.notesLabel)
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(MAX_NOTES),
      ),
    );
}

/** The add-someone modal, for a player with no link to resolve a name from. */
function ignModal(permId: string, role: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${PERM_IGN_MODAL}:${permId}:${role}`)
    .setTitle(permConsoleCopy.ignModalTitle)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(IGN_FIELD)
          .setLabel(permConsoleCopy.ignLabel)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(MAX_IGN),
      ),
    );
}

/**
 * A field's value, or "".
 *
 * `getTextInputValue` throws when the input is not in the submission, which an
 * optional field legitimately is not.
 */
function fieldValue(interaction: ModalSubmitInteraction, customId: string): string {
  try {
    return interaction.fields.getTextInputValue(customId);
  } catch {
    return "";
  }
}
