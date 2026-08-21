/**
 * Minimal structured logger. Emits one JSON object per line to stdout/stderr,
 * level-filtered, with support for bound child fields (e.g. correlationId, guildId).
 *
 * Dependency-free for the scaffold. Swap for pino later without changing call
 * sites: the (message, fields) signature mirrors pino's ergonomics.
 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export type LogFields = Record<string, unknown>;

/** One emitted record, as a sink sees it. The same object that is serialised. */
export interface LogRecord {
  readonly level: LogLevel;
  readonly time: string;
  readonly name: string | undefined;
  readonly msg: string;
  readonly fields: LogFields;
}

/**
 * A second destination for records at or above `sinkLevel`.
 *
 * Deliberately synchronous and return-less: a sink that could fail or block
 * would make logging a source of the failures it exists to report, so the
 * contract is "take this and deal with it elsewhere". The Discord shipper
 * buffers and posts on its own timer for exactly that reason.
 */
export type LogSink = (record: LogRecord) => void;

export interface Logger {
  trace(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly name?: string;
  readonly base?: LogFields;
  /** Where records also go. Inherited by every child of this logger. */
  readonly sink?: LogSink;
  /** The floor for the sink, independent of the console level. Defaults to `error`. */
  readonly sinkLevel?: LogLevel;
}

function write(level: LogLevel, name: string | undefined, base: LogFields, msg: string, fields?: LogFields): void {
  const record = {
    level,
    time: new Date().toISOString(),
    ...(name ? { name } : {}),
    ...base,
    ...(fields ?? {}),
    msg,
  };
  const line = JSON.stringify(record);
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LEVEL_WEIGHT[options.level ?? "info"];
  const base = options.base ?? {};
  const name = options.name;
  const sink = options.sink;
  const sinkThreshold = LEVEL_WEIGHT[options.sinkLevel ?? "error"];

  const make = (level: LogLevel) => (msg: string, fields?: LogFields) => {
    if (LEVEL_WEIGHT[level] >= threshold) write(level, name, base, msg, fields);
    // Independent of the console threshold: a process running at `warn` must
    // still ship its errors, and one running at `trace` must not ship its noise.
    if (sink && LEVEL_WEIGHT[level] >= sinkThreshold) {
      try {
        sink({ level, time: new Date().toISOString(), name, msg, fields: { ...base, ...(fields ?? {}) } });
      } catch {
        // A sink that throws must not take the call site down with it.
      }
    }
  };

  return {
    trace: make("trace"),
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    child(bindings: LogFields): Logger {
      return createLogger({
        ...(options.level ? { level: options.level } : {}),
        ...(name ? { name } : {}),
        ...(sink ? { sink } : {}),
        ...(options.sinkLevel ? { sinkLevel: options.sinkLevel } : {}),
        base: { ...base, ...bindings },
      });
    },
  };
}
