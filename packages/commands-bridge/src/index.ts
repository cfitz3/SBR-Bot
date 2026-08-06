/**
 * @sbr/commands-bridge — transport-agnostic member-bot command layer.
 */
export { CommandDispatcher, type CommandDispatcherDeps } from "./dispatcher.js";
export { buildBridgeRegistry } from "./handlers.js";
export { InMemoryCooldownGate } from "./cooldown.js";
export { formatCoins, renderNetworth, renderFailure, renderLinkError } from "./render.js";
export type {
  CommandContext,
  CommandReply,
  CommandSpec,
  CommandHandler,
  HandlerDeps,
  CooldownGate,
  CapabilityChecker,
  UsageSink,
} from "./types.js";
