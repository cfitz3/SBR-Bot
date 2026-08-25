/**
 * The message contract between the ctjs module and this endpoint.
 *
 * Phase 1 has no schema for dungeon data and deliberately so — the payload of a
 * `raw_event` is whatever the client captured, passed through untouched. What
 * *is* pinned down is the envelope: what the first message must be, what a
 * message must carry to be routable, and how big any of it is allowed to get.
 *
 * Everything arriving here is from a Minecraft client on somebody's home
 * machine. It is parsed as hostile input: validated by shape, bounded by size,
 * and never trusted to be the thing the module was written to send.
 */

/** Ceilings. Generous for real traffic, closed against a client gone wrong. */
export const LIMITS = {
  /** One text frame. The module batches up to 100 events per frame. */
  maxMessageBytes: 512 * 1024,
  /** Events in one `raw_batch`. */
  maxBatchEvents: 500,
  /** A serialised event payload, once re-encoded for the log. */
  maxPayloadChars: 16 * 1024,
  maxUsernameLength: 16,
  maxEventNameLength: 64,
  maxModuleVersionLength: 32,
} as const;

export interface HelloMessage {
  readonly type: "hello";
  readonly mcUsername: string;
  readonly moduleVersion: string;
}

export interface RawEvent {
  readonly type: "raw_event";
  readonly eventName: string;
  readonly timestamp: number;
  readonly payload: unknown;
  readonly seq?: number | undefined;
  readonly session?: string | undefined;
}

export type ClientMessage = HelloMessage | { readonly type: "raw_batch"; readonly events: readonly RawEvent[] };

export type ParseResult =
  | { readonly ok: true; readonly message: ClientMessage }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/** Minecraft usernames: 3-16 of `[A-Za-z0-9_]`. Anything else is not one. */
const USERNAME = /^[A-Za-z0-9_]{3,16}$/;

function parseRawEvent(value: unknown): RawEvent | null {
  if (!isRecord(value)) return null;
  if (value["type"] !== "raw_event") return null;

  const eventName = readString(value["eventName"], LIMITS.maxEventNameLength);
  if (eventName === null) return null;

  const rawTimestamp = value["timestamp"];
  // A client clock can be wrong, and that is not our problem to fix here — but
  // it does have to be a finite number so the log can sort by it.
  const timestamp = typeof rawTimestamp === "number" && Number.isFinite(rawTimestamp) ? rawTimestamp : Date.now();

  const event: RawEvent = {
    type: "raw_event",
    eventName,
    timestamp,
    payload: value["payload"] ?? null,
    ...(typeof value["seq"] === "number" && Number.isFinite(value["seq"]) ? { seq: value["seq"] } : {}),
    ...(typeof value["session"] === "string" ? { session: value["session"].slice(0, 64) } : {}),
  };
  return event;
}

/**
 * Parse one text frame.
 *
 * A single `raw_event` is accepted as well as a `raw_batch` of them: the module
 * batches because the JDK client allows one send in flight at a time, but the
 * batch is transport framing, and a client that sends events one at a time is
 * saying exactly the same thing.
 */
export function parseMessage(text: string): ParseResult {
  if (Buffer.byteLength(text, "utf8") > LIMITS.maxMessageBytes) {
    return { ok: false, reason: "message exceeds the size limit" };
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: "message is not valid JSON" };
  }

  if (!isRecord(value)) return { ok: false, reason: "message is not an object" };

  switch (value["type"]) {
    case "hello": {
      const mcUsername = readString(value["mcUsername"], LIMITS.maxUsernameLength);
      if (mcUsername === null || !USERNAME.test(mcUsername)) {
        return { ok: false, reason: "hello is missing a usable mcUsername" };
      }
      const moduleVersion = readString(value["moduleVersion"], LIMITS.maxModuleVersionLength) ?? "unknown";
      return { ok: true, message: { type: "hello", mcUsername, moduleVersion } };
    }

    case "raw_event": {
      const event = parseRawEvent(value);
      if (event === null) return { ok: false, reason: "raw_event is malformed" };
      return { ok: true, message: { type: "raw_batch", events: [event] } };
    }

    case "raw_batch": {
      const list = value["events"];
      if (!Array.isArray(list)) return { ok: false, reason: "raw_batch has no events array" };
      if (list.length > LIMITS.maxBatchEvents) return { ok: false, reason: "raw_batch exceeds the event limit" };
      const events: RawEvent[] = [];
      for (const entry of list) {
        const event = parseRawEvent(entry);
        // One bad event does not discard the batch: the rest of a dungeon run
        // is still worth having, and a dropped event is counted, not hidden.
        if (event !== null) events.push(event);
      }
      return { ok: true, message: { type: "raw_batch", events } };
    }

    default:
      return { ok: false, reason: "unknown message type" };
  }
}
