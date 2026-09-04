/**
 * The vendored Hypixel client, and every endpoint this bot is able to call.
 *
 * The list is short on purpose and is the shortest it can be while still
 * answering "what should I do next?": one profile read per advice request, the
 * public market and world-state reads a worker performs once for everybody, and
 * Mojang for name resolution. There is no guild endpoint, no museum read, no
 * per-player auction listing and no ended-auction history — dropping those was
 * a deliberate reduction of the upstream client, not an omission
 * (COMPLIANCE.md §2, §3).
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
  FiresaleDTO,
  FiresalesDTO,
  HypixelPlayerDTO,
  MayorDTO,
  ResourceDTO,
  SkyblockProfileDTO,
} from "./types.js";
