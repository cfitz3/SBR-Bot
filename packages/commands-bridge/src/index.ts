/**
 * @sbr/commands-bridge — transport-agnostic member-bot command layer.
 */
export { CommandDispatcher, type CommandDispatcherDeps } from "./dispatcher.js";
export { buildBridgeRegistry, networthCategoryReply } from "./handlers.js";
export { InMemoryCooldownGate } from "./cooldown.js";
// The full renderer surface is exported, not just the handful the bots call
// directly, because `@sbr/embed-gallery` builds every card this platform can
// send by calling these — a gallery that reimplemented them would check itself
// rather than the product.
export {
  categoryLabel,
  networthComponents,
  renderNetworthCategoryEmbed,
  renderNetworthEmbed,
  NETWORTH_NAMESPACE,
} from "./networth.js";
export {
  formatCoins,
  renderAccessoriesEmbed,
  renderAchievementsEmbed,
  renderAdviceEmbed,
  renderAuctionsEmbed,
  renderDungeonsEmbed,
  renderFailure,
  renderGoalAchievedEmbed,
  renderGoalsEmbed,
  renderLeaderboardEmbed,
  renderLinkError,
  renderNetworth,
  renderProfileEmbed,
  renderProfileListEmbed,
  renderProgressEmbed,
  renderRosterEmbed,
  renderSkillsEmbed,
  renderSlayersEmbed,
  renderProfileCardEmbed,
  renderStatsEmbed,
} from "./render.js";
export { communityButtonReplies, parseRsvpPress, parseRsvpState, type RsvpPress } from "./handlers-community.js";
export { healthSpecs, renderHealthEmbed } from "./handlers-health.js";
export { infoSpecs, renderServerInfoEmbed, renderWhoisEmbed, type WhoisExtras } from "./handlers-info.js";
export {
  HELP_NAMESPACE,
  buildHelp,
  buildLinkHelp,
  groupCommands,
  helpButtonReplies,
  helpComponents,
  renderHelpEmbed,
  renderLinkHelpEmbed,
  type HelpInput,
} from "./help.js";
export {
  PROGRESSION_NAMESPACE,
  RANGES,
  buildProgression,
  parseTarget,
  progressionButtonReplies,
  progressionComponents,
  progressionSpecs,
  renderProgressionEmbed,
} from "./progression.js";
export { LEVEL_OPT_OUT_KEY, levelAlertSpecs, readLevelOptOuts } from "./handlers-levels.js";
export {
  MAX_PENDING_REMINDERS,
  MAX_REMINDER_MS,
  MAX_REMINDER_TEXT,
  MIN_REMINDER_MS,
  parseReminderDelay,
  reminderSpecs,
} from "./handlers-remind.js";
export { tagSpecs } from "./handlers-tags.js";
export { funSpecs, parseDice, readQuotes, rpsOutcome, vibeRank, QUOTES_SETTING_KEY } from "./fun.js";
export {
  lfgButtons,
  renderAttendanceEmbed,
  renderEventEmbed,
  BOARD_STANDINGS,
  formatDelta,
  formatMetricDelta,
  metricLabel,
  renderEventCard,
  rsvpButtons,
  type EventBoardStandingView,
  type EventCardView,
  renderEventReminderEmbed,
  type EventReminderView,
  renderEventsEmbed,
  renderLfgEmbed,
  renderLfgListEmbed,
  renderLevelUpEmbed,
  renderMilestoneEmbed,
  renderTicketEmbed,
  renderTicketListEmbed,
} from "./render-community.js";
export { renderPermCard, renderPermListPages } from "./render-perms.js";
export {
  activityRows,
  addRoleRows,
  permConsole,
  permConsoleCopy,
  permConsoleReplies,
  permView,
  PERM_IGN_MODAL,
  PERM_NAME_MODAL,
  PERM_NS,
} from "./perm-console.js";
export { permProblem } from "./perm-errors.js";
export {
  renderLfgRequestCard,
  type LfgPlays,
  type LfgRequestView,
} from "./render-lfg.js";
export {
  classRows,
  floorRows,
  lfgRequestCopy,
  lfgRequestReplies,
  typeRows,
  LFG_NS,
  LFG_PING_ROLE_SETTING_KEY,
} from "./lfg-request.js";
export {
  InGameDispatcher,
  INGAME_MAX_CHARS,
  INGAME_PREFIX,
  parseInGameCommand,
  positionalArgs,
  toGameLine,
  type InGameDispatcherDeps,
  type InGameIdentity,
  type ParsedInGameCommand,
} from "./ingame.js";
export type {
  AutocompleteHandler,
  Choice,
  CommandContext,
  CommandOptionSpec,
  CommandReply,
  CommandSpec,
  CommandHandler,
  HandlerDeps,
  LfgAnnouncer,
  LfgBoard,
  CooldownGate,
  CooldownPolicySource,
  CapabilityChecker,
  UsageSink,
} from "./types.js";
export {
  DEFAULT_RANGE,
  MARKET_NAMESPACE,
  MARKET_RANGES,
  itemName,
  marketButtonReplies,
  marketComponents,
  marketReply,
  marketText,
  parseRange,
  readMarket,
  renderListingsEmbed,
  renderMarketEmbed,
  trendAgainst,
  type MarketSnapshot,
} from "./market.js";
