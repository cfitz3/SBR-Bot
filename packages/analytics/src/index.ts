/**
 * @sbr/analytics — event capture + pure daily rollup.
 */
export { AnalyticsServiceImpl, type AnalyticsServiceDeps } from "./service.js";
export { rollupDaily, type MetricRow } from "./rollup.js";
export type { AnalyticsBuffer } from "./ports.js";
