/**
 * The ports this package needs from the outside world.
 *
 * Declared here rather than imported from `@sbr/identity` or `@sbr/db`, which
 * is the convention the other domain packages follow: a package states the
 * narrow thing it requires, and the app root composes something that satisfies
 * it. The practical payoff is that every test below runs against an object
 * literal — no Prisma, no Redis, no network.
 */

/** A guild member, as far as this package is concerned. */
export interface IngestMember {
  /** Discord id. The identity the ring buffer and the debug route key on. */
  readonly memberId: string;
  /** The in-game name that resolved to them, as it was matched. */
  readonly ign: string;
}

export interface MemberResolver {
  /**
   * Resolve a Minecraft username to a linked guild member.
   *
   * Returns `null` for an unknown or unlinked account — which is a refusal, not
   * an error. An unlinked client is exactly the case the handshake exists to
   * turn away, so it must be an ordinary answer rather than a thrown exception.
   */
  resolveByIgn(ign: string): Promise<IngestMember | null>;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
