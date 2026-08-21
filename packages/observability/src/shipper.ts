/**
 * The log shipper: turns a stream of error records into a small number of
 * readable messages somewhere a human is already looking.
 *
 * Three things make a naive "post every error to Discord" a bad idea, and this
 * exists to answer all three:
 *
 *  - **Volume.** One broken dependency emits the same line hundreds of times a
 *    minute. Identical messages inside a window are collapsed into one entry
 *    with a count, so a storm reads as `× 412` rather than as 412 messages.
 *  - **Rate limits.** Discord's are per-channel, and a logger that trips them
 *    makes every *other* thing the bot wants to say late. The shipper posts at
 *    most once per window, on its own timer, never on the logging call.
 *  - **Recursion.** A failed post must not log an error that queues another
 *    post. `flush` swallows its own failures and never touches the logger.
 *
 * It is deliberately transport-free: `post` is a callback, so this is unit
 * testable without a gateway and reusable for anything that takes a string.
 */
import type { LogRecord, LogSink } from "./logger.js";

/** How long records are gathered before one message goes out. */
export const SHIP_WINDOW_MS = 30_000;
/** Distinct messages carried per post. Beyond this, the rest are counted only. */
export const SHIP_MAX_ENTRIES = 8;
/** Hard cap on the buffer, so an unbounded storm cannot grow unbounded memory. */
export const SHIP_MAX_DISTINCT = 100;

export interface LogShipperOptions {
  /** Deliver one composed message. Failures are swallowed by the caller. */
  post(text: string): Promise<unknown>;
  readonly windowMs?: number;
  readonly maxEntries?: number;
  /** Prefix identifying the process, e.g. `bridge-bot`. */
  readonly service?: string;
}

export interface LogShipper {
  /** Hand to `createLogger({ sink })`. */
  readonly sink: LogSink;
  /** Post whatever is buffered now. Returns false when there was nothing. */
  flush(): Promise<boolean>;
  stop(): void;
}

interface Entry {
  count: number;
  readonly level: string;
  readonly msg: string;
  readonly detail: string | null;
  readonly firstAt: string;
}

export function createLogShipper(options: LogShipperOptions): LogShipper {
  const windowMs = options.windowMs ?? SHIP_WINDOW_MS;
  const maxEntries = options.maxEntries ?? SHIP_MAX_ENTRIES;
  const buffer = new Map<string, Entry>();
  let dropped = 0;

  const sink: LogSink = (record: LogRecord) => {
    const key = `${record.level}:${record.name ?? ""}:${record.msg}`;
    const existing = buffer.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    // Past the cap the storm is already described by what is buffered; the
    // count of what else happened is more useful than the lines themselves.
    if (buffer.size >= SHIP_MAX_DISTINCT) {
      dropped += 1;
      return;
    }
    buffer.set(key, {
      count: 1,
      level: record.level,
      msg: record.msg,
      detail: describe(record.fields),
      firstAt: record.time,
    });
  };

  async function flush(): Promise<boolean> {
    if (buffer.size === 0 && dropped === 0) return false;
    const entries = [...buffer.values()].sort((a, b) => b.count - a.count);
    const missed = dropped;
    buffer.clear();
    dropped = 0;

    try {
      await options.post(compose(entries, missed, maxEntries, options.service));
    } catch {
      // A shipper that reported its own failures would report them through
      // itself. The console line for this error was already written.
    }
    return true;
  }

  const timer = setInterval(() => {
    void flush();
  }, windowMs);
  timer.unref?.();

  return {
    sink,
    flush,
    stop() {
      clearInterval(timer);
    },
  };
}

/**
 * The message body. Plain text in a code fence rather than an embed: these are
 * log lines, they are read by eye in a monospace block, and an embed per error
 * would be a wall of coloured bars.
 */
function compose(
  entries: readonly Entry[],
  dropped: number,
  maxEntries: number,
  service: string | undefined,
): string {
  const shown = entries.slice(0, maxEntries);
  const hidden = entries.length - shown.length;
  const head = `**${service ?? "service"}** — ${total(entries)} log ${total(entries) === 1 ? "record" : "records"}`;

  const lines = shown.map((e) => {
    const times = e.count > 1 ? ` ×${e.count}` : "";
    const detail = e.detail === null ? "" : ` — ${e.detail}`;
    return `[${e.level}] ${e.msg}${times}${detail}`;
  });

  const tail: string[] = [];
  if (hidden > 0) tail.push(`… and ${hidden} other distinct ${hidden === 1 ? "message" : "messages"}`);
  if (dropped > 0) tail.push(`… ${dropped} more dropped past the buffer cap`);

  // Truncated to well inside Discord's 2000, with the fence accounted for.
  const body = [...lines, ...tail].join("\n").slice(0, 1800);
  return `${head}\n\`\`\`\n${body}\n\`\`\``;
}

function total(entries: readonly Entry[]): number {
  return entries.reduce((sum, e) => sum + e.count, 0);
}

/**
 * The one field worth putting on the line. `error` if there is one, otherwise
 * nothing: a whole serialised field bag per line would bury the message it is
 * supposed to explain, and the full record is in the process log either way.
 */
function describe(fields: Readonly<Record<string, unknown>>): string | null {
  const error = fields["error"];
  if (typeof error === "string") return error.slice(0, 200);
  if (error instanceof Error) return error.message.slice(0, 200);
  return null;
}
