/**
 * How much we are asking of somebody else, and how often they say no.
 *
 * Both upstreams this platform depends on — Discord's REST API and Hypixel's —
 * answer "you are going too fast" with a 429 rather than with a number we can
 * read ahead of time. So the only way to know whether a concurrency setting is
 * right is to raise it and watch: how many calls went out, how long they took,
 * and how many came back rate-limited. Without that, every limit in this repo is
 * a guess defended by a comment.
 *
 * Deliberately tiny. It is counters and a running total, not a histogram: the
 * question an operator asks of this is "are we near the ceiling", and a mean
 * with a max answers it. A real percentile would need a reservoir per surface
 * and a page to read it on, neither of which exists yet.
 *
 * Every method is synchronous, allocation-free in the common case, and never
 * throws — it is called on the hot path of every upstream request, and a metric
 * that can break the thing it measures is worse than no metric.
 */

/** One upstream, as an operator names it: `discord`, `hypixel`. */
export type CallSurface = string;

export interface CallStats {
  readonly surface: CallSurface;
  /** Calls that finished, successfully or not. */
  readonly calls: number;
  /** Of those, the ones that reported failure. */
  readonly failures: number;
  /**
   * Times the upstream told us to slow down.
   *
   * Counted separately from failures because a 429 that was retried and then
   * succeeded is not a failure — it is the signal that the limit is real, and
   * it is the number that should move when a concurrency knob is turned.
   */
  readonly rateLimited: number;
  readonly totalMs: number;
  readonly maxMs: number;
  /** Rounded; a fractional millisecond mean is false precision. */
  readonly meanMs: number;
}

export interface CallMeter {
  /** Record one finished call. `ms` is wall time including any internal retry. */
  record(surface: CallSurface, ms: number, opts?: { failed?: boolean; rateLimited?: boolean }): void;
  /**
   * Record a rate-limit event that was not a call of ours — discord.js reports
   * these from inside its own queue, where the request has not gone out yet.
   */
  rateLimited(surface: CallSurface): void;
  /** Everything counted so far, busiest surface first. */
  snapshot(): readonly CallStats[];
  /** The same, and resets the counters. For a periodic "since last time" log. */
  drain(): readonly CallStats[];
}

interface Bucket {
  calls: number;
  failures: number;
  rateLimited: number;
  totalMs: number;
  maxMs: number;
}

const empty = (): Bucket => ({ calls: 0, failures: 0, rateLimited: 0, totalMs: 0, maxMs: 0 });

export function createCallMeter(): CallMeter {
  const buckets = new Map<CallSurface, Bucket>();

  const bucket = (surface: CallSurface): Bucket => {
    const existing = buckets.get(surface);
    if (existing !== undefined) return existing;
    const fresh = empty();
    buckets.set(surface, fresh);
    return fresh;
  };

  const read = (reset: boolean): readonly CallStats[] => {
    const out: CallStats[] = [];
    for (const [surface, b] of buckets) {
      if (b.calls === 0 && b.rateLimited === 0) continue;
      out.push({
        surface,
        calls: b.calls,
        failures: b.failures,
        rateLimited: b.rateLimited,
        totalMs: Math.round(b.totalMs),
        maxMs: Math.round(b.maxMs),
        meanMs: b.calls === 0 ? 0 : Math.round(b.totalMs / b.calls),
      });
    }
    if (reset) buckets.clear();
    return out.sort((a, b) => b.calls - a.calls);
  };

  return {
    record(surface, ms, opts) {
      const b = bucket(surface);
      // A negative or non-finite duration is a clock going backwards or a
      // caller passing something odd; counting the call still tells the truth.
      const took = Number.isFinite(ms) && ms > 0 ? ms : 0;
      b.calls += 1;
      b.totalMs += took;
      if (took > b.maxMs) b.maxMs = took;
      if (opts?.failed === true) b.failures += 1;
      if (opts?.rateLimited === true) b.rateLimited += 1;
    },
    rateLimited(surface) {
      bucket(surface).rateLimited += 1;
    },
    snapshot() {
      return read(false);
    },
    drain() {
      return read(true);
    },
  };
}

/** How often the summary line is written. Long enough to be a trend. */
export const METER_LOG_INTERVAL_MS = 60_000;

export interface MeterLogOptions {
  readonly intervalMs?: number;
  /** Injected in tests; production uses the global timer. */
  readonly setInterval?: typeof setInterval;
}

/**
 * Write one line per surface per minute, and only when something happened.
 *
 * A quiet process logs nothing at all, which is the point: the line's presence
 * is already information, and a per-minute "calls: 0" from four processes is how
 * a log stops being read.
 */
export function installMeterLog(
  meter: CallMeter,
  log: { info(msg: string, fields?: Record<string, unknown>): void },
  opts: MeterLogOptions = {},
): () => void {
  const every = opts.intervalMs ?? METER_LOG_INTERVAL_MS;
  const schedule = opts.setInterval ?? setInterval;
  const timer = schedule(() => {
    for (const stats of meter.drain()) {
      log.info("upstream throughput", {
        surface: stats.surface,
        calls: stats.calls,
        failures: stats.failures,
        rateLimited: stats.rateLimited,
        meanMs: stats.meanMs,
        maxMs: stats.maxMs,
        windowMs: every,
      });
    }
  }, every);
  // Never the reason a process stays alive: this is a reporter, not work.
  timer.unref?.();
  return () => {
    clearInterval(timer);
  };
}
