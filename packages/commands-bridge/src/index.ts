/**
 * @sbr/commands-bridge — transport-agnostic member-bot command layer.
 */
export { CommandDispatcher, type CommandDispatcherDeps } from "./dispatcher.js";
export { buildBridgeRegistry } from "./handlers.js";
export { InMemoryCooldownGate } from "./cooldown.js";
export { formatCoins, renderNetworth, renderFailure, renderLinkError, renderRosterEmbed } from "./render.js";
export { communityButtonReplies, parseRsvpState } from "./handlers-community.js";
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
  CooldownGate,
  CapabilityChecker,
  UsageSink,
} from "./types.js";
