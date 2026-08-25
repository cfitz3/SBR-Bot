/**
 * @sbr/client-ingest — the server side of the ctjs client telemetry module.
 *
 * Phase 1 scope: accept a WebSocket from a guild member's Minecraft client,
 * prove whose client it is, and log what arrives. Nothing here writes to
 * Postgres or Redis; the only retention is a bounded in-memory ring for the
 * debug route, and it is lost on restart by design.
 *
 * Everything is injected — the identity lookup is a port, the logger is the
 * observability logger, and the transport is two functions — so the whole
 * package is testable offline with fakes.
 */
export {
  createClientIngestService,
  type ClientIngestOptions,
  type ClientIngestService,
  type UpgradeRequest,
  type UpgradeSocket,
} from "./service.js";
export { createIngestSession, type IngestSession, type SessionDeps, type SessionLimits, type SessionTransport } from "./session.js";
export { createEventRing, type BufferedEvent, type EventRing, type EventRingOptions, type MemberEvents } from "./ring.js";
export { systemClock, type Clock, type IngestMember, type MemberResolver } from "./ports.js";
export { LIMITS, parseMessage, type ClientMessage, type HelloMessage, type ParseResult, type RawEvent } from "./protocol.js";
export { CLOSE, OPCODE, createFrameDecoder, encodeClose, encodeFrame, encodePong, encodeText, type Frame, type FrameDecoder } from "./frames.js";
export { acceptResponse, checkUpgrade, computeAccept, rejectResponse, type UpgradeCheck } from "./handshake.js";
