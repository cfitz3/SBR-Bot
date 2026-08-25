/**
 * A paced, serial queue for commands typed by the bridge account.
 *
 * Hypixel rate-limits commands per account, and the account this process types
 * as is the whole relay. Getting it silenced does not degrade one feature; it
 * takes guild chat off Discord entirely and needs a human with the account's
 * credentials to fix. That risk is why `/g online` already sits behind a 20s
 * shared cache, and it is the same risk here: a moderation bus is a queue
 * somebody else fills, so a mass-ban script in the panel would otherwise become
 * a burst of guild commands at whatever rate the panel could publish them.
 *
 * So: one command at a time, at least `spacingMs` apart, with a bounded backlog.
 *
 * **Overflow drops the newest, not the oldest.** A full queue means commands are
 * arriving faster than the account may send them, and in that state the backlog
 * is already the punishments staff issued first — dropping those to make room
 * for later ones would silently reorder enforcement. The drop is reported so it
 * is visible rather than inferred.
 *
 * Kept in its own module, with time injected, because pacing is exactly the kind
 * of logic that is untestable once it is tangled up with a Mineflayer session.
 */

export interface CommandQueueOptions {
  /** Minimum gap between two sends. */
  readonly spacingMs: number;
  /** How many commands may wait. Beyond this, new ones are refused. */
  readonly maxBacklog: number;
  /**
   * How long a command may wait for a session before it is abandoned.
   *
   * Without this the queue would hold a mute through an overnight outage and
   * deliver it at breakfast, against a punishment that expired hours earlier.
   * Late enforcement is its own kind of wrong answer.
   */
  readonly maxAgeMs: number;
  /** Injectable so tests do not sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface CommandQueueStats {
  readonly queued: number;
  readonly sent: number;
  /** Refused because the backlog was full. */
  readonly dropped: number;
  /** Abandoned because no session appeared before `maxAgeMs`. */
  readonly expired: number;
  /** Ordinary commands displaced to make room for an urgent one. */
  readonly evicted: number;
}

/**
 * Per-command overrides. Both exist for the same caller: a join accept.
 *
 * Hypixel gives an applicant five minutes, and the whole point of the queue is
 * that it holds commands — through a reconnect, behind whatever backlog staff
 * have already built up. Those two facts are in direct conflict for exactly one
 * kind of command, so rather than weaken the pacing for everything, the command
 * with a deadline says so.
 */
export interface CommandOptions {
  /**
   * Send this before the ordinary backlog, and keep it when the backlog is
   * full by displacing an ordinary command instead of being refused.
   *
   * Deliberately not a general priority number. Two levels is enough to express
   * "this has an upstream deadline" and few enough that nobody can build a
   * hierarchy in which the important thing is at level three.
   */
  readonly urgent?: boolean;
  /**
   * Abandon this command after `maxAgeMs` rather than the queue's default.
   *
   * Sending it late is not a lesser success, it is a different and wrong
   * action: `/guild accept` after the window has closed is a command Hypixel
   * answers with an error, against a row we would then have marked ACCEPTED.
   */
  readonly maxAgeMs?: number;
  /**
   * Called the moment the line reaches the session, and once only.
   *
   * `push` returning true means the queue accepted the command, not that
   * anybody typed it — the two can be ten minutes and a reconnect apart. The
   * caller waiting to hear whether a ban took effect needs the second event,
   * so the queue reports it rather than leaving it to be inferred from stats.
   */
  readonly onSent?: () => void;
  /**
   * Called instead of `onSent` when the command is discarded untyped — aged
   * out waiting for a session, or displaced to make room for an urgent one.
   *
   * Exactly one of the two hooks fires for any command `push` accepted, which
   * is what lets a caller wait on an answer instead of on a timeout.
   */
  readonly onExpired?: () => void;
}

interface QueuedCommand {
  readonly command: string;
  readonly at: number;
  readonly urgent: boolean;
  readonly maxAgeMs: number;
  readonly onSent: (() => void) | undefined;
  readonly onExpired: (() => void) | undefined;
}

/**
 * Run a caller's callback without letting it break the drain.
 *
 * These fire into a Redis publish and a log write, either of which can throw
 * on a bad day. A queue that stopped pacing commands because an ack failed to
 * send would trade the small problem for the one the pacing exists to prevent.
 */
