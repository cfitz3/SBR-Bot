/**
 * Echo suppression for the in-game side of the relay.
 *
 * Hypixel reflects the bridge account's own guild chat back to it, so every
 * line the bot sends with `/gc` arrives moments later as an ordinary
 * `Guild > BotIGN: …` message. Relayed naively that produced the duplicate
 * every Discord reader saw: their own message posted once by them and again by
 * the bridge, wearing the bot's name.
 *
 * The rule the transport applies is "self-authored guild chat is not relayed",
 * which fixes the duplicate but would also swallow the one piece of bot output
 * Discord genuinely wants: the answer to an in-game `!command`, which Discord
 * saw asked but would otherwise never see answered.
 *
 * This ledger is that exception list. A line is registered *before* it is sent,
 * and the echo it produces is claimed once on arrival. Everything else the bot
 * says stays in-game.
 *
 * Failing to match is deliberately the safe direction: an unclaimed echo is
 * dropped, so a missed match costs one answer in Discord rather than
 * reintroducing the duplicate.
 */

/** Echoes normally return within a second; a minute is slack, not a guess. */
const DEFAULT_TTL_MS = 60_000;

/**
 * Ceiling on retained entries. The ledger only ever holds lines the bot itself
 * emitted, so this is a backstop against a pathological answer loop rather than
 * an expected working size.
 */
const MAX_ENTRIES = 256;

export interface EchoLedgerOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/**
 * Compare on the text Hypixel will show, not the text we submitted: colour
 * codes are stripped by the server and runs of whitespace collapse, so a
 * byte-exact comparison would miss its own echo.
 */
export function echoKey(line: string): string {
  return line
    .replace(/§./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export class EchoLedger {
  private readonly entries = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: EchoLedgerOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Mark a line the bot is about to send as one whose echo should be relayed. */
  expect(line: string): void {
    const key = echoKey(line);
    if (key.length === 0) return;
    this.sweep();
    // Re-registering refreshes the deadline: the same answer sent twice is two
    // echoes, and the second is as legitimate as the first.
    this.entries.set(key, this.now() + this.ttlMs);
    if (this.entries.size > MAX_ENTRIES) {
      // Map iterates in insertion order, so this evicts the oldest.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }

  /**
   * One-shot: true when this incoming line is an echo that was registered, and
   * consumes the registration so a later repeat by a *player* is not mistaken
   * for the bot's own.
   */
  claim(line: string): boolean {
    const key = echoKey(line);
    const expiry = this.entries.get(key);
    if (expiry === undefined) return false;
    this.entries.delete(key);
    return expiry > this.now();
  }

  /** Registered-but-unclaimed count. Exposed for tests and health logging. */
  get size(): number {
    this.sweep();
    return this.entries.size;
  }

  private sweep(): void {
    const cutoff = this.now();
    for (const [key, expiry] of this.entries) {
      if (expiry <= cutoff) this.entries.delete(key);
    }
  }
}
