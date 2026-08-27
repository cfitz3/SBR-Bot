/**
 * Buttons and pickers for `/note`'s neighbours: `/sticky`, `/rolemenu` and
 * `/tickets`.
 *
 * Each of those commands lost its `action:` option in favour of controls on the
 * card, and this is where a click becomes an invocation again. The important
 * part is that it becomes *the same* invocation: the handler is reached by
 * synthesising the arguments a typist would have supplied and re-entering
 * `AdminDispatcher.dispatch`, so the role floor, the guild's policy floor and
 * the destructive-action gate all still apply. A component handler that read the
 * bridge directly would be a second path into a privileged write, and a second
 * path is a permission check nobody remembered to write.
 *
 * Every reply is ephemeral, because the card it replaces was. Which means these
 * always `reply()` rather than `update()`: the original card belongs to the
 * staffer who ran the command, a second staffer clicking a button in a shared
 * channel would otherwise rewrite someone else's message, and the ephemeral
 * message a click produces cannot be edited by anyone else anyway.
 */
import {
  ROLEMENU_NAMESPACE,
  STICKY_NAMESPACE,
  TICKET_NAMESPACE,
  parseRoleMenuId,
  parseStickyId,
  parseTicketId,
} from "@sbr/commands-admin";
import { replyOptions, type ComponentRouter } from "@sbr/discord-kit";
import { recordArgs } from "@sbr/shared-types";
import type { MessageComponentInteraction } from "discord.js";
import type { AdminApp } from "./composition.js";

/** A picked option, or null for a button — the two ways a control carries an id. */
function picked(interaction: MessageComponentInteraction): string | null {
  return interaction.isStringSelectMenu()
    ? (interaction.values[0] ?? null)
    : null;
}

/**
 * Run one synthesised invocation and answer with whatever it produced.
 *
 * The guild is resolved here for the same reason the slash-command path resolves
 * it: a customId is durable and a server can be removed from the platform while
 * a card from last week is still on screen.
 */
async function dispatch(
  app: AdminApp,
  interaction: MessageComponentInteraction,
  command: string,
  args: Readonly<Record<string, string>>,
): Promise<void> {
  if (!interaction.guildId) return;
  const guildId = await app.resolveGuild(interaction.guildId);
  if (!guildId) {
    await interaction.reply({
      content: "This server isn't set up on the platform.",
      ephemeral: true,
    });
    return;
  }
  const reply = await app.dispatcher.dispatch(command, {
    guildId,
    actorId: interaction.user.id,
    channelId: interaction.channelId,
    args: recordArgs(args),
  });
  await interaction.reply(replyOptions({ ...reply, ephemeral: true }));
}

/** Drop the keys a synthesised invocation is leaving unset, which `recordArgs` reads as absent. */
function args(
  record: Readonly<Record<string, string | null>>,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== null && value !== "") out[key] = value;
  }
  return out;
}

export function attachUtilityComponents(
  components: ComponentRouter,
  app: AdminApp,
): void {
  components.register(STICKY_NAMESPACE, async (interaction, segments) => {
    const parsed = parseStickyId(segments);
    if (!parsed) return;
    // A pick names the channel; a button already carries it.
    const channel = picked(interaction) ?? parsed.channelId;
    await dispatch(
      app,
      interaction,
      "sticky",
      args({ action: parsed.action, channel }),
    );
  });

  components.register(ROLEMENU_NAMESPACE, async (interaction, segments) => {
    const parsed = parseRoleMenuId(segments);
    if (!parsed) return;
    const id = picked(interaction) ?? parsed.menuId;
    await dispatch(
      app,
      interaction,
      "rolemenu",
      args({ action: parsed.action, id, channel: parsed.channelId }),
    );
  });

  components.register(TICKET_NAMESPACE, async (interaction, segments) => {
    const parsed = parseTicketId(segments);
    if (!parsed) return;
    const id = picked(interaction) ?? parsed.ticketId;
    // The reason travelled in the custom id, already trimmed to what the card
    // showed, so what is recorded is what the staffer read before clicking.
    await dispatch(
      app,
      interaction,
      "tickets",
      args({ action: parsed.action, id, reason: parsed.reason }),
    );
  });
}
