/**
 * @sbr/redis — shared Redis client, keyspace builders, and cache helpers.
 */
export {
  getRedis,
  closeRedis,
  setJson,
  getJson,
  setCached,
  getCached,
  type RedisContext,
  type RedisOptions,
} from "./client.js";
export { createKeyFactory, type KeyFactory } from "./keys.js";
export { pingRedis, type RedisPingResult } from "./health.js";
export {
  createRedisAdapters,
  RedisLock,
  RedisCooldownGate,
  RedisHypixelCache,
  RedisPriceSource,
  RedisBinSource,
  type CachedBinEntry,
  RedisRateGate,
  RedisAnalyticsBuffer,
  RedisAnalyticsDrain,
  type BufferedAnalyticsEvent,
  RedisAutomodCounters,
  type AutomodCounterRequest,
  RedisEnforcementMirror,
  RedisConfigBus,
  RedisModBus,
  parseModBusMessage,
  type ModBusMessage,
  RedisJobTriggerBus,
  parseJobTriggerMessage,
  isRunnableJob,
  RUNNABLE_JOBS,
  type JobTriggerMessage,
  RedisHeartbeat,
  startHeartbeat,
  type HeartbeatRecord,
} from "./adapters.js";
