/**
 * What a play session is, and what the tracker hands back when one changes.
 *
 * "Playtime" here means time the guild's own bridge account saw a member
 * present in guild chat. That is narrower than "time played", and deliberately
 * so: Hypixel tells the bridge when somebody logs in and out of the guild's
 * view, and nothing else. A member playing on another account, or with guild
 * notifications off, is not measured. The wording on every surface says
 * "playing" rather than "online" for the same reason it says nothing at all
 * about members the bridge never saw.
 */

/** A session that has ended, and is worth keeping. */
export interface PlaySession {
  readonly ign: string;
  readonly startedAt: string;
  readonly endedAt: string;
  /** Whole seconds, computed once at close so no reader has to re-derive it. */
  readonly seconds: number;
}

/** A session still running, as `/online` needs to render it. */
export interface LiveSession {
  readonly ign: string;
  readonly startedAt: string;
}

/**
 * What observing one presence line did.
 *
 * `null` is the common case and is not an error: a login for somebody already
 * counted as present, or a logout inside the reconnect window, changes nothing
 * that anyone downstream needs to hear about.
 */
export type PlaytimeEffect =
  | { readonly kind: "STARTED"; readonly ign: string; readonly startedAt: string }
  | { readonly kind: "ENDED"; readonly session: PlaySession };

/** Where finished sessions go. Injected, so the tracker itself stays pure. */
export interface PlaySessionSink {
  record(guildId: string, session: PlaySession): Promise<void>;
}
