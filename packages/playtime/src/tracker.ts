/**
 * Turns Hypixel's presence notices into sessions.
 *
 * `Guild > Steve joined.` and `Guild > Steve left.` are the only signal there
 * is, and they are noisy: a member crossing a server boundary, or a lobby
 * hiccup, produces a leave immediately followed by a join. Ending a session on
 * every leave would turn one evening into forty sessions of a minute each and
 * make the totals useless.
 *
 * So a leave does not end anything. It starts a grace period. If the member is
 * back inside it, nothing happened — the session continues, unbroken, and the
 * gap is counted as played, which is the honest reading of a two-second
 * disconnect. If they are not, the session closes **at the moment they left**,
 * not at the moment the sweep noticed: crediting the grace window to everybody
 * would inflate every session on the server by the same constant.
 *
 * The tracker holds no timers and does no I/O. It is advanced by `observe` and
 * `sweep`, both of which take the current time, so the whole state machine is
 * testable without waiting for anything.
 */
import type { LiveSession, PlaySession, PlaytimeEffect } from "./types.js";

/**
 * How long a member may be gone before the session closes.
 *
 * 90 seconds: long enough to cover a lobby transfer and a slow reconnect, short
 * enough that somebody who logged off for the night is not still shown as
 * playing when a guildmate types `/online` two minutes later.
 */
export const RECONNECT_GRACE_MS = 90_000;

/**
 * Sessions shorter than this are dropped rather than recorded.
 *
 * A login and a logout thirty seconds apart is somebody checking their bazaar
 * orders. Keeping it costs a row and moves no total worth moving, and a
 * leaderboard built on such rows rewards relogging.
 */
export const MIN_SESSION_MS = 60_000;

interface Entry {
  readonly ign: string;
  readonly startedAt: number;
  /** True when the start time came from a roster read rather than a login. */
  readonly estimated: boolean;
  /** When they were last seen leaving, while the grace period is running. */
  leftAt: number | null;
}

export interface TrackerOptions {
  readonly graceMs?: number;
  readonly minSessionMs?: number;
}

export class PlaytimeTracker {
  readonly #entries = new Map<string, Entry>();
  readonly #graceMs: number;
  readonly #minMs: number;

  constructor(options: TrackerOptions = {}) {
    this.#graceMs = options.graceMs ?? RECONNECT_GRACE_MS;
    this.#minMs = options.minSessionMs ?? MIN_SESSION_MS;
  }

  /**
   * Record a presence notice.
   *
   * Returns what changed, or null — which is the common answer. A second login
   * for somebody already present, or a logout for somebody we never saw arrive,
   * are both ordinary consequences of the bridge having started mid-evening.
   */
  observe(ign: string, kind: "ONLINE" | "OFFLINE", at: Date): PlaytimeEffect | null {
    const key = ign.toLowerCase();
    const now = at.getTime();
    const entry = this.#entries.get(key);

    if (kind === "ONLINE") {
      if (entry) {
        // Back inside the grace period, or a duplicate notice. Either way the
        // session they already have is the right one.
        entry.leftAt = null;
        return null;
      }
      this.#entries.set(key, { ign, startedAt: now, estimated: false, leftAt: null });
      return { kind: "STARTED", ign, startedAt: at.toISOString() };
    }

    if (!entry || entry.leftAt !== null) return null;
    entry.leftAt = now;
    return null;
  }

  /**
   * Close every session whose grace period has run out.
   *
   * Called on a timer by the host. Sessions under the floor are discarded here
   * rather than filtered downstream, so nothing has to remember the rule twice.
   */
  sweep(at: Date): readonly PlaytimeEffect[] {
    const now = at.getTime();
    const out: PlaytimeEffect[] = [];
    for (const [key, entry] of this.#entries) {
      if (entry.leftAt === null || now - entry.leftAt < this.#graceMs) continue;
      this.#entries.delete(key);
      const ms = entry.leftAt - entry.startedAt;
      if (ms < this.#minMs) continue;
      out.push({ kind: "ENDED", session: this.#close(entry, entry.leftAt, ms) });
    }
    return out;
  }

  /**
   * Everyone the tracker currently believes is playing.
   *
   * Members inside the grace period are included: from the reader's side a
   * two-second reconnect is not an absence, and blinking them out of `/online`
   * would make the command look broken rather than precise.
   */
  live(): readonly LiveSession[] {
    return [...this.#entries.values()].map((e) => ({ ign: e.ign, startedAt: new Date(e.startedAt).toISOString() }));
  }

  /** Whether this member's start time is a login or a lower bound from a roster read. */
  isEstimated(ign: string): boolean {
    return this.#entries.get(ign.toLowerCase())?.estimated ?? false;
  }

  /**
   * Fold in a roster read.
   *
   * The bridge restarts, and every session it was holding goes with it — but
   * the members are still playing, and `/online` would report the whole guild
   * as having just arrived. A roster read is the only way back: anybody present
   * and untracked gets a session starting now, marked estimated so the card can
   * say "at least this long" rather than assert a start it does not know.
   *
   * The reverse is also worth doing. A leave notice the bridge missed — it was
   * disconnected, or Hypixel simply did not print one — leaves a session
   * running forever. Anybody tracked but absent from a roster read is closed,
   * at the read, because that is the last moment we can honestly claim.
   */
  reconcile(igns: readonly string[], at: Date): readonly PlaytimeEffect[] {
    const now = at.getTime();
    const present = new Set(igns.map((n) => n.toLowerCase()));
    const out: PlaytimeEffect[] = [];

    for (const ign of igns) {
      const key = ign.toLowerCase();
      const entry = this.#entries.get(key);
      if (entry) {
        // Seen in the roster, so they did not leave — clear any pending close.
        entry.leftAt = null;
        continue;
      }
      this.#entries.set(key, { ign, startedAt: now, estimated: true, leftAt: null });
      out.push({ kind: "STARTED", ign, startedAt: at.toISOString() });
    }

    for (const [key, entry] of this.#entries) {
      if (present.has(key)) continue;
      this.#entries.delete(key);
      const ms = now - entry.startedAt;
      if (ms < this.#minMs) continue;
      out.push({ kind: "ENDED", session: this.#close(entry, now, ms) });
    }
    return out;
  }

  #close(entry: Entry, endedAt: number, ms: number): PlaySession {
    return {
      ign: entry.ign,
      startedAt: new Date(entry.startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      seconds: Math.round(ms / 1000),
    };
  }
}
