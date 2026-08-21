/**
 * @sbr/observability — structured logging and health-check aggregation.
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
  createLogShipper,
  SHIP_WINDOW_MS,
  SHIP_MAX_ENTRIES,
  SHIP_MAX_DISTINCT,
  type LogShipper,
  type LogShipperOptions,
} from "./shipper.js";
export { HealthRegistry, pingCheck } from "./health.js";
export {
  installLifecycle,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  type LifecycleHandle,
  type LifecycleOptions,
} from "./lifecycle.js";
