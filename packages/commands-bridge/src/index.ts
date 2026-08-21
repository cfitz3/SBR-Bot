/**
 * @sbr/commands-bridge — transport-agnostic member-bot command layer.
 */
export { CommandDispatcher, type CommandDispatcherDeps } from "./dispatcher.js";
export { buildBridgeRegistry } from "./handlers.js";
export { InMemoryCooldownGate } from "./cooldown.js";
// The full renderer surface is exported, not just the handful the bots call
// directly, because `@sbr/embed-gallery` builds every card this platform can
// send by calling these — a gallery that reimplemented them would check itself
// rather than the product.
export {
  formatCoins,
  renderAccessoriesEmbed,
  renderAchievementsEmbed,
  renderAdviceEmbed,
  renderAuctionsEmbed,
  renderBazaarEmbed,
  renderDungeonsEmbed,
  renderFailure,
  renderGoalAchievedEmbed,
  renderGoalsEmbed,
  renderLeaderboardEmbed,
  renderLinkError,
  renderLowestBinEmbed,
  renderNetworth,
  renderNetworthEmbed,
  renderPriceEmbed,
  renderProfileEmbed,
  renderProfileListEmbed,
  renderProgressEmbed,
  renderRosterEmbed,
  renderSkillsEmbed,
  renderSlayersEmbed,
  renderStandingEmbed,
  renderProfileCardEmbed,
  renderStatsEmbed,
} from "./render.js";
export { communityButtonReplies, parseRsvpState } from "./handlers-community.js";
export { infoSpecs, renderServerInfoEmbed, renderUserInfoEmbed } from "./handlers-info.js";
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
  metricLabel,
  renderEventBoardEmbed,
  type EventBoardStandingView,
  type EventBoardView,
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
export { renderPermEmbed, renderPermListEmbed } from "./render-perms.js";
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
  LfgBoard,
  CooldownGate,
  CooldownPolicySource,
  CapabilityChecker,
  UsageSink,
} from "./types.js";
