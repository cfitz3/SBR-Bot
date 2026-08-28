/**
 * The join notice as a card.
 *
 * This used to be a block of plain text built in `report.ts`: bold heading,
 * a stat line, a bullet per finding. It was the wrong shape for the staff
 * channel, where the name, the verdict and the deadline all looked alike and
 * arrived beside embeds from every other part of the platform. A reviewer
 * scanning the channel had to read a paragraph to learn whether the paragraph
 * was for them.
 *
 * So the notice is a card, and it is laid out around the order a reviewer
 * actually asks things in: what happened (title), what was decided and how sure
 * the platform is (headline), what the account looks like, what we found, what
 * we already knew, and how long they have. Four fields, each holding several
 * facts, rather than eleven fields holding one each.
 *
 * The applicant is a *stranger*, which changes two things. Their identity goes
 * in the author row and thumbnail like any other player, but nothing they or a
 * third party wrote is ever a field name — a scammer-list reason is somebody
 * else's prose about somebody we have not met, and it belongs inside a value.
 * And the card never says more than the text report did: this is a rendering
 * change, not a disclosure one.
 */
import { copy } from "@sbr/brand";
import { card, facts, player, type Fact } from "@sbr/embed-kit";
import type { EmbedView, ViewColor } from "@sbr/shared-types";
import { formatCoins, reasonLines } from "./report.js";
import type { Screening } from "./types.js";

const C = copy.embed.card;
const F = copy.embed.field;

/** Named because a bare escape inside a joined array reads as a typo. */
const NEWLINE = "\n";

/**
 * What the notice is about — not what the screening concluded.
 *
 * `REVIEW` and `UNSCREENED` are the two that need a human, and they are the two
 * that get buttons and a staff ping; the rest are the record. Keeping that as a
 * kind on the view rather than deriving it from the verdict means the caller
 * that already knows it acted — because the accept command went out, or because
 * the player was simply already in the guild — does not have to re-derive it
 * from a policy decision that no longer describes the outcome.
 */
export type JoinNoticeKind = "REVIEW" | "ACCEPTED" | "DENIED" | "JOINED" | "UNSCREENED";

export interface JoinNoticeView {
  readonly kind: JoinNoticeKind;
  readonly ign: string;
  readonly uuid: string | null;
  /** The screening, or null when the account could not be resolved at all. */
  readonly screening: Screening | null;
  /** Epoch ms the request stops being answerable, when one is still open. */
  readonly deadlineAt: number | null;
  /** Epoch ms the request appeared in guild chat. Dates the card. */
  readonly seenAt: number;
}

/** The two kinds a human still has to answer. */
export function needsStaffDecision(kind: JoinNoticeKind): boolean {
  return kind === "REVIEW" || kind === "UNSCREENED";
}

const TONES: Readonly<Record<JoinNoticeKind, ViewColor>> = {
  REVIEW: "WARNING",
  ACCEPTED: "SUCCESS",
  DENIED: "DANGER",
  JOINED: "INFO",
  // Not DANGER: nothing is wrong with the applicant, something is wrong with
  // our lookup. Colouring an outage like a refusal would prime the reviewer to
  // deny somebody for a Mojang failure.
  UNSCREENED: "WARNING",
};

const TITLES: Readonly<Record<JoinNoticeKind, string>> = {
  REVIEW: C.joinReview,
  ACCEPTED: C.joinAccepted,
  DENIED: C.joinDenied,
  JOINED: C.joinJoined,
  UNSCREENED: C.joinUnscreened,
};

const HEADLINES: Readonly<Record<Exclude<JoinNoticeKind, "UNSCREENED">, string>> = {
  REVIEW: C.joinRisk,
  ACCEPTED: C.joinRiskAccepted,
  DENIED: C.joinRiskDenied,
  JOINED: C.joinRiskJoined,
};

/** A number a reviewer reads at a glance, or the unknown marker via `facts`. */
function stat(value: number | null, digits = 1): number | null {
  return value === null ? null : Number(value.toFixed(digits));
}

/**
 * A Discord relative timestamp.
 *
 * The one place the platform prints time as words rather than as the native
 * embed timestamp, and it is not an exception to that rule: `<t:…:R>` is
 * rendered by each reader's own client, so it keeps counting down in a channel
 * nobody is refreshing. A hand-typed "expires in 4 minutes" would be wrong by
 * the time the message finished sending.
 */
function relative(atMs: number): string {
  return `<t:${Math.floor(atMs / 1_000)}:R>`;
}

