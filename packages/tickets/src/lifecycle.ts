/**
 * The ticket's state machine, and the clocks that close one on its own.
 *
 * Pure: every transition takes the ticket, who is asking, and the time, and
 * returns either the change to apply or a refusal with a reason. The Discord
 * side and the panel both go through here, which is what stops the two from
 * disagreeing about who may close what — the specific hole in the old code,
 * where `/ticket action:close` checked neither ownership nor rank.
 */
import type { TicketDTO, TicketSettingsDTO } from "@sbr/shared-types";

export type LifecycleRefusal =
  | "ALREADY_CLOSED"
  | "NOT_CLAIMABLE"
  | "ALREADY_CLAIMED"
  | "NOT_CLAIMED"
  | "NOT_THE_CLAIMANT"
  | "FORBIDDEN";

export interface Actor {
  readonly discordId: string;
  /** Whether the actor holds `TICKET_MANAGE` — the capability, not a role list. */
  readonly isStaff: boolean;
}

export type LifecycleResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: LifecycleRefusal };

function deny(reason: LifecycleRefusal): { readonly ok: false; readonly reason: LifecycleRefusal } {
  return { ok: false, reason };
}

function allow<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

/**
 * Who may act on a ticket at all: its opener, or staff.
 *
 * The old command took a ticket id and did no check whatsoever, so any member
 * who could guess or read an id could close anyone's ticket. This is that fix.
 */
export function canAct(ticket: TicketDTO, actor: Actor): boolean {
  return actor.isStaff || ticket.openerDiscordId === actor.discordId;
}

export interface ClaimChange {
  readonly claimedByDiscordId: string;
  readonly claimedAt: Date;
}

export function claim(
  ticket: TicketDTO,
  actor: Actor,
  categoryAllowsClaiming: boolean,
  now: Date,
): LifecycleResult<ClaimChange> {
  if (ticket.status === "CLOSED") return deny("ALREADY_CLOSED");
  if (!actor.isStaff) return deny("FORBIDDEN");
  if (!categoryAllowsClaiming) return deny("NOT_CLAIMABLE");
  if (ticket.claimedByDiscordId !== null) return deny("ALREADY_CLAIMED");
  return allow({ claimedByDiscordId: actor.discordId, claimedAt: now });
}

/** Releasing is the claimant's to do, or any staff member's — a claimant who
 *  goes offline should not be able to hold a ticket hostage. */
export function release(ticket: TicketDTO, actor: Actor): LifecycleResult<null> {
  if (ticket.status === "CLOSED") return deny("ALREADY_CLOSED");
  if (!actor.isStaff) return deny("FORBIDDEN");
  if (ticket.claimedByDiscordId === null) return deny("NOT_CLAIMED");
  return allow(null);
}

/** Transfer is a re-claim: same rules, but an existing claim is expected. */
export function transfer(
  ticket: TicketDTO,
  actor: Actor,
  toDiscordId: string,
  now: Date,
): LifecycleResult<ClaimChange> {
  if (ticket.status === "CLOSED") return deny("ALREADY_CLOSED");
  if (!actor.isStaff) return deny("FORBIDDEN");
  return allow({ claimedByDiscordId: toDiscordId, claimedAt: now });
}

export interface CloseRequestChange {
  readonly closeRequestedByDiscordId: string;
  readonly closeRequestedAt: Date;
}

export function requestClose(ticket: TicketDTO, actor: Actor, now: Date): LifecycleResult<CloseRequestChange> {
  if (ticket.status === "CLOSED") return deny("ALREADY_CLOSED");
  if (!canAct(ticket, actor)) return deny("FORBIDDEN");
  return allow({ closeRequestedByDiscordId: actor.discordId, closeRequestedAt: now });
}

export function close(ticket: TicketDTO, actor: Actor): LifecycleResult<null> {
  if (ticket.status === "CLOSED") return deny("ALREADY_CLOSED");
  if (!canAct(ticket, actor)) return deny("FORBIDDEN");
  return allow(null);
}

// ── the clocks ──────────────────────────────────────────────────────────────

