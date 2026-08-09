/**
 * @sbr/skykings — client for the SkyKings API (scammer list, links, tracked
 * player and guild snapshots).
 */
export {
  SkykingsClient,
  normalizeUuid,
  SKYKINGS_BASE_URL,
  CLEAR_TTL_MS,
  FLAGGED_TTL_MS,
  PLAYER_TTL_MS,
  type SkykingsClientOptions,
} from "./client.js";
export { InMemorySkykingsCache, type HttpFetcher, type HttpResponse, type SkykingsCache } from "./ports.js";
export type {
  ScammerCheck,
  SkykingsGuildDTO,
  SkykingsLinkDTO,
  SkykingsPlayerDTO,
  SkykingsProfileDTO,
  SkykingsResult,
  SkykingsUnknownCause,
} from "./types.js";
