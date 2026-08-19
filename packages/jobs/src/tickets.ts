/**
 * ticket-sweep: warn quiet tickets, and close the ones nobody came back to.
 *
 * The *decision* is `sweep()` in `@sbr/tickets`, and it runs in the bridge bot,
 * because carrying it out means posting in a Discord channel and disposing of
 * one — neither of which this process can do. What lives here is the part that
 * genuinely belongs to a scheduled job: walking every guild, remembering which
 * tickets have already been warned, and making sure one guild's failure does
 * not cost the rest of them their run.
 *
 * `staleWarned` is kept here rather than in a database column on purpose. It is
 * a fact about a notification, not about the ticket, and its worst failure mode
 * — a warning repeated after a restart — is far milder than the column's, which
 * is a schema migration for a boolean that expires on its own.
 */

/** What the gateway did with one ticket. Mirrors `SweepAction` in `@sbr/tickets`. */
export type TicketSweepAction = "NONE" | "WARN_STALE" | "AUTO_CLOSE";

/** All the sweep needs to know about a ticket; the gateway re-reads the rest. */
export interface SweepableTicket {
  readonly id: string;
  readonly guildId: string;
}

export interface TicketSweepDeps {
  /** Guilds to walk. Every active guild, in practice. */
  listGuilds(): Promise<readonly string[]>;
  /** Open and pending tickets in one guild. */
  listSweepable(guildId: string): Promise<readonly SweepableTicket[]>;
  /** Has this ticket already been told it is going quiet? */
  wasWarned(ticketId: string): Promise<boolean>;
  /** Remember that it has been, for as long as the memory is useful. */
  rememberWarned(ticketId: string): Promise<void>;
  /** Forget a ticket that is no longer open, so the key does not outlive it. */
  forgetWarned(ticketId: string): Promise<void>;
  /**
   * Ask the bridge bot to sweep one ticket and carry out the answer.
   *
   * Null means the call did not happen — the bridge is down, or the ticket is
   * gone. Either way the next run tries again, so nothing is recorded for it.
   */
  sweepOne(ticket: SweepableTicket, staleWarned: boolean): Promise<TicketSweepAction | null>;
  /** Reported rather than thrown: one bad guild must not end the pass. */
  onError(scope: string, error: unknown): void;
}

/**
 * Sweep every guild's open tickets. Returns how many were acted on — warned or
 * closed — which is what the job log shows.
 *
 * Tickets that come back `NONE` are left exactly as they are, including their
 * warned flag. Clearing it on `NONE` would look tidier, but `NONE` covers both
 * "somebody replied, this is alive again" and "still quiet, already warned",
 * and the two are indistinguishable from the action alone. Letting the flag
 * expire on its own TTL means a ticket that goes quiet a second time is warned
 * a second time, a day later, without this file having to guess which case it
 * is looking at.
 */
export async function sweepTickets(deps: TicketSweepDeps): Promise<number> {
  let acted = 0;

  let guilds: readonly string[];
  try {
    guilds = await deps.listGuilds();
  } catch (error) {
    deps.onError("guild list", error);
    return 0;
  }

  for (const guildId of guilds) {
    let tickets: readonly SweepableTicket[];
    try {
      tickets = await deps.listSweepable(guildId);
    } catch (error) {
      deps.onError(`guild ${guildId}`, error);
      continue;
    }

    for (const ticket of tickets) {
      try {
        const warned = await deps.wasWarned(ticket.id);
        const action = await deps.sweepOne(ticket, warned);
        if (action === "WARN_STALE") {
          await deps.rememberWarned(ticket.id);
          acted += 1;
        } else if (action === "AUTO_CLOSE") {
          await deps.forgetWarned(ticket.id);
          acted += 1;
        }
      } catch (error) {
        deps.onError(`ticket ${ticket.id}`, error);
      }
    }
  }

  return acted;
}
