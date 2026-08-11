/**
 * @sbr/xp — guild XP and standing: what an action is worth, what stops it being
 * farmed, and how a total becomes a level.
 */
export { XpService, type XpServiceDeps, type XpCooldownGate, type AggregateSummary } from "./service.js";
export { awardsFor, countsAsMessage, dedupeKey, totalsBySource, weighted, type DayInput } from "./policy.js";
export { LEVEL_STEP, levelForXp, levelProgress, progressBar, xpForLevel, type LevelProgress } from "./levels.js";
export {
  toPolicyMap,
  type ActivityRow,
  type ActivitySink,
  type BalanceRow,
  type LedgerRow,
  type XpRepository,
} from "./ports.js";
export {
  NO_ACTIVITY,
  SUGGESTED_POLICY,
  XP_SOURCES,
  disabledPolicy,
  policyFor,
  type ActivityCounters,
  type Standing,
  type XpAward,
  type XpPolicy,
  type XpSource,
  type XpSourcePolicy,
} from "./types.js";