function accountField(screening: Screening): string {
  const s = screening.stats;
  return facts([
    { label: F.skyblockLevel, value: stat(s.skyblockLevel, 0) },
    { label: F.skillAverage, value: stat(s.skillAverage) },
    { label: F.catacombs, value: stat(s.catacombsLevel) },
    { label: F.weight, value: stat(s.senitherWeight, 0) },
    { label: F.networth, value: s.networth === null ? null : formatCoins(s.networth) },
    ...(s.profileName === null ? [] : [{ label: C.joinProfile, value: s.profileName }]),
  ]);
}

/**
 * What we found, as sentences.
 *
 * Bulleted rather than consolidated as labelled facts, because these are not
 * facts with names — they are the reasons, in severity order, and a reviewer
 * reads the list top to bottom and stops when one of them settles it. The
 * scammer listing and a screening error are appended as further lines rather
 * than as fields of their own: they are findings too, and the alternative is a
 * card whose field count depends on how badly the screening went.
 */
function findingsField(screening: Screening): string {
  const lines = reasonLines(screening.reasons).map((line) => `• ${line}`);
  if (screening.scammer.status === "FLAGGED" && screening.scammer.reason) {
    lines.push(`• ${C.joinScammerListing.replace("{reason}", screening.scammer.reason)}`);
  }
  if (screening.error) {
    lines.push(`• ${C.joinTrouble.replace("{detail}", screening.error)}`);
  }
  return lines.length === 0 ? C.joinNothingFound : lines.join("\n");
}

/**
 * What the guild already knew. Absent entirely when it knew nothing.
 *
 * Unlike the account block, an unknown here is omitted rather than printed as
 * the unknown marker: "we have no record of a previous removal" is the ordinary
 * case for every stranger, and a card that spelled it out three times would
 * bury the one applicant who *does* have a record.
 */
function historyField(screening: Screening): string {
  const entries: Fact[] = [];
  if (screening.stats.currentGuild) {
    entries.push({ label: C.joinCurrentGuild, value: screening.stats.currentGuild });
  }
  if (screening.discordId) {
    entries.push({ label: C.joinLinked, value: `<@${screening.discordId}>` });
  }
  if (screening.history.priorExpulsion && screening.history.expulsionReason) {
    entries.push({ label: C.joinPriorRemoval, value: screening.history.expulsionReason });
  }
  if (screening.history.recentAttempts > 0) {
    entries.push({
      label: C.joinAttemptsLabel,
      value: C.joinAttempts.replace("{n}", String(screening.history.recentAttempts)),
    });
  }
  return entries.length === 0 ? "" : facts(entries);
}

export function renderJoinNoticeEmbed(view: JoinNoticeView): EmbedView {
  const screening = view.screening;
  const headline =
    screening === null
      ? C.joinNoScreening
      : (HEADLINES[view.kind === "UNSCREENED" ? "REVIEW" : view.kind] ?? C.joinRisk).replace(
          "{n}",
          String(screening.riskScore),
        );

  // The deadline and what passing it costs, together: a countdown with no
  // consequence attached reads as urgency for its own sake, and the consequence
  // is the part a reviewer weighs — a missed window is not a refusal, it just
  // turns an accept into an invite somebody has to send by hand.
  const window =
    view.deadlineAt === null
      ? ""
      : [
          facts([{ label: C.joinDeadline, value: C.joinExpires.replace("{at}", relative(view.deadlineAt)) }]),
          C.joinExpiresNote,
        ].join(NEWLINE);

  return card({
    tone: TONES[view.kind],
    title: TITLES[view.kind],
    headline,
    subject: player(view.ign, view.uuid),
    fields: [
      screening === null ? null : { name: F.account, value: accountField(screening), inline: false },
      screening === null ? null : { name: F.findings, value: findingsField(screening), inline: false },
      screening === null ? null : { name: F.history, value: historyField(screening), inline: false },
      { name: F.window, value: window, inline: false },
    ],
    // A static note, and only where it is true: it explains what the buttons
    // under the card act on, so a reviewer pressing Accept on a five-minute-old
    // notice knows the answer goes to the request rather than to the message.
    ...(needsStaffDecision(view.kind) ? { footer: C.joinFooterPending } : {}),
    // The request's own clock, not the send: a notice delayed by a slow scammer
    // lookup should still be dated by when the applicant asked.
    timestamp: new Date(view.seenAt).toISOString(),
  });
}
