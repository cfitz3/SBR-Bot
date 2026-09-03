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
import { FLATTEN_SEPARATOR, type ActionRowView, type EmbedView } from "@sbr/shared-types";
import {
  ComponentType,
  MessageFlags,
  type ChatInputCommandInteraction,
  type ContainerBuilder,
} from "discord.js";
import { replyOptions, type ReplyView } from "./reply.js";
import { toContainer } from "./render-v2.js";

/** How long the page buttons stay live. Discord tokens expire at 15 minutes. */
const PAGER_TTL_MS = 5 * 60_000;

const PREV = "pager:prev";
const NEXT = "pager:next";

function navRow(page: number, total: number, live: boolean): ActionRowView {
  return {
    buttons: [
      {
        customId: PREV,
        label: "Previous",
        style: "SECONDARY",
        ...(live && page > 0 ? {} : { disabled: true }),
      },
      {
        customId: NEXT,
        label: "Next",
        style: "SECONDARY",
        ...(live && page < total - 1 ? {} : { disabled: true }),
      },
    ],
  };
}

/**
 * One page as a whole container.
 *
 * Under V2 the nav row lives inside the card it pages, so a page turn rebuilds
 * the container rather than swapping an embed out from under a detached row.
 */
function pageContainer(
  pages: readonly EmbedView[],
  index: number,
  rows: readonly ActionRowView[],
  live = true,
): ContainerBuilder {
  const view = pages[index]!;
  // Append the position to whatever footer the handler set, rather than
  // replacing it — the staleness note lives there too.
  const footer = view.footer
    ? `${view.footer}${FLATTEN_SEPARATOR}page ${index + 1}/${pages.length}`
    : `page ${index + 1}/${pages.length}`;
  return toContainer({ ...view, footer }, [...rows, navRow(index, pages.length, live)]);
}

export async function respond(i: ChatInputCommandInteraction, reply: ReplyView): Promise<void> {
  const pages = reply.pages;
  if (!pages || pages.length <= 1) {
    await i.reply(replyOptions(reply));
    return;
  }

  let page = 0;
  const base = replyOptions(reply);
  const rows = reply.components ?? [];
  const message = await i.reply({
    ...base,
    components: [pageContainer(pages, page, rows)],
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
        // A plain sentence, not a container: this one is an aside to the
        // presser, and it is not the card being paged.
        await button.reply({ content: "That's not your list.", flags: MessageFlags.Ephemeral });
        return;
      }
      page = button.customId === NEXT ? Math.min(page + 1, pages.length - 1) : Math.max(page - 1, 0);
      await button.update({
        components: [pageContainer(pages, page, rows)],
        flags: MessageFlags.IsComponentsV2,
      });
    })().catch(() => {
      /* the interaction expired mid-flight; nothing useful to say */
    });
  });

  collector.on("end", () => {
    // The card stays; only its controls go dead. Clearing `components` outright
    // would clear the message itself under V2, since the card *is* a component.
    void resource
      .edit({
        components: [pageContainer(pages, page, rows, false)],
        flags: MessageFlags.IsComponentsV2,
      })
      .catch(() => {
        /* message deleted or token expired */
      });
  });
}
