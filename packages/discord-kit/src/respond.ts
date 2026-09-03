/**
 * Reply to an interaction from a transport-agnostic `ReplyView`, including
 * multi-page output.
 *
 * Pagination is deliberately *not* customId-routed: a page position is
 * throwaway state that nobody expects to survive a restart, so it lives in a
 * component collector scoped to this interaction. Buttons that must outlive a
 * restart (RSVP, run sign-ups) encode their state in the customId instead and
 * are handled by the persistent component router.
 */
import { FLATTEN_SEPARATOR, type EmbedView } from "@sbr/shared-types";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type ChatInputCommandInteraction,
} from "discord.js";
import { replyOptions, toEmbed, type ReplyView } from "./render.js";

/** How long the page buttons stay live. Discord tokens expire at 15 minutes. */
const PAGER_TTL_MS = 5 * 60_000;

const PREV = "pager:prev";
const NEXT = "pager:next";

function navRow(page: number, total: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(PREV)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(NEXT)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= total - 1),
  );
}

function pageEmbed(pages: readonly EmbedView[], index: number) {
  const view = pages[index]!;
  // Append the position to whatever footer the handler set, rather than
  // replacing it — the staleness note lives there too.
  const footer = view.footer
    ? `${view.footer}${FLATTEN_SEPARATOR}page ${index + 1}/${pages.length}`
    : `page ${index + 1}/${pages.length}`;
  return toEmbed({ ...view, footer });
}

export async function respond(i: ChatInputCommandInteraction, reply: ReplyView): Promise<void> {
  const pages = reply.pages;
  if (!pages || pages.length <= 1) {
    await i.reply(replyOptions(reply));
    return;
  }

  let page = 0;
  const base = replyOptions(reply);
  const message = await i.reply({
    ...base,
    embeds: [pageEmbed(pages, page)],
    components: [...(base.components ?? []), navRow(page, pages.length)],
    withResponse: true,
  });

  const resource = message.resource?.message;
  if (!resource) return;

  const collector = resource.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: PAGER_TTL_MS,
  });

  collector.on("collect", (button) => {
    void (async () => {
      if (button.customId !== PREV && button.customId !== NEXT) return;
      // Only the invoker drives the pager; otherwise a passer-by can flip the
      // page out from under them.
      if (button.user.id !== i.user.id) {
        await button.reply({ content: "That's not your list.", flags: base.flags });
        return;
      }
      page = button.customId === NEXT ? Math.min(page + 1, pages.length - 1) : Math.max(page - 1, 0);
      await button.update({
        embeds: [pageEmbed(pages, page)],
        components: [...(base.components ?? []), navRow(page, pages.length)],
      });
    })().catch(() => {
      /* the interaction expired mid-flight; nothing useful to say */
    });
  });

  collector.on("end", () => {
    void resource.edit({ components: [] }).catch(() => {
      /* message deleted or token expired */
    });
  });
}
