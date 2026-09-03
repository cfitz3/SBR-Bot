/**
 * A transport-agnostic reply → a Discord message payload.
 *
 * Every reply the platform sends is a Components V2 message: one container,
 * carrying the card, its controls and any attachment. That is a whole-message
 * decision rather than a per-call one, because V2 and the old shape cannot be
 * mixed — a message with `IsComponentsV2` may not carry `content` or `embeds`
 * at all — and because the Operator language is a container language: one
 * accent on the edge, hairlines inside, no field boxes.
 *
 * The embed renderer stays in `render.ts`. It is still what the panel gallery
 * and the specimen files render through, and it is the fallback if a surface
 * ever has to go back.
 */
import type { ActionRowView, EmbedView } from "@sbr/shared-types";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ContainerBuilder,
  FileBuilder,
  MessageFlags,
  type MessageActionRowComponentBuilder,
} from "discord.js";

import { MAX_ROWS_PER_MESSAGE, toActionRow } from "./render.js";
import { V2_FLAG, toContainer, toTextContainer } from "./render-v2.js";

/** The transport-agnostic reply shape both command packages return. */
export interface ReplyView {
  readonly text: string;
  readonly ephemeral: boolean;
  readonly embed?: EmbedView;
  readonly components?: readonly ActionRowView[];
  readonly pages?: readonly EmbedView[];
  /**
   * An attachment rendered from text — a ticket transcript, today.
   *
   * Text rather than bytes because everything the platform attaches is
   * generated here and now: a handler that wanted to forward arbitrary binary
   * would be doing something this shape should not quietly allow.
   */
  readonly file?: { readonly name: string; readonly content: string };
}

/**
 * What goes to `interaction.reply()`.
 *
 * `components` holds the container, not a list of rows: under V2 the message
 * *is* its components. `content` and `embeds` are absent by construction —
 * Discord rejects a V2 payload that carries either.
 */
export interface DiscordReplyOptions {
  components: (ContainerBuilder | ActionRowBuilder<MessageActionRowComponentBuilder>)[];
  files?: AttachmentBuilder[];
  /** `IsComponentsV2`, plus `Ephemeral` when the reply is private. */
  flags: number;
  allowedMentions?: { parse: [] };
}

/**
 * Render a reply for `interaction.reply()`.
 *
 * `text` is the card's fallback rather than a line above it: when a handler
 * returns a card, the card says everything, and repeating the sentence over it
 * reads as a duplicate. With no card, the sentence becomes the container's only
 * text — V2 has nowhere else to put it.
 *
 * Nothing the platform renders needs to ping anyone: replies address the caller,
 * who is already looking at them. Suppressing mentions centrally means a handler
 * that interpolates a player-supplied IGN, guild name, or application answer
 * can't turn it into a notification, without every handler having to remember.
 */
export function replyOptions(reply: ReplyView): DiscordReplyOptions {
  const view = reply.embed ?? reply.pages?.[0];
  const rows = (reply.components ?? []).slice(0, MAX_ROWS_PER_MESSAGE);
  const container = view ? toContainer(view, rows) : toTextContainer(reply.text);
  if (!view) {
    for (const row of rows) container.addActionRowComponents(toActionRow(row));
  }

  const options: DiscordReplyOptions = {
    components: [container],
    allowedMentions: { parse: [] },
    flags: reply.ephemeral ? V2_FLAG | MessageFlags.Ephemeral : V2_FLAG,
  };

  if (reply.file) {
    // Under V2 an attachment is only visible if something in the message points
    // at it; `files` alone uploads a file nobody can see.
    container.addFileComponents(new FileBuilder().setURL(`attachment://${reply.file.name}`));
    options.files = [
      new AttachmentBuilder(Buffer.from(reply.file.content, "utf8"), { name: reply.file.name }),
    ];
  }

  return options;
}

/**
 * The same payload, for `update()` and `editReply()`.
 *
 * Those two decide ephemerality at defer time and reject the flag rather than
 * ignoring it — but `IsComponentsV2` must survive, because an edit that drops
 * it is an edit to a message shape Discord no longer recognises, and it takes
 * the whole body with it.
 */
export function withoutEphemeral(options: DiscordReplyOptions): DiscordReplyOptions {
  return { ...options, flags: options.flags & ~MessageFlags.Ephemeral };
}

/**
 * A card the platform sends on its own initiative — an announcement, a mod-log
 * entry, an event board — rather than as an answer to an interaction.
 *
 * Same container, same flag; what differs is that the caller keeps its own
 * `allowedMentions`, because who a broadcast may ping is a decision about that
 * broadcast and not something this layer can make for all of them.
 */
export interface ContainerMessage {
  components: ContainerBuilder[];
  flags: number;
}

export function containerMessage(
  view: EmbedView,
  options: { readonly rows?: readonly ActionRowView[]; readonly lead?: string | null } = {},
): ContainerMessage {
  const rows = (options.rows ?? []).slice(0, MAX_ROWS_PER_MESSAGE);
  return {
    components: [toContainer(view, rows, { lead: options.lead ?? null })],
    flags: V2_FLAG,
  };
}
