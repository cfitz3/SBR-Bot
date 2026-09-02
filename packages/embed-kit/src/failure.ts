/**
 * What a member sees when a command fails, and the one way out of it.
 *
 * The old shape was a sentence per call site describing what had gone wrong.
 * That reads as informative and is not: a member cannot act on "the progression
 * service threw", and the wording drifted per surface until the same failure
 * said three different things. So every platform failure now says the same two
 * things — it didn't complete, and `/health` will tell you whether that is us —
 * and offers one button.
 *
 * The button opens a ticket in the `BUG` category, which is why that category
 * is permanent (`@sbr/tickets`): a guild that deleted or disabled it would
 * break this button for every member, silently, at the moment something else is
 * already failing. Its label and emoji come from the brand layer, so a guild can
 * dress it however it likes; there is no key that turns it off.
 */
import { copy } from "@sbr/brand";
import type { ActionRowView } from "@sbr/shared-types";

/**
 * The ticket button's id, matching `newTicketId("BUG")` in `@sbr/tickets`.
 *
 * Written out rather than imported: this package sits under both command
 * packages and the gallery, and giving it a ticket dependency to build one
 * eleven-character string would be the wrong trade. `commands.test.ts` in the
 * gallery — the one package that can see both — asserts the two agree, so a
 * change to the namespace fails a test rather than a button.
 */
export const BUG_TICKET_BUTTON_ID = "tkt:new:BUG";

/** Which failures the button belongs on. */
export type FailureKind =
  /** A handler threw. Nobody expected this, so somebody should hear about it. */
  | "BUG"
  /** An upstream we do not run is not answering. A bug report helps no one. */
  | "UPSTREAM";

/**
 * The row under a failed command.
 *
 * Absent for `UPSTREAM`: inviting a bug report about Hypixel being down puts a
 * member through a form to tell staff something staff already know and cannot
 * fix, and buries the real reports under it.
 */
export function failureComponents(kind: FailureKind): readonly ActionRowView[] {
  if (kind !== "BUG") return [];
  const label = copy.error.report.button;
  const emoji = copy.error.report.emoji;
  return [
    {
      buttons: [
        {
          label,
          style: "SECONDARY",
          customId: BUG_TICKET_BUTTON_ID,
          ...(emoji === "" ? {} : { emoji }),
        },
      ],
    },
  ];
}

/**
 * The whole reply: text and, when it earns one, the button.
 *
 * Both dispatchers call this instead of composing their own, which is the point
 * — the previous arrangement had each of them holding its own opinion about how
 * much of the failure to explain.
 */
export function failureReply(kind: FailureKind): {
  readonly ephemeral: true;
  readonly text: string;
  readonly components?: readonly ActionRowView[];
} {
  const text = kind === "UPSTREAM" ? copy.error.generic.upstreamDown : copy.error.generic.unknown;
  const components = failureComponents(kind);
  return components.length > 0 ? { ephemeral: true, text, components } : { ephemeral: true, text };
}
