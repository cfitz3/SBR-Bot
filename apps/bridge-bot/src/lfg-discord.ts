/**
 * The discord.js half of `/lfg`.
 *
 * Same division as the `/perm` console: `lfg-request.ts` decides everything and
 * knows nothing about Discord, and this turns a press into a call and a reply
 * into a message. Every control's state is in its customId, so a menu opened
 * before a restart still answers after one.
 *
 * Two things are deliberate:
 *
 * - **A press edits the step in place.** The steps are ephemeral and there is
 *   only ever one of them: a member picking a floor should see the class menu
 *   replace the floor menu, not stack under it.
 * - **The post mentions exactly one role.** The allowed-mentions list is built
 *   from the id the offline half resolved, so a card can never mention @everyone
 *   or a member no matter what ends up in its text or fields.
 */
import { MessageFlags, type Client, type MessageComponentInteraction } from "discord.js";
import {
  lfgRequestCopy,
  lfgRequestReplies,
  LFG_NS,
  type HandlerDeps,
  type LfgAnnouncer,
} from "@sbr/commands-bridge";
import {
  containerMessage,
  replyOptions,
  withoutEphemeral,
  type ComponentRouter,
  type ReplyView,
} from "@sbr/discord-kit";
import type { Logger } from "@sbr/observability";

/** How the chosen classes ride in a customId. Mirrors `lfg-request.ts`. */
const CLASS_SEPARATOR = ",";

export interface LfgRoutingDeps {
  /** Discord server id → platform guild id. Null when it is not registered. */
  readonly resolveGuild: (discordGuildId: string) => Promise<string | null>;
  readonly deps: HandlerDeps;
}

/**
 * `lfg:<action>[:<floor>[:<classes>]]` — the request flow's controls.
 *
 * The class menu and the post button carry the same floor, because the button
 * is drawn beside the menu and neither can read the other's state: whichever is
 * pressed has to be able to say what run it belongs to on its own.
 */
export function registerLfgComponents(router: ComponentRouter, routing: LfgRoutingDeps): void {
  router.register(LFG_NS, async (interaction, [action, floor, classes]) => {
    const chosen = interaction.isStringSelectMenu() ? interaction.values : [];

    switch (action) {
      case "type": {
        const type = chosen[0];
        if (type === undefined) return stale(interaction);
        return show(interaction, lfgRequestReplies.chooseType(type));
      }

      case "floor": {
        const code = chosen[0];
        if (code === undefined) return stale(interaction);
        return show(interaction, lfgRequestReplies.chooseFloor(code));
      }

      // An empty selection is a real answer here — it is how somebody unpicks
      // the class they picked by mistake — so `chosen` is passed as it came.
      case "class": {
        if (floor === undefined) return stale(interaction);
        return show(interaction, lfgRequestReplies.chooseClasses(floor, chosen));
      }

      // The post writes to Discord and may read Hypixel first, which is more
      // than the three-second budget on a bad day.
      case "post": {
        if (floor === undefined) return stale(interaction);
        const guildId = await platformGuild(interaction, routing);
        if (guildId === null) return;
        await interaction.deferUpdate().catch(() => {});
        const reply = await lfgRequestReplies.post(
          guildId,
          interaction.user.id,
          floor,
          classes === undefined || classes === "" ? [] : classes.split(CLASS_SEPARATOR),
          routing.deps,
        );
        // The menus go with the answer: the request has been made, and leaving
        // the controls live is an invitation to post it twice.
        await interaction.editReply({ content: reply.text, embeds: [], components: [] }).catch(() => {});
        return;
      }

      default:
        return stale(interaction);
    }
  });
}

/**
 * The live announcer.
 *
 * Everything it needs was decided offline — which channel, which role, what the
 * card says — so this is a send and nothing more. It answers false rather than
 * throwing, because the caller's next line is the sentence the member reads and
 * a missing channel and a missing permission mean the same thing to them.
 */
export function createLfgAnnouncer(client: Client, log: Logger): LfgAnnouncer {
  return {
    async announce({ channelId, text, embed, pingRoleId }) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !("send" in channel)) return false;
      try {
        await channel.send({
          // The call-out line rides inside the card. V2 has no `content`, and
          // the ping belongs above the party it is calling people to.
          ...containerMessage(embed, { lead: text }),
          // Named rather than parsed: the card carries a member mention in its
          // headline, and `parse: ["roles"]` would also let a role slip in
          // through any field that happened to contain one.
          allowedMentions: { parse: [], roles: pingRoleId === null ? [] : [pingRoleId] },
        });
        return true;
      } catch (error) {
        log.error("lfg announce failed", { channelId, error: String(error) });
        return false;
      }
    },
  };
}

// ── replies ──────────────────────────────────────────────────────────────────

/**
 * A step, onto the message that produced it.
 *
 * `update` rather than `reply`: every step is ephemeral and answers the same
 * member, so the menu they just used is the right place for the next one. It
 * keeps whatever it is not given, which is why the embeds are cleared.
 */
async function show(interaction: MessageComponentInteraction, reply: ReplyView): Promise<void> {
  // The whole message is the container, so an update replaces it outright —
  // there is no stale embed or leftover line left behind to clear.
  await interaction.update(withoutEphemeral(replyOptions(reply))).catch(() => {});
}

async function stale(interaction: MessageComponentInteraction): Promise<void> {
  await interaction
    .reply({ content: lfgRequestCopy.staleControl, flags: MessageFlags.Ephemeral })
    .catch(() => {});
}

/** The platform guild, or nothing — with the presser told which it was. */
async function platformGuild(
  interaction: MessageComponentInteraction,
  routing: LfgRoutingDeps,
): Promise<string | null> {
  const guildId =
    interaction.guildId === null ? null : await routing.resolveGuild(interaction.guildId).catch(() => null);
  if (guildId === null) {
    await interaction
      .reply({ content: "This server isn't registered with the platform.", flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return null;
  }
  return guildId;
}