/**
 * Why the sweep would touch a ticket.
 *
 * `PENDING_CLOSURE` is the reference implementation's rule, and it is subtler
 * than "close after N hours": a close request counts only while it stands. Five
 * further messages mean the conversation resumed, so the request is treated as
 * withdrawn rather than as a countdown nobody noticed.
 */
export type SweepAction = "NONE" | "WARN_STALE" | "AUTO_CLOSE";

export interface SweepInput {
  readonly ticket: TicketDTO;
  readonly settings: TicketSettingsDTO;
  /** Messages captured since the close request. Zero when there is no request. */
  readonly messagesSinceCloseRequest: number;
  /** Whether the stale warning has already been posted, so it is posted once. */
  readonly staleWarned: boolean;
  readonly now: Date;
}

/** Messages after a close request that count as "the conversation resumed". */
export const RESUME_MESSAGE_COUNT = 5;

function minutesSince(from: string | null, now: Date): number | null {
  if (from === null) return null;
  const at = Date.parse(from);
  if (Number.isNaN(at)) return null;
  return (now.getTime() - at) / 60_000;
}

/**
 * Whether a ticket is pending closure: a standing close request, or silence
 * past the stale threshold.
 */
export function isPendingClosure(input: SweepInput): boolean {
  const { ticket, settings } = input;
  if (ticket.status === "CLOSED") return false;

  if (ticket.closeRequestedAt !== null && input.messagesSinceCloseRequest < RESUME_MESSAGE_COUNT) {
    return true;
  }

  if (settings.staleAfterMinutes !== null) {
    const quiet = minutesSince(ticket.lastMessageAt ?? ticket.createdAt, input.now);
    if (quiet !== null && quiet >= settings.staleAfterMinutes) return true;
  }
  return false;
}

/**
 * What the sweep should do with this ticket right now.
 *
 * The auto-close clock runs from whichever event made the ticket pending: the
 * close request if there is one, otherwise the last message. Measuring from
 * ticket creation instead would close long, healthy conversations.
 */
export function sweep(input: SweepInput): SweepAction {
  const { ticket, settings } = input;
  if (ticket.status === "CLOSED") return "NONE";
  if (!isPendingClosure(input)) return "NONE";

  const since =
    ticket.closeRequestedAt !== null && input.messagesSinceCloseRequest < RESUME_MESSAGE_COUNT
      ? minutesSince(ticket.closeRequestedAt, input.now)
      : minutesSince(ticket.lastMessageAt ?? ticket.createdAt, input.now);

  if (since !== null && since >= settings.autoCloseAfterMinutes) return "AUTO_CLOSE";
  return input.staleWarned ? "NONE" : "WARN_STALE";
}

/**
 * Mean ms from open to first staff reply, over tickets that got one.
 *
 * Tickets with no staff reply are *excluded*, not counted as zero — including
 * them would make an ignored queue look fast, which is precisely backwards.
 * Null when nothing qualifies, which renders as "—".
 */
export function averageResponseTimeMs(tickets: readonly TicketDTO[]): number | null {
  const spans = tickets
    .filter((t) => t.firstStaffReplyAt !== null)
    .map((t) => Date.parse(t.firstStaffReplyAt as string) - Date.parse(t.createdAt))
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  if (spans.length === 0) return null;
  return spans.reduce((a, b) => a + b, 0) / spans.length;
}

/** Mean ms from open to close, over closed tickets. Null when none are closed. */
export function averageResolutionTimeMs(tickets: readonly TicketDTO[]): number | null {
  const spans = tickets
    .filter((t) => t.closedAt !== null)
    .map((t) => Date.parse(t.closedAt as string) - Date.parse(t.createdAt))
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  if (spans.length === 0) return null;
  return spans.reduce((a, b) => a + b, 0) / spans.length;
}

/** Mean feedback rating. Null when nobody has rated — never 0. */
export function averageRating(tickets: readonly TicketDTO[]): number | null {
  const ratings = tickets.map((t) => t.feedbackRating).filter((r): r is number => r !== null);
  if (ratings.length === 0) return null;
  return ratings.reduce((a, b) => a + b, 0) / ratings.length;
}
