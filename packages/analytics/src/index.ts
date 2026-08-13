/**
 * @sbr/analytics — event capture + pure daily rollup.
 */
export { AnalyticsServiceImpl, type AnalyticsServiceDeps } from "./service.js";
export {
  bucketStart,
  rollupDaily,
  rollupEvents,
  type MetricPeriod,
  type MetricRow,
  type PeriodMetricRow,
} from "./rollup.js";
export type { AnalyticsBuffer } from "./ports.js";
export { createDomainMetrics, type DomainMetrics, type DomainMetricsOptions } from "./metrics.js";
