/**
 * Structured logging, upstream call metering, health aggregation and a bounded
 * shutdown — the four things any long-running process needs and none of which
 * say anything about the game.
 *
 * The modules beside this one are copied unchanged from the platform this bot
 * was extracted from. This file is the reduction: the upstream package also
 * ships a log shipper that posts records into a Discord channel and a curated
 * member-facing status card, neither of which this process has any use for, so
 * neither is carried across. A surface that names only what is used is the same
 * argument the vendored Hypixel client makes (COMPLIANCE.md §2).
 */
export {
  createLogger,
  type Logger,
  type LogLevel,
  type LogFields,
  type LoggerOptions,
  type LogRecord,
  type LogSink,
} from "./logger.js";
export {
  createCallMeter,
  installMeterLog,
  METER_LOG_INTERVAL_MS,
  type CallMeter,
  type CallStats,
  type CallSurface,
  type MeterLogOptions,
} from "./meter.js";
export { HealthRegistry, pingCheck } from "./health.js";
export {
  installLifecycle,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  type LifecycleHandle,
  type LifecycleOptions,
} from "./lifecycle.js";
