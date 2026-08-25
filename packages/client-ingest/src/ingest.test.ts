/**
 * The ingest endpoint, exercised without a socket.
 *
 * Everything below drives the real code paths a Minecraft client would: bytes
 * in through the decoder, bytes out through a fake transport. The point of
 * hand-rolling the framing was that this is possible — a rejected handshake and
 * a half-delivered frame are ordinary unit tests here rather than something you
 * need a live client to reach.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLOSE,
  OPCODE,
  createEventRing,
  createFrameDecoder,
  createIngestSession,
  computeAccept,
  checkUpgrade,
  encodeText,
  parseMessage,
  type IngestMember,
  type MemberResolver,
} from "./index.js";
import { createClientIngestService } from "./service.js";
import type { Logger } from "@sbr/observability";

// ─────────────────────────────── helpers ───────────────────────────────

/** Encode a frame the way a client must: masked. */
function clientFrame(opcode: number, payload: Buffer, mask = Buffer.from([1, 2, 3, 4])): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) {
    masked[i] = (payload[i] as number) ^ (mask[i % 4] as number);
  }
  return Buffer.concat([header, mask, masked]);
}

function clientText(text: string): Buffer {
  return clientFrame(OPCODE.TEXT, Buffer.from(text, "utf8"));
}

interface LogLine {
  level: string;
  message: string;
  fields: Record<string, unknown>;
}

function fakeLogger(): { log: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at =
    (level: string) =>
    (message: string, fields?: Record<string, unknown>): void => {
      lines.push({ level, message, fields: fields ?? {} });
    };
  const log = {
    trace: at("trace"),
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: () => log,
  } as unknown as Logger;
  return { log, lines };
}

function fakeTransport(): { sent: Buffer[]; closed: boolean; transport: { send(d: Buffer): void; close(): void } } {
  const state = { sent: [] as Buffer[], closed: false };
  return {
    get sent() {
      return state.sent;
    },
    get closed() {
      return state.closed;
    },
    transport: {
      send(data: Buffer): void {
        state.sent.push(data);
      },
      close(): void {
        state.closed = true;
      },
    },
  };
}

