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

  const make = (level: LogLevel) => (msg: string, fields?: LogFields) => {
    if (LEVEL_WEIGHT[level] >= threshold) write(level, name, base, msg, fields);
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
        base: { ...base, ...bindings },
      });
    },
  };
}
