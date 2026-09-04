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
export { curateStatus, MEMBER_STATUS_ROWS } from "./status.js";
export {
  installLifecycle,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  type LifecycleHandle,
  type LifecycleOptions,
} from "./lifecycle.js";
