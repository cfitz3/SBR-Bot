/**
 * @sbr/hypixel — centralized Hypixel/Mojang client with caching, rate-limit
 * awareness, retries, typed fallback states, and the HypixelSocialLookup port.
 */
export {
  HypixelClient,
  HypixelUnavailableError,
  type HypixelClientOptions,
  type HypixelObservation,
  type PlayerReadOptions,
} from "./client.js";
export { hypixelCheck, OBSERVATION_TTL_MS } from "./health.js";
export { InMemoryHypixelCache, InMemoryRateGate } from "./memory.js";
export { fetchHttp } from "./http.js";
export { decodeItemBytes, type DecodedItem } from "./nbt.js";
export {
  realSleep,
  unlimitedPlayers,
  type PlayerRateLimiter,
  type HttpFetcher,
  type HttpResponse,
  type HypixelCache,
  type CacheEntry,
  type RateGate,
  type RateAcquire,
  type Sleeper,
} from "./ports.js";
export type {
  AuctionDTO,
  AuctionPageDTO,
  BazaarDTO,
  BazaarProductDTO,
  BingoDTO,
  BingoGoalDTO,
  ElectionCandidateDTO,
  ElectionDTO,
  EndedAuctionDTO,
  EndedAuctionsDTO,
  FiresaleDTO,
  FiresalesDTO,
  GuildDTO,
  GuildMemberDTO,
  HypixelPlayerDTO,
  MayorDTO,
  MuseumDTO,
  ResourceDTO,
  SkyblockProfileDTO,
} from "./types.js";
