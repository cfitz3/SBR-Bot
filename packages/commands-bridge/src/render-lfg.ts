/**
 * The `/lfg` card — one member asking for a group, once.
 *
 * Deliberately not `render-community.ts`'s `renderLfgEmbed`, which renders the
 * retired *board* post: a run with slots, joins and an expiry that somebody had
 * to close. This is an announcement. It goes out, it is read, and it is over —
 * so there is no status, no member list and no id to quote back, and none of the
 * furniture those needed is here to go stale.
 *
 * Identity follows the card rules exactly: the requester is the subject, so
 * their IGN and head are the author row and their skin is the thumbnail, and the
 * Discord mention leads the headline because it is the thing a reader clicks to
 * answer. Everything else is four short facts, and each of them disappears
 * rather than printing a guess when it is not known.
 */
import { copy } from "@sbr/brand";
import { card, field, player } from "@sbr/embed-kit";
import type { DungeonFloor } from "@sbr/perms";
import type { EmbedView } from "@sbr/shared-types";

const C = copy.embed.card;
const F = copy.embed.field;

/** What the requester brings: the class they run, and how far they have run it. */
export interface LfgPlays {
  readonly role: string;
  readonly level: number;
}

/** Everything the card knows. Assembled by `lfg-request.ts`, never fetched here. */
export interface LfgRequestView {
  readonly ign: string;
  readonly uuid: string | null;
  readonly discordId: string;
  readonly floor: DungeonFloor;
  /** Canonical lowercase roles, in offer order. Empty means "any". */
  readonly classes: readonly string[];
  readonly catacombsLevel: number | null;
  readonly plays: LfgPlays | null;
  /** When the request was made, for the card's native timestamp. */
  readonly requestedAt: string;
}

/** Roles are stored lowercase because people type them; the card capitalises. */
function titleCase(role: string): string {
  return role.length === 0 ? role : role[0]!.toUpperCase() + role.slice(1);
}

export function renderLfgRequestCard(request: LfgRequestView): EmbedView {
  return card({
    tone: "INFO",
    title: C.lfgTitle,
    headline: C.lfgHeadline.replace("{who}", `<@${request.discordId}>`),
    subject: player(request.ign, request.uuid),
    fields: [
      field(F.floor, request.floor.label, true),
      // Absent rather than "unknown": a member whose profile is private is not a
      // member with no catacombs level, and the card should not imply otherwise.
      field(F.catacombs, request.catacombsLevel === null ? "" : String(request.catacombsLevel), true),
      field(F.plays, request.plays === null ? "" : `${titleCase(request.plays.role)} ${request.plays.level}`, true),
      // The one thing the reader is being asked for, so it gets the full width
      // rather than a third of a row.
      field(
        F.wanted,
        request.classes.length === 0 ? C.lfgAnyClass : request.classes.map(titleCase).join(", "),
      ),
    ],
    timestamp: request.requestedAt,
  });
}
