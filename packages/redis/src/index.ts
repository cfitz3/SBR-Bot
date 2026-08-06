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
  RedisRateGate,
  RedisAnalyticsBuffer,
  RedisEnforcementMirror,
} from "./adapters.js";
