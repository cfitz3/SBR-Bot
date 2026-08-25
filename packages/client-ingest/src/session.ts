/**
 * One connected client, as a state machine over bytes.
 *
 * The transport is injected as two functions — `send` and `close` — so nothing
 * in this file knows what a socket is. That is what makes the interesting
 * behaviour testable: a rejected handshake, a client that talks before saying
 * hello, a flood, a half-delivered frame are all reachable by pushing Buffers
 * at it and reading what came back out of a fake transport.
 *
 * The connection has exactly two states. Until a valid `hello` resolves to a
 * linked guild member, nothing is recorded and nothing is logged beyond the
 * refusal. After that, every event carries that resolved identity. There is no
 * path that records an event without knowing whose it is.
 */
import type { Logger } from "@sbr/observability";
import { CLOSE, OPCODE, createFrameDecoder, encodeClose, encodePong, encodeText } from "./frames.js";
import { type RawEvent, parseMessage } from "./protocol.js";
import type { Clock, IngestMember, MemberResolver } from "./ports.js";
import { systemClock } from "./ports.js";
import type { BufferedEvent, EventRing } from "./ring.js";

export interface SessionTransport {
  send(data: Buffer): void;
  close(): void;
}

export interface SessionLimits {
  /** Messages allowed inside `windowMs` before the connection is closed. */
  readonly maxMessagesPerWindow?: number;
  readonly windowMs?: number;
  /** How long a client may stay silent after connecting before it must say hello. */
  readonly helloTimeoutMs?: number;
  readonly maxFrameBytes?: number;
}

export interface SessionDeps {
  readonly transport: SessionTransport;
  readonly resolver: MemberResolver;
  readonly ring: EventRing;
  readonly log: Logger;
  readonly clock?: Clock;
  readonly limits?: SessionLimits;
  /** Identifies the peer in logs. Never used for authorisation. */
  readonly remote?: string | undefined;
}

export interface IngestSession {
  /** Feed bytes from the socket. Never throws. */
  push(chunk: Buffer): void;
  /** The peer went away. */
  end(): void;
  /** Close from our side, e.g. on server shutdown. */
  shutdown(code?: number, reason?: string): void;
  /** True once a hello has resolved to a linked member. */
  isAuthenticated(): boolean;
  member(): IngestMember | null;
  /** Resolves when every queued message has been handled. For tests. */
  settled(): Promise<void>;
}

const DEFAULTS = {
  maxMessagesPerWindow: 240,
  windowMs: 10_000,
  helloTimeoutMs: 15_000,
  maxFrameBytes: 1024 * 1024,
} as const;

