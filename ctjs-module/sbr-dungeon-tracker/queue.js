/**
 * A bounded outbound queue that drops the oldest record on overflow.
 *
 * The whole reason this exists is the rule that gameplay comes first: a
 * backend that is down, slow, or mid-restart must cost the player nothing —
 * not a frame, not a stutter, and above all not an unbounded array that grows
 * for the rest of the session and takes the client down with it.
 *
 * Dropping the oldest rather than refusing the newest is deliberate. During a
 * disconnect the interesting records are the ones happening now; a queue that
 * filled up with the first 500 events of a run and then rejected the boss
 * fight would preserve exactly the wrong half.
 */

/** Bounded by count rather than bytes: records are small and uniform. */
const DEFAULT_LIMIT = 500;

function createQueue(limit) {
  const max = typeof limit === "number" && limit > 0 ? limit : DEFAULT_LIMIT;
  let items = [];
  let dropped = 0;

  return {
    push(item) {
      items.push(item);
      while (items.length > max) {
        items.shift();
        dropped += 1;
      }
    },

    /** Remove and return up to `n` items, oldest first. */
    take(n) {
      const count = Math.min(n, items.length);
      if (count === 0) return [];
      const out = items.slice(0, count);
      items = items.slice(count);
      return out;
    },

    /** Put items back at the front, e.g. when a send failed mid-flight. */
    unshiftAll(returned) {
      items = returned.concat(items);
      while (items.length > max) {
        items.shift();
        dropped += 1;
      }
    },

    clear() {
      items = [];
    },

    size() {
      return items.length;
    },

    droppedCount() {
      return dropped;
    },

    limit() {
      return max;
    },
  };
}

export default { createQueue, DEFAULT_LIMIT };
