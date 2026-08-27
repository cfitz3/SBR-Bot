/**
 * How long somebody has been playing, in the shortest form that is still true.
 *
 * Not a Discord relative timestamp. `<t:…:R>` renders as "42 minutes ago",
 * which reads as when they arrived; the question `/online` is answering is how
 * long they have been there. The two are the same number and opposite
 * sentences, and the wrong one makes a busy roster unreadable.
 *
 * Rounded down throughout: claiming an hour at 59 minutes is the one direction
 * that can be caught out.
 */
export function describePlaytime(startedAt: string, now: Date, estimated = false): string {
  const ms = now.getTime() - new Date(startedAt).getTime();
  const minutes = Math.floor(ms / 60_000);
  // A session younger than a minute is "just now" rather than "0m", which reads
  // as a bug and is the state every session passes through.
  const text = minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m` : hours(minutes);
  return estimated && minutes >= 1 ? `${text}+` : text;
}

function hours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