export function createIngestSession(deps: SessionDeps): IngestSession {
  const clock = deps.clock ?? systemClock;
  const limits = {
    maxMessagesPerWindow: deps.limits?.maxMessagesPerWindow ?? DEFAULTS.maxMessagesPerWindow,
    windowMs: deps.limits?.windowMs ?? DEFAULTS.windowMs,
    helloTimeoutMs: deps.limits?.helloTimeoutMs ?? DEFAULTS.helloTimeoutMs,
    maxFrameBytes: deps.limits?.maxFrameBytes ?? DEFAULTS.maxFrameBytes,
  };

  const decoder = createFrameDecoder({ maxPayloadBytes: limits.maxFrameBytes });
  const openedAt = clock.now();

  let member: IngestMember | null = null;
  let closed = false;
  let windowStart = openedAt;
  let windowCount = 0;

  // Text messages wait here so that the async identity lookup cannot reorder
  // them: a batch that arrived while the hello was still resolving must be
  // handled after it, not before.
  const inbox: string[] = [];
  let draining: Promise<void> = Promise.resolve();
  let pending = false;

  function closeWith(code: number, reason: string): void {
    if (closed) return;
    closed = true;
    try {
      deps.transport.send(encodeClose(code, reason));
    } catch {
      // The socket is already gone; the close below is the part that matters.
    }
    try {
      deps.transport.close();
    } catch {
      /* nothing further to do */
    }
    deps.log.debug("client ingest session closed", {
      code,
      reason,
      memberId: member?.memberId ?? null,
      remote: deps.remote ?? null,
    });
  }

  function sendJson(value: unknown): void {
    if (closed) return;
    try {
      deps.transport.send(encodeText(JSON.stringify(value)));
    } catch {
      /* a failed send is a dead socket; the read side will notice */
    }
  }

  function overRate(): boolean {
    const now = clock.now();
    if (now - windowStart >= limits.windowMs) {
      windowStart = now;
      windowCount = 0;
    }
    windowCount += 1;
    return windowCount > limits.maxMessagesPerWindow;
  }

  async function handleHello(text: string): Promise<void> {
    const parsed = parseMessage(text);
    if (!parsed.ok || parsed.message.type !== "hello") {
      // Refusing before identity is deliberately uninformative: an unlinked
      // client learns that it was refused, not what would have worked.
      deps.log.warn("client ingest handshake rejected", {
        reason: parsed.ok ? "first message was not a hello" : parsed.reason,
        remote: deps.remote ?? null,
      });
      closeWith(CLOSE.BAD_HANDSHAKE, "expected a hello message");
      return;
    }

    const { mcUsername, moduleVersion } = parsed.message;

    let resolved: IngestMember | null = null;
    try {
      resolved = await deps.resolver.resolveByIgn(mcUsername);
    } catch (error) {
      deps.log.error("client ingest identity lookup failed", {
        mcUsername,
        error: error instanceof Error ? error.message : String(error),
      });
      closeWith(CLOSE.INTERNAL_ERROR, "could not verify the account");
      return;
    }

    if (resolved === null) {
      deps.log.warn("client ingest rejected an unlinked account", {
        mcUsername,
        remote: deps.remote ?? null,
      });
      closeWith(CLOSE.UNKNOWN_ACCOUNT, "this Minecraft account is not linked to a guild member");
      return;
    }

    member = resolved;
    deps.log.info("client ingest session opened", {
      memberId: resolved.memberId,
      ign: resolved.ign,
      mcUsername,
      moduleVersion,
      remote: deps.remote ?? null,
    });
    sendJson({ type: "hello_ok", memberId: resolved.memberId, ign: resolved.ign, serverTime: clock.now() });
  }

  function handleEvents(events: readonly RawEvent[]): void {
    if (member === null || events.length === 0) return;
    const receivedAt = clock.now();

    const buffered: BufferedEvent[] = events.map((event) => ({
      receivedAt,
      eventName: event.eventName,
      timestamp: event.timestamp,
      payload: event.payload,
      ...(event.seq === undefined ? {} : { seq: event.seq }),
      ...(event.session === undefined ? {} : { session: event.session }),
    }));

    deps.ring.record(member, buffered);

    // Phase 1 persistence is the structured log and nothing else. Logged one
    // line per event rather than one per batch, because the point of this phase
    // is reading individual events back.
    for (const event of buffered) {
      deps.log.info("client ingest raw_event", {
        memberId: member.memberId,
        ign: member.ign,
        eventName: event.eventName,
        clientTimestamp: event.timestamp,
        seq: event.seq ?? null,
        session: event.session ?? null,
        payload: event.payload,
      });
    }
  }

  async function handleMessage(text: string): Promise<void> {
    if (closed) return;

    if (member === null) {
      await handleHello(text);
      return;
    }

    const parsed = parseMessage(text);
    if (!parsed.ok) {
      deps.log.warn("client ingest dropped a malformed message", {
        memberId: member.memberId,
        reason: parsed.reason,
      });
      return;
    }
    if (parsed.message.type === "hello") {
      // A second hello is not a re-identification. Allowing one would let a
      // connection change whose data it is halfway through.
      closeWith(CLOSE.PROTOCOL_ERROR, "already identified");
      return;
    }
    handleEvents(parsed.message.events);
  }

  function drain(): void {
    if (pending) return;
    pending = true;
    draining = draining
      .then(async () => {
        while (inbox.length > 0 && !closed) {
          const next = inbox.shift();
          if (next === undefined) break;
          await handleMessage(next);
        }
      })
      .catch((error: unknown) => {
        deps.log.error("client ingest session failed", {
          error: error instanceof Error ? error.message : String(error),
          memberId: member?.memberId ?? null,
        });
        closeWith(CLOSE.INTERNAL_ERROR, "session error");
      })
      .finally(() => {
        pending = false;
        if (inbox.length > 0 && !closed) drain();
      });
  }

  return {
    push(chunk: Buffer): void {
      if (closed) return;

      if (member === null && clock.now() - openedAt > limits.helloTimeoutMs) {
        closeWith(CLOSE.BAD_HANDSHAKE, "handshake timed out");
        return;
      }

      const result = decoder.push(chunk);

      for (const frame of result.frames) {
        if (closed) return;

        switch (frame.opcode) {
          case OPCODE.TEXT:
            if (overRate()) {
              deps.log.warn("client ingest rate limited a session", {
                memberId: member?.memberId ?? null,
                remote: deps.remote ?? null,
              });
              closeWith(CLOSE.RATE_LIMITED, "too many messages");
              return;
            }
            inbox.push(frame.payload.toString("utf8"));
            break;

          case OPCODE.PING:
            try {
              deps.transport.send(encodePong(frame.payload));
            } catch {
              /* dead socket */
            }
            break;

          case OPCODE.PONG:
            break;

          case OPCODE.CLOSE:
            closeWith(CLOSE.NORMAL, "client closed");
            return;

          case OPCODE.BINARY:
            // The protocol is JSON text. A binary frame is not something a
            // correct client sends, so it is refused rather than ignored.
            closeWith(CLOSE.UNSUPPORTED_DATA, "binary frames are not accepted");
            return;

          case OPCODE.CONTINUATION:
            // Fragmented text is legal WebSocket but nothing we send or expect;
            // accepting it would mean reassembly with its own size limits.
            closeWith(CLOSE.UNSUPPORTED_DATA, "fragmented messages are not accepted");
            return;

          default:
            closeWith(CLOSE.PROTOCOL_ERROR, "unknown opcode");
            return;
        }
      }

      if (result.error !== undefined) {
        closeWith(result.error.code, result.error.reason);
        return;
      }

      if (inbox.length > 0) drain();
    },

    end(): void {
      if (closed) return;
      closed = true;
      deps.log.debug("client ingest peer disconnected", { memberId: member?.memberId ?? null });
    },

    shutdown(code = CLOSE.GOING_AWAY, reason = "server shutting down"): void {
      closeWith(code, reason);
    },

    isAuthenticated(): boolean {
      return member !== null;
    },

    member(): IngestMember | null {
      return member;
    },

    async settled(): Promise<void> {
      await draining;
    },
  };
}
