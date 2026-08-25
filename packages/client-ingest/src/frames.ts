/**
 * The RFC 6455 wire format, by hand.
 *
 * The web panel is deliberately a zero-dependency `node:http` server, and one
 * WebSocket route is not a good enough reason to make that untrue. Framing is a
 * small, closed, well-specified problem — the whole of it fits below — and
 * doing it here buys something a library would not: the decoder is a pure
 * function of bytes in, frames out, so every path through it is testable
 * offline with a Buffer and no socket anywhere.
 *
 * Scope is only what an ingest endpoint needs: text frames in, close and pong
 * out. Binary payloads and extensions are rejected rather than half-supported.
 */

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

/** Close codes. 4000-4999 is the application range; ours carry the refusals. */
export const CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  POLICY_VIOLATION: 1008,
  TOO_LARGE: 1009,
  INTERNAL_ERROR: 1011,
  /** The client never sent a valid `hello`, or sent something else first. */
  BAD_HANDSHAKE: 4400,
  /** The `mcUsername` does not resolve to a linked guild member. */
  UNKNOWN_ACCOUNT: 4401,
  /** Too many messages, too fast. */
  RATE_LIMITED: 4429,
} as const;

export interface Frame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

export interface DecodeResult {
  readonly frames: readonly Frame[];
  /** Set when the stream is unrecoverable; the caller should close with `code`. */
  readonly error?: { readonly code: number; readonly reason: string };
}

export interface FrameDecoderOptions {
  /** Hard ceiling on a single frame. Beyond this we close rather than buffer. */
  readonly maxPayloadBytes?: number;
}

const DEFAULT_MAX_PAYLOAD = 1024 * 1024;

export interface FrameDecoder {
  push(chunk: Buffer): DecodeResult;
  /** Bytes held awaiting the rest of a frame. Exposed for tests and metrics. */
  pending(): number;
}

/**
 * Incremental decoder for the client-to-server direction.
 *
 * TCP does not deliver frames, it delivers bytes, so a chunk may hold three
 * frames or a third of one. Everything that has not yet resolved into a
 * complete frame stays in `buffered` until more arrives.
 */
export function createFrameDecoder(options: FrameDecoderOptions = {}): FrameDecoder {
  const maxPayload = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD;
  let buffered: Buffer = Buffer.alloc(0);
  let failed = false;

  return {
    pending(): number {
      return buffered.length;
    },

    push(chunk: Buffer): DecodeResult {
      if (failed) return { frames: [] };
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);

      const frames: Frame[] = [];

      for (;;) {
        if (buffered.length < 2) return { frames };

        const first = buffered[0] as number;
        const second = buffered[1] as number;

        // RSV1-3 must be zero: we negotiate no extensions, so a set bit means
        // the peer is speaking something we did not agree to.
        if ((first & 0x70) !== 0) {
          failed = true;
          return { frames, error: { code: CLOSE.PROTOCOL_ERROR, reason: "reserved bits set" } };
        }

        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;

        // Every frame from a client must be masked. An unmasked one is either a
        // broken client or something pretending to be one; both get closed.
        if (!masked) {
          failed = true;
          return { frames, error: { code: CLOSE.PROTOCOL_ERROR, reason: "client frame was not masked" } };
        }

        if (length === 126) {
          if (buffered.length < offset + 2) return { frames };
          length = buffered.readUInt16BE(offset);
          offset += 2;
        } else if (length === 127) {
          if (buffered.length < offset + 8) return { frames };
          const big = buffered.readBigUInt64BE(offset);
          if (big > BigInt(maxPayload)) {
            failed = true;
            return { frames, error: { code: CLOSE.TOO_LARGE, reason: "frame exceeds the payload limit" } };
          }
          length = Number(big);
          offset += 8;
        }

        if (length > maxPayload) {
          failed = true;
          return { frames, error: { code: CLOSE.TOO_LARGE, reason: "frame exceeds the payload limit" } };
        }

        // Control frames carry their meaning in the header; a fragmented or
        // oversized one is malformed by definition.
        if (opcode >= 0x8 && (!fin || length > 125)) {
          failed = true;
          return { frames, error: { code: CLOSE.PROTOCOL_ERROR, reason: "malformed control frame" } };
        }

        const maskStart = offset;
        const dataStart = maskStart + 4;
        if (buffered.length < dataStart + length) return { frames };

        const payload = Buffer.allocUnsafe(length);
        for (let i = 0; i < length; i += 1) {
          payload[i] = (buffered[dataStart + i] as number) ^ (buffered[maskStart + (i % 4)] as number);
        }

        frames.push({ fin, opcode, payload });
        buffered = buffered.subarray(dataStart + length);
      }
    },
  };
}

/**
 * Encode a server-to-client frame.
 *
 * Server frames are never masked — the spec forbids it, and a client that
 * receives a masked frame is required to fail the connection.
 */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;

  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x80 | opcode; // FIN set: we never fragment outbound.
  return Buffer.concat([header, payload]);
}

export function encodeText(text: string): Buffer {
  return encodeFrame(OPCODE.TEXT, Buffer.from(text, "utf8"));
}

export function encodeClose(code: number, reason: string): Buffer {
  const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123);
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return encodeFrame(OPCODE.CLOSE, payload);
}

export function encodePong(payload: Buffer): Buffer {
  return encodeFrame(OPCODE.PONG, payload);
}