/** Decode what the server sent back, using the server-direction (unmasked) rules. */
function serverFrames(sent: readonly Buffer[]): { opcode: number; text: string; closeCode: number | null }[] {
  const out: { opcode: number; text: string; closeCode: number | null }[] = [];
  for (const buf of sent) {
    const first = buf[0] as number;
    const opcode = first & 0x0f;
    let length = (buf[1] as number) & 0x7f;
    let offset = 2;
    if (length === 126) {
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      length = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    const payload = buf.subarray(offset, offset + length);
    if (opcode === OPCODE.CLOSE) {
      out.push({ opcode, text: payload.subarray(2).toString("utf8"), closeCode: payload.readUInt16BE(0) });
    } else {
      out.push({ opcode, text: payload.toString("utf8"), closeCode: null });
    }
  }
  return out;
}

const MEMBER: IngestMember = { memberId: "1234567890", ign: "Notch" };

function resolverFor(known: Record<string, IngestMember>): MemberResolver {
  return {
    async resolveByIgn(ign: string): Promise<IngestMember | null> {
      return known[ign.toLowerCase()] ?? null;
    },
  };
}

function newSession(resolver: MemberResolver) {
  const ring = createEventRing({ perMember: 10 });
  const logger = fakeLogger();
  const wire = fakeTransport();
  const session = createIngestSession({ transport: wire.transport, resolver, ring, log: logger.log });
  return { ring, logger, wire, session };
}

// ─────────────────────────────── framing ───────────────────────────────

test("the decoder reassembles a frame split across chunks", () => {
  const decoder = createFrameDecoder();
  const frame = clientText("hello world");
  const first = decoder.push(frame.subarray(0, 4));
  assert.equal(first.frames.length, 0, "a partial frame is not a frame");
  const second = decoder.push(frame.subarray(4));
  assert.equal(second.frames.length, 1);
  assert.equal(second.frames[0]?.payload.toString("utf8"), "hello world");
  assert.equal(decoder.pending(), 0);
});

test("the decoder reads several frames out of one chunk", () => {
  const decoder = createFrameDecoder();
  const result = decoder.push(Buffer.concat([clientText("one"), clientText("two"), clientText("three")]));
  assert.deepEqual(
    result.frames.map((f) => f.payload.toString("utf8")),
    ["one", "two", "three"],
  );
});

test("an unmasked client frame is a protocol error", () => {
  // Not pedantry: masking is what the spec uses to keep a WebSocket from being
  // steered into looking like some other protocol to an intermediary.
  const decoder = createFrameDecoder();
  const unmasked = encodeText("no mask here");
  const result = decoder.push(unmasked);
  assert.equal(result.error?.code, CLOSE.PROTOCOL_ERROR);
});

test("an oversized frame is refused by its declared length, not by buffering it", () => {
  const decoder = createFrameDecoder({ maxPayloadBytes: 64 });
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 0x80 | 126;
  header.writeUInt16BE(1024, 2);
  const result = decoder.push(header);
  assert.equal(result.error?.code, CLOSE.TOO_LARGE);
  assert.equal(decoder.pending() < 1024, true, "the payload was never accumulated");
});

test("the accept hash matches the fixed example in RFC 6455", () => {
  assert.equal(computeAccept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("an upgrade without the websocket headers is refused with a status", () => {
  assert.equal(checkUpgrade({ method: "GET", headers: {} }).ok, false);
  const wrongVersion = checkUpgrade({
    method: "GET",
    headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "8", "sec-websocket-key": "x" },
  });
  assert.equal(wrongVersion.ok, false);
  assert.equal(wrongVersion.ok === false ? wrongVersion.status : 0, 426);
});

// ─────────────────────────────── protocol ───────────────────────────────

test("a hello needs a plausible Minecraft username", () => {
  assert.equal(parseMessage(JSON.stringify({ type: "hello", mcUsername: "Notch" })).ok, true);
  assert.equal(parseMessage(JSON.stringify({ type: "hello", mcUsername: "no" })).ok, false);
  assert.equal(parseMessage(JSON.stringify({ type: "hello", mcUsername: "has spaces" })).ok, false);
  assert.equal(parseMessage(JSON.stringify({ type: "hello" })).ok, false);
});

test("a lone raw_event is accepted as a batch of one", () => {
  const parsed = parseMessage(JSON.stringify({ type: "raw_event", eventName: "chat", timestamp: 5, payload: { a: 1 } }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.message.type === "raw_batch" ? parsed.message.events.length : 0, 1);
});

test("one malformed event does not discard the rest of the batch", () => {
  const parsed = parseMessage(
    JSON.stringify({
      type: "raw_batch",
      events: [
        { type: "raw_event", eventName: "chat", timestamp: 1, payload: null },
        { type: "raw_event", timestamp: 2 },
        { type: "raw_event", eventName: "death", timestamp: 3, payload: null },
      ],
    }),
  );
  assert.equal(parsed.ok, true);
  const names = parsed.ok && parsed.message.type === "raw_batch" ? parsed.message.events.map((e) => e.eventName) : [];
  assert.deepEqual(names, ["chat", "death"]);
});

test("junk is refused rather than thrown on", () => {
  assert.equal(parseMessage("not json").ok, false);
  assert.equal(parseMessage("[]").ok, false);
  assert.equal(parseMessage(JSON.stringify({ type: "something_else" })).ok, false);
});

// ─────────────────────────────── the session ───────────────────────────────

test("a linked account gets through the handshake and its events are recorded", async () => {
  const { ring, session, wire } = newSession(resolverFor({ notch: MEMBER }));

  session.push(clientText(JSON.stringify({ type: "hello", mcUsername: "Notch", moduleVersion: "0.1.0" })));
  await session.settled();
  assert.equal(session.isAuthenticated(), true);
  assert.equal(JSON.parse(serverFrames(wire.sent)[0]?.text ?? "{}").type, "hello_ok");

  session.push(
    clientText(
      JSON.stringify({
        type: "raw_batch",
        events: [{ type: "raw_event", eventName: "scoreboard.title", timestamp: 111, payload: { to: "SKYBLOCK" } }],
      }),
    ),
  );
  await session.settled();

  const recent = ring.recent(MEMBER.memberId);
  assert.equal(recent?.events.length, 1);
  assert.equal(recent?.events[0]?.eventName, "scoreboard.title");
  assert.equal(recent?.ign, "Notch");
});

test("an unlinked account is closed with a code that says why", async () => {
  const { session, wire, logger } = newSession(resolverFor({}));
  session.push(clientText(JSON.stringify({ type: "hello", mcUsername: "Stranger" })));
  await session.settled();

  assert.equal(session.isAuthenticated(), false);
  const [frame] = serverFrames(wire.sent);
  assert.equal(frame?.closeCode, CLOSE.UNKNOWN_ACCOUNT);
  assert.equal(wire.closed, true);
  assert.equal(
    logger.lines.some((l) => l.level === "warn" && l.message.includes("unlinked")),
    true,
  );
});

test("events sent before a hello are refused, not recorded", async () => {
  const { ring, session, wire } = newSession(resolverFor({ notch: MEMBER }));
  session.push(
    clientText(JSON.stringify({ type: "raw_event", eventName: "chat", timestamp: 1, payload: "hi" })),
  );
  await session.settled();

  assert.equal(session.isAuthenticated(), false);
  assert.equal(serverFrames(wire.sent)[0]?.closeCode, CLOSE.BAD_HANDSHAKE);
  assert.equal(ring.recent(MEMBER.memberId), null);
});

test("a second hello cannot re-identify a live connection", async () => {
  const { session, wire } = newSession(resolverFor({ notch: MEMBER, other: { memberId: "999", ign: "Other" } }));
  session.push(clientText(JSON.stringify({ type: "hello", mcUsername: "Notch" })));
  await session.settled();
  session.push(clientText(JSON.stringify({ type: "hello", mcUsername: "Other" })));
  await session.settled();

  assert.equal(session.member()?.memberId, MEMBER.memberId);
  const close = serverFrames(wire.sent).find((f) => f.opcode === OPCODE.CLOSE);
  assert.equal(close?.closeCode, CLOSE.PROTOCOL_ERROR);
});

test("events that arrive while the hello is still resolving are handled after it", async () => {
  // The identity lookup is async, so ordering is not free. If a batch were
  // handled before the hello resolved it would be dropped as unidentified.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resolver: MemberResolver = {
    async resolveByIgn(): Promise<IngestMember | null> {
      await gate;
      return MEMBER;
    },
  };
  const { ring, session } = newSession(resolver);

  session.push(clientText(JSON.stringify({ type: "hello", mcUsername: "Notch" })));
  session.push(
    clientText(JSON.stringify({ type: "raw_event", eventName: "chat", timestamp: 2, payload: "after" })),
  );
  release();
  await session.settled();

  assert.equal(ring.recent(MEMBER.memberId)?.events.length, 1);
});

test("a flood closes the connection instead of being absorbed", async () => {
  const ring = createEventRing();
  const logger = fakeLogger();
  const wire = fakeTransport();
  const session = createIngestSession({
    transport: wire.transport,
    resolver: resolverFor({ notch: MEMBER }),
    ring,
    log: logger.log,
    limits: { maxMessagesPerWindow: 3, windowMs: 60_000 },
  });

  for (let i = 0; i < 10; i += 1) {
    session.push(clientText(JSON.stringify({ type: "hello", mcUsername: "Notch" })));
  }
  await session.settled();

  const close = serverFrames(wire.sent).find((f) => f.closeCode === CLOSE.RATE_LIMITED);
  assert.notEqual(close, undefined);
  assert.equal(wire.closed, true);
});

test("a ping is answered with a pong carrying the same payload", () => {
  const { session, wire } = newSession(resolverFor({ notch: MEMBER }));
  session.push(clientFrame(OPCODE.PING, Buffer.from("keepalive")));
  const pong = serverFrames(wire.sent)[0];
  assert.equal(pong?.opcode, OPCODE.PONG);
  assert.equal(pong?.text, "keepalive");
});

// ─────────────────────────────── the ring ───────────────────────────────

test("the ring keeps the newest events and counts what it dropped", () => {
  const ring = createEventRing({ perMember: 3 });
  for (let i = 1; i <= 5; i += 1) {
    ring.record(MEMBER, [{ receivedAt: i, eventName: `e${i}`, timestamp: i, payload: null }]);
  }
  const recent = ring.recent(MEMBER.memberId);
  // Newest first: whoever reads this is checking whether what they just did
  // showed up.
  assert.deepEqual(recent?.events.map((e) => e.eventName), ["e5", "e4", "e3"]);
  assert.equal(recent?.received, 5);
  assert.equal(recent?.dropped, 2);
});

test("the ring evicts the least recently seen member rather than growing", () => {
  const ring = createEventRing({ perMember: 2, maxMembers: 2 });
  ring.record({ memberId: "a", ign: "A" }, [{ receivedAt: 1, eventName: "x", timestamp: 1, payload: null }]);
  ring.record({ memberId: "b", ign: "B" }, [{ receivedAt: 2, eventName: "x", timestamp: 2, payload: null }]);
  ring.record({ memberId: "c", ign: "C" }, [{ receivedAt: 3, eventName: "x", timestamp: 3, payload: null }]);

  assert.equal(ring.recent("a"), null);
  assert.deepEqual(ring.members().map((m) => m.memberId), ["c", "b"]);
});

// ─────────────────────────────── the service ───────────────────────────────

function fakeSocket() {
  const handlers = new Map<string, ((arg: never) => void)[]>();
  const state = { written: [] as (Buffer | string)[], destroyed: false };
  const socket = {
    write(data: Buffer | string): boolean {
      state.written.push(data);
      return true;
    },
    destroy(): void {
      state.destroyed = true;
    },
    setNoDelay(): void {},
    remoteAddress: "127.0.0.1",
    on(event: string, listener: (arg: never) => void): unknown {
      const list = handlers.get(event) ?? [];
      list.push(listener);
      handlers.set(event, list);
      return socket;
    },
  };
  return {
    socket,
    state,
    emit(event: string, arg?: unknown): void {
      for (const fn of handlers.get(event) ?? []) (fn as (value?: unknown) => void)(arg);
    },
  };
}

const UPGRADE_HEADERS = {
  upgrade: "websocket",
  connection: "Upgrade",
  "sec-websocket-version": "13",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
};

test("the service only claims its own path", () => {
  const service = createClientIngestService({ resolver: resolverFor({}), log: fakeLogger().log });
  assert.equal(service.matches({ url: "/ws/ingest", headers: {} }), true);
  assert.equal(service.matches({ url: "/ws/ingest?x=1", headers: {} }), true);
  assert.equal(service.matches({ url: "/api/guilds", headers: {} }), false);
});

test("a completed upgrade streams events through to the debug view", async () => {
  const service = createClientIngestService({ resolver: resolverFor({ notch: MEMBER }), log: fakeLogger().log });
  const peer = fakeSocket();

  const accepted = service.handleUpgrade({ method: "GET", url: "/ws/ingest", headers: UPGRADE_HEADERS }, peer.socket);
  assert.equal(accepted, true);
  assert.equal(String(peer.state.written[0]).startsWith("HTTP/1.1 101"), true);
  assert.equal(service.sessionCount(), 1);

  peer.emit("data", clientText(JSON.stringify({ type: "hello", mcUsername: "Notch" })));
  await new Promise((resolve) => setImmediate(resolve));
  peer.emit(
    "data",
    clientText(JSON.stringify({ type: "raw_event", eventName: "worldLoad", timestamp: 9, payload: null })),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(service.recent(MEMBER.memberId)?.events[0]?.eventName, "worldLoad");

  peer.emit("close");
  assert.equal(service.sessionCount(), 0);
});

test("a plain HTTP request to the ingest path gets an HTTP error, not a socket", () => {
  const service = createClientIngestService({ resolver: resolverFor({}), log: fakeLogger().log });
  const peer = fakeSocket();
  const accepted = service.handleUpgrade({ method: "GET", url: "/ws/ingest", headers: {} }, peer.socket);

  assert.equal(accepted, false);
  assert.equal(String(peer.state.written[0]).startsWith("HTTP/1.1 400"), true);
  assert.equal(peer.state.destroyed, true);
});
