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
}

interface QueuedCommand {
  readonly command: string;
  readonly at: number;
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

  /** Enqueue a command. Returns false when the backlog is full and it was dropped. */
  push(command: string): boolean {
    if (this.pending.length >= this.maxBacklog) {
      this.dropped += 1;
      return false;
    }
    this.pending.push({ command, at: this.now() });
    void this.drain();
    return true;
  }

  stats(): CommandQueueStats {
    return { queued: this.pending.length, sent: this.sent, dropped: this.dropped, expired: this.expired };
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
        if (this.now() - entry.at >= this.maxAgeMs) {
          this.pending.shift();
          this.expired += 1;
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
      }
    } finally {
      this.draining = false;
    }
  }
}