function notify(hook: (() => void) | undefined): void {
  if (hook === undefined) return;
  try {
    hook();
  } catch {
    // Reported by whatever the hook was writing to, or not at all.
  }
}

export class CommandQueue {
  private readonly pending: QueuedCommand[] = [];
  private readonly spacingMs: number;
  private readonly maxBacklog: number;
  private readonly maxAgeMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private draining = false;
  private lastSentAt = 0;
  private sent = 0;
  private dropped = 0;
  private expired = 0;
  private evicted = 0;

  constructor(
    /**
     * Where a command actually goes. Returns false when there is no live
     * session — the queue then holds the line rather than discarding it, since
     * a reconnect is usually seconds away and a mute that never arrives is
     * worse than one that arrives late.
     */
    private readonly deliver: (command: string) => boolean,
    opts: CommandQueueOptions,
  ) {
    this.spacingMs = opts.spacingMs;
    this.maxBacklog = opts.maxBacklog;
    this.maxAgeMs = opts.maxAgeMs;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Enqueue a command. Returns false when it could not be taken.
   *
   * An urgent command is placed after any urgent commands already waiting and
   * ahead of every ordinary one, and if the backlog is full it displaces the
   * newest ordinary command rather than being refused — the same
   * drop-the-newest rule the queue already applies, applied one level down.
   * When the backlog is *entirely* urgent it is refused like anything else:
   * silently sending everything at that point would defeat the pacing the queue
   * exists for, and the account it protects is the whole relay.
   */
  push(command: string, opts: CommandOptions = {}): boolean {
    const urgent = opts.urgent === true;
    const entry: QueuedCommand = {
      command,
      at: this.now(),
      urgent,
      maxAgeMs: opts.maxAgeMs ?? this.maxAgeMs,
      onSent: opts.onSent,
      onExpired: opts.onExpired,
    };

    if (this.pending.length >= this.maxBacklog) {
      if (!urgent || !this.displaceOrdinary()) {
        this.dropped += 1;
        return false;
      }
    }

    if (urgent) {
      // First position not already claimed by an urgent command. Urgent
      // commands therefore stay in arrival order among themselves: two
      // applicants inside the same window are both on a clock, and the one who
      // asked first has less of it left.
      let at = 0;
      while (at < this.pending.length && this.pending[at]?.urgent === true) at += 1;
      this.pending.splice(at, 0, entry);
    } else {
      this.pending.push(entry);
    }

    void this.drain();
    return true;
  }

  stats(): CommandQueueStats {
    return {
      queued: this.pending.length,
      sent: this.sent,
      dropped: this.dropped,
      expired: this.expired,
      evicted: this.evicted,
    };
  }

  /** Drop the newest ordinary command to make room. False when there is none. */
  private displaceOrdinary(): boolean {
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const victim = this.pending[i];
      if (victim !== undefined && !victim.urgent) {
        this.pending.splice(i, 1);
        this.evicted += 1;
        notify(victim.onExpired);
        return true;
      }
    }
    return false;
  }

  /** Await the backlog clearing. Only tests need this; production is fire-and-forget. */
  async idle(): Promise<void> {
    while (this.draining || this.pending.length > 0) await this.sleep(0);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const wait = this.spacingMs - (this.now() - this.lastSentAt);
        if (wait > 0) await this.sleep(wait);

        const entry = this.pending[0];
        if (entry === undefined) break;
        if (this.now() - entry.at >= entry.maxAgeMs) {
          this.pending.shift();
          this.expired += 1;
          notify(entry.onExpired);
          continue;
        }
        if (!this.deliver(entry.command)) {
          // No live session. Wait a beat and try the same command again rather
          // than consuming it — this is the one case where holding the line is
          // right, because a reconnect is usually seconds away. The age check
          // above is what stops that becoming an indefinite hold.
          await this.sleep(this.spacingMs);
          continue;
        }
        this.pending.shift();
        this.lastSentAt = this.now();
        this.sent += 1;
        notify(entry.onSent);
      }
    } finally {
      this.draining = false;
    }
  }
}
