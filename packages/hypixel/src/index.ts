/**
 * @sbr/hypixel — centralized Hypixel/Mojang client with caching, rate-limit
 * awareness, retries, typed fallback states, and the HypixelSocialLookup port.
 */
export { HypixelClient, HypixelUnavailableError, type HypixelClientOptions } from "./client.js";
export { InMemoryHypixelCache, InMemoryRateGate } from "./memory.js";
export { fetchHttp } from "./http.js";
export {
  realSleep,
  type HttpFetcher,
  type HttpResponse,
  type HypixelCache,
  type CacheEntry,
  type RateGate,
  type RateAcquire,
  type Sleeper,
} from "./ports.js";
export type { HypixelPlayerDTO, SkyblockProfileDTO } from "./types.js";
