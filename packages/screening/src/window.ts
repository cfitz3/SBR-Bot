/**
 * The join window.
 *
 * A Hypixel join request is not an application. The applicant types
 * `/g join <guild>`, and from that moment there are five minutes in which
 * `/g accept <ign>` will work; after that Hypixel has forgotten the request and
 * the only way in is an invite the applicant must then accept themselves.
 *
 * That single fact is why screening cannot be shaped like a review queue. A
 * queue is allowed to take an hour; this has a deadline measured against a
 * clock nobody on the platform controls, and every surface that shows a pending
 * request has to show how much of it is left — otherwise staff act on rows that
 * cannot be acted on, and the platform reports success for a command Hypixel
 * discarded.
 *
 * The window is a constant here rather than a setting because it is not ours to
 * choose. A guild cannot configure Hypixel's timeout, and exposing it as though
 * they could would invite somebody to set it to an hour and quietly break every
 * deadline in the system.
 */

/** How long Hypixel honours `/g accept` after a request. */
export const JOIN_WINDOW_MS = 5 * 60_000;

/**
 * How long is left to accept, floored at zero.
 *
 * Clocks are the awkward part: `requestedAt` is stamped when *we* saw the chat
 * line, which is at best a few hundred milliseconds after Hypixel started
 * counting. So this is an over-estimate of the time available, never an under-
 * estimate — which is the wrong direction to be wrong in. Callers deciding
 * whether to bother sending should use `windowClosed`, which is the same
 * reading, and treat a near-zero remainder as already gone.
 */
export function remainingWindowMs(requestedAt: Date, now: Date = new Date(), windowMs: number = JOIN_WINDOW_MS): number {
  const left = requestedAt.getTime() + windowMs - now.getTime();
  return left > 0 ? left : 0;
}

/** Has the request timed out upstream? */
export function windowClosed(requestedAt: Date, now: Date = new Date(), windowMs: number = JOIN_WINDOW_MS): boolean {
  return remainingWindowMs(requestedAt, now, windowMs) === 0;
}

/**
 * The remainder, for a human reading a staff channel.
 *
 * Deliberately coarse. Seconds-level precision on a number that is stale by the
 * time it renders would imply an accuracy the clock skew above does not support.
 */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "window closed";
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m left` : `${minutes}m ${rest}s left`;
}
