/**
 * The card a repost action sends.
 *
 * A starboard post is a quotation, so the card is built as one: the person
 * quoted is the subject (author row and avatar, never a field), what they said
 * is the headline, and everything about *why* it is here — the count, the
 * channel, the link back — is one consolidated field rather than four.
 *
 * The link is on the field and on the card's `url`, not printed as a bare
 * snowflake anywhere: a repost whose original cannot be reached is a screenshot.
 */
import { copy } from "@sbr/brand";
import { card, facts } from "@sbr/embed-kit";
import type { EmbedView } from "@sbr/shared-types";

const C = copy.embed.card;
const F = copy.embed.field;

export interface TriggerPostView {
  /** What staff called the rule — two boards should not look like one. */
  readonly label: string;
  /** The quoted message's author, as Discord shows them. */
  readonly authorName: string;
  readonly authorAvatarUrl: string | null;
  /** The message text. Empty is legal: an image with no caption is common. */
  readonly content: string;
  /** The first image on the original, if any, so the card shows what was posted. */
  readonly imageUrl: string | null;
  /** True when the original carries attachments the card cannot show. */
  readonly hasOtherAttachments: boolean;
  readonly channelId: string;
  readonly jumpUrl: string;
  /** The emoji and count that put it here, or null for a non-reaction rule. */
  readonly reaction: { readonly emoji: string; readonly count: number } | null;
  /** The original's timestamp — the card is about when it was said, not when it was reposted. */
  readonly postedAt: string;
}

export function renderTriggerPostEmbed(view: TriggerPostView): EmbedView {
  return card({
    tone: "NEUTRAL",
    title: C.triggerTitle.replace("{label}", view.label),
    // The quotation is the headline because it is what a reader came for. An
    // empty one is said plainly rather than left blank, which would render as a
    // card with a name and no reason to exist.
    headline: view.content.trim() === "" ? C.triggerEmpty : view.content,
    subject: {
      author: {
        name: view.authorName,
        ...(view.authorAvatarUrl === null ? {} : { iconUrl: view.authorAvatarUrl }),
      },
    },
    ...(view.imageUrl === null ? {} : { imageUrl: view.imageUrl }),
    url: view.jumpUrl,
    fields: [
      {
        name: F.context,
        value: facts([
          ...(view.reaction === null
            ? []
            : [
                {
                  label: F.reactions,
                  value: C.triggerReactions
                    .replace("{count}", String(view.reaction.count))
                    .replace("{emoji}", view.reaction.emoji),
                },
              ]),
          { label: F.channel, value: `<#${view.channelId}>` },
          { label: F.source, value: `[${C.triggerJump}](${view.jumpUrl})` },
          ...(view.hasOtherAttachments ? [{ label: F.attachments, value: C.triggerAttachment }] : []),
        ]),
      },
    ],
    footer: C.triggerFooter,
    // The original's time, not the repost's: a message starred a day later is
    // still a message from yesterday, and saying otherwise misdates the quote.
    timestamp: view.postedAt,
  });
}
