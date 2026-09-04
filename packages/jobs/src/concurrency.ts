/**
 * Do several of these at once, but not all of them.
 *
 * Every bulk pass in this package was written as a `for … await` loop, which is
 * the right first draft: it is obviously correct, it never overruns an upstream,
 * and it makes the ordering rules ("oldest first") mean something. It is also
 * why a 125-member profile refresh takes 125 round trips end to end — about four
 * minutes of mostly waiting, against an upstream that would have answered eight
 * of them at once without complaint.
 *
 * So: a fixed number in flight, refilled as each finishes. Not `Promise.all`,
 * which is the failure this replaces from the other direction — a hundred
 * simultaneous requests earn a 429 for the whole fleet, and the retry that
 * follows costs more than the serialism did.
 *
 * Three properties the callers depend on:
 *
 * - **Results keep input order**, regardless of which finished first. Callers
 *   pair them back up with their inputs by index.
 * - **One failure does not cancel the rest.** A rejection is handed back in
 *   place, so the caller decides — every existing loop here already skips the
 *   member it could not read rather than failing the batch, and that behaviour
 *   has to survive the change.
 * - **`limit` of 1 is exactly the old loop**, in the same order, which is what
 *   makes it safe to leave as the default anywhere the pacing was the point.
 */

/** What one item did: its value, or the error it threw. */
export type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/**
 * Run `fn` over `items` with at most `limit` in flight, in input order.
 *
 * `limit` is clamped to at least one and to the number of items, so a
 * misconfigured environment variable slows the pass down rather than breaking
 * it — the failure mode of a throughput knob should never be an exception.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Settled<R>[]> {
  const out: Settled<R>[] = new Array<Settled<R>>(items.length);
  if (items.length === 0) return out;

  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;

  // Each worker pulls the next index rather than taking a fixed slice: a slice
  // is only fair when every item costs the same, and one member with eight
  // profiles costs eight times what their guildmate does.
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      try {
        out[index] = { ok: true, value: await fn(item, index) };
      } catch (error) {
        out[index] = { ok: false, error };
      }
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

/**
 * The same, for work whose results nobody wants — only whether it threw.
 *
 * Returns the errors, in input order, so a caller can report "three of these
 * failed" without holding on to 125 `{ ok: true }` wrappers it will not read.
 */
export async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<unknown[]> {
  const settled = await mapLimit(items, limit, fn);
  return settled.flatMap((r) => (r.ok ? [] : [r.error]));
}
