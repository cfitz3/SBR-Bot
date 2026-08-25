/**
 * The HTTP half of a WebSocket connection: the one exchange that happens before
 * any framing, where a normal GET is answered with a 101 and the socket stops
 * being HTTP.
 *
 * Kept apart from `frames.ts` and from the panel server so it can be checked
 * against the fixed example in RFC 6455 §1.3 without a socket — the accept hash
 * is the sort of thing that is either exactly right or silently broken.
 */
import { createHash } from "node:crypto";

/** The magic constant from RFC 6455 §4.2.2. Not a secret; a fixed salt. */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface UpgradeRequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly method?: string | undefined;
}

export type UpgradeCheck =
  | { readonly ok: true; readonly accept: string }
  | { readonly ok: false; readonly status: number; readonly reason: string };

function header(req: UpgradeRequestLike, name: string): string | null {
  const value = req.headers[name];
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export function computeAccept(key: string): string {
  return createHash("sha1")
    .update(key + GUID, "utf8")
    .digest("base64");
}

/**
 * Validate an upgrade request.
 *
 * Every failure is a plain HTTP status rather than a close code, because at
 * this point there is no WebSocket to close — the response goes back down the
 * raw socket as an HTTP reply.
 */
export function checkUpgrade(req: UpgradeRequestLike): UpgradeCheck {
  if (req.method !== undefined && req.method.toUpperCase() !== "GET") {
    return { ok: false, status: 405, reason: "websocket upgrade must be a GET" };
  }

  const upgrade = header(req, "upgrade");
  if (upgrade === null || upgrade.toLowerCase() !== "websocket") {
    return { ok: false, status: 400, reason: "missing websocket upgrade header" };
  }

  const connection = header(req, "connection");
  if (connection === null || !connection.toLowerCase().includes("upgrade")) {
    return { ok: false, status: 400, reason: "missing connection: upgrade" };
  }

  const version = header(req, "sec-websocket-version");
  if (version !== "13") {
    // 13 is the only version anything current speaks; anything else is a
    // client we have no framing for.
    return { ok: false, status: 426, reason: "unsupported websocket version" };
  }

  const key = header(req, "sec-websocket-key");
  if (key === null || key.length === 0) {
    return { ok: false, status: 400, reason: "missing sec-websocket-key" };
  }

  return { ok: true, accept: computeAccept(key) };
}

export function acceptResponse(accept: string): string {
  return [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n");
}

export function rejectResponse(status: number, reason: string): string {
  const body = `${reason}\n`;
  return [
    `HTTP/1.1 ${status} ${reason}`,
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
    "",
    body,
  ].join("\r\n");
}
