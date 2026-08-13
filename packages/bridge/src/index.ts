/**
 * @sbr/bridge — transport-agnostic guild-chat relay pipeline.
 */
export { BridgeService, type BridgeServiceDeps } from "./service.js";
export { formatRelay, flattenForGame, stripMinecraftColors } from "./format.js";
export { EchoLedger, echoKey, type EchoLedgerOptions } from "./echo.js";
export type {
  RelayDirection,
  InboundMessage,
  RelayDecision,
  DropReason,
  BridgeGuard,
  WordlistFilter,
  FilterVerdict,
  FloodControl,
  AutomodGate,
  RelayMetrics,
} from "./types.js";
