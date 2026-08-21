/**
 * `/tag` — post one of the guild's canned replies by name.
 *
 * The same store the panel edits and the autoresponder fires from, reached
 * deliberately: a guild should not have to maintain one list of answers for
 * staff and another for the bot.
 *
 * The reply is public, because the point of a tag is to answer the channel
 * rather than the person who typed it. Scope is not consulted here — a tag's
 * scope governs where its *pattern* may fire on its own, and asking for one by
 * name is always deliberate.
 */
import type { CommandHandler, CommandReply, CommandSpec } from "./types.js";
import { findTag } from "@sbr/tickets";
import type { TicketTagDTO } from "@sbr/shared-types";

/** Discord's autocomplete limit. */
const MAX_SUGGESTIONS = 25;

const tag: CommandHandler = async (ctx, deps): Promise<CommandReply> => {
  if (deps.tags === undefined) {
    return { ephemeral: true, text: "Canned replies aren't set up on this deployment." };
  }

  const name = (ctx.args.getString("name") ?? "").trim();
  if (name === "") return { ephemeral: true, text: "Which one? Try `/tag name:` and pick from the list." };

  const all = await deps.tags.listTags(ctx.guildId);
  const found = findTag(all, name);
  // A disabled tag is treated as absent rather than as a different error: an
  // operator turned it off, and "that one is switched off" is a detail about
  // guild configuration that the channel does not need.
  if (found === null || !found.enabled) {
    return { ephemeral: true, text: `There's no reply called “${name}”.` };
  }

  return { ephemeral: false, text: found.content };
};

export function tagSpecs(): CommandSpec[] {
  return [
    {
      name: "tag",
      description: "Post one of this server's canned replies",
      options: [
        {
          name: "name",
          description: "Which reply to post",
          type: "string",
          required: true,
          autocomplete: true,
        },
      ],
      cooldownMs: 5_000,
      handler: tag,
      async autocomplete(focused, ctx, deps) {
        if (deps.tags === undefined) return [];
        const query = focused.value.trim().toLowerCase();
        const all: readonly TicketTagDTO[] = await deps.tags.listTags(ctx.guildId).catch(() => []);
        return all
          .filter((t) => t.enabled && t.name.toLowerCase().includes(query))
          .slice(0, MAX_SUGGESTIONS)
          .map((t) => ({ name: t.name, value: t.name }));
      },
    },
  ];
}
