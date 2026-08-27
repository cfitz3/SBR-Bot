/**
 * The discord.js half of self-service role menus.
 *
 * Same line as the ticket system draws: `role-menus.ts` decides and knows
 * nothing about Discord, and this holds the live client. It is two small
 * things — the message port that posts and edits the published menu, and the
 * component route that turns a press into a decision.
 *
 * The reply is always ephemeral. A menu is one message read by a whole channel;
 * a public "Ash took Red" per press would bury it within a day.
 */
import { MessageFlags, type Client, type MessageComponentInteraction, type TextBasedChannel } from "discord.js";
import { toActionRow, toEmbed, type ComponentRouter } from "@sbr/discord-kit";
import type { ActionRowView, EmbedView } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { ROLE_MENU_NAMESPACE, type RoleMenuGateway, type RoleMenuMessagePort } from "./role-menus.js";
import { copy } from "@sbr/brand";

const E = copy.error;

type SendableChannel = Extract<TextBasedChannel, { send: unknown; messages: unknown }>;

/** Nothing here throws: the caller has already decided what a failure means. */
export function roleMenuMessagePort(client: Client, log: Logger): RoleMenuMessagePort {
  async function textChannel(channelId: string): Promise<SendableChannel | null> {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return null;
    return channel as SendableChannel;
  }

  function payload(embed: EmbedView, rows: readonly ActionRowView[]) {
    return {
      embeds: [toEmbed(embed)],
      components: rows.map(toActionRow),
      // A menu body is admin-typed text posted to a whole channel. Nothing in it
      // may ping: this is the one place an `@everyone` in a settings field would
      // reach the entire server.
      allowedMentions: { users: [], roles: [] },
    };
  }

  return {
    async post(channelId, embed, rows) {
      const channel = await textChannel(channelId);
      if (channel === null) return null;
      const sent = await channel.send(payload(embed, rows)).catch((error: unknown) => {
        log.warn("could not post a role menu", { channelId, error: String(error) });
        return null;
      });
      return sent === null ? null : sent.id;
    },

    async edit(channelId, messageId, embed, rows) {
      const channel = await textChannel(channelId);
      if (channel === null) return false;
      const message = await channel.messages.fetch(messageId).catch(() => null);
      // A deleted message is the normal way this fails, and the caller's answer
      // is to post a fresh one — so it is not worth a log line.
      if (message === null) return false;
      const edited = await message.edit(payload(embed, rows)).catch((error: unknown) => {
        log.warn("could not update a role menu", { channelId, messageId, error: String(error) });
        return null;
      });
      return edited !== null;
    },
  };
}

export interface RoleMenuRoutingDeps {
  readonly menus: () => RoleMenuGateway | null;
  /** Discord server id → platform guild id. Null when it is not registered. */
  readonly resolveGuild: (discordGuildId: string) => Promise<string | null>;
  readonly log: Logger;
}

/**
 * `rmenu:<menuId>:<optionKey>` — all the state a press needs, so a menu posted
 * months ago still works after a restart and after a redeploy.
 */
export function registerRoleMenuComponents(router: ComponentRouter, deps: RoleMenuRoutingDeps): void {
  router.register(ROLE_MENU_NAMESPACE, async (interaction, [menuId, optionKey]) => {
    const gateway = deps.menus();
    if (gateway === null) {
      await ephemeral(interaction, "I'm still starting up — try that again in a moment.");
      return;
    }
    const guildId = interaction.guildId === null ? null : await deps.resolveGuild(interaction.guildId);
    if (guildId === null) {
      await ephemeral(interaction, "This server isn't set up on the platform yet.");
      return;
    }
    if (menuId === undefined || optionKey === undefined) {
      await ephemeral(interaction, "That button is from an older version and no longer works.");
      return;
    }

    // Deferred first: the press costs a settings read and a call to the admin
    // bot, and Discord's three-second budget is not generous enough to gamble.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

    const held = heldRoles(interaction);
    if (held === null) {
      await ephemeral(interaction, E.generic.loadFailed);
      return;
    }

    const result = await gateway.press(guildId, menuId, optionKey, interaction.user.id, held);
    await ephemeral(interaction, result.ok ? result.note : result.detail);
  });
}

/**
 * What the presser already holds, straight off the interaction.
 *
 * Null rather than an empty list when it cannot be read: "holds nothing" and "I
 * could not tell" lead to different presses — the first grants, the second
 * would re-grant something they already have and, on an exclusive menu, strip
 * nothing when it should have swapped.
 */
function heldRoles(interaction: MessageComponentInteraction): readonly string[] | null {
  const roles = interaction.member?.roles;
  if (roles === undefined) return null;
  if (Array.isArray(roles)) return roles;
  return "cache" in roles ? roles.cache.map((role) => role.id) : null;
}

async function ephemeral(interaction: MessageComponentInteraction, content: string): Promise<void> {
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ content }).catch(() => {});
    return;
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
}
