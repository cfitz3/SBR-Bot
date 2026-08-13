/**
 * @sbr/commands-bridge — transport-agnostic member-bot command layer.
 */
export { CommandDispatcher, type CommandDispatcherDeps } from "./dispatcher.js";
export { buildBridgeRegistry } from "./handlers.js";
export { InMemoryCooldownGate } from "./cooldown.js";
export { formatCoins, renderNetworth, renderFailure, renderLinkError, renderRosterEmbed } from "./render.js";
export { communityButtonReplies, parseRsvpState } from "./handlers-community.js";
export { funSpecs, parseDice, readQuotes, rpsOutcome, vibeRank, QUOTES_SETTING_KEY } from "./fun.js";
export { lfgButtons, renderLfgEmbed, renderMilestoneEmbed } from "./render-community.js";
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
