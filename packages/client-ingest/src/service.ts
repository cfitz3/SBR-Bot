/**
 * The mountable service: everything an HTTP server needs to host `/ws/ingest`.
 *
 * This is the only file that knows a socket exists, and it knows as little as
 * it can — `UpgradeSocket` is the four methods actually used, not `net.Socket`,
 * so the upgrade path can be exercised with an object literal in a test.
 *
 * It deliberately does not open a port. The web panel already runs an HTTP
 * server with TLS, timeouts and shutdown handled; a second listener would be a
 * second set of all of that to get right, and a second thing to firewall.
 */
import type { Logger } from "@sbr/observability";
import { CLOSE } from "./frames.js";
import { acceptResponse, checkUpgrade, rejectResponse } from "./handshake.js";
import type { Clock, MemberResolver } from "./ports.js";
import { createEventRing, type EventRing, type MemberEvents } from "./ring.js";
import { createIngestSession, type IngestSession, type SessionLimits } from "./session.js";

export interface UpgradeSocket {
  write(data: Buffer | string): unknown;
  destroy(): unknown;
  setNoDelay?(noDelay: boolean): unknown;
  readonly remoteAddress?: string | undefined;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface UpgradeRequest {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
}

export interface ClientIngestOptions {
  readonly resolver: MemberResolver;
  readonly log: Logger;
  readonly clock?: Clock;
  readonly ring?: EventRing;
  readonly limits?: SessionLimits;
  /** Concurrent connections accepted. Beyond this, new ones are refused. */
  readonly maxSessions?: number;
}

export interface ClientIngestService {
  /** The path this service answers on. */
  readonly path: string;
  /** True when the request targets this service and should be handed to it. */
  matches(req: UpgradeRequest): boolean;
  /** Take over a socket. Returns false when the request was refused. */
  handleUpgrade(req: UpgradeRequest, socket: UpgradeSocket, head?: Buffer): boolean;
  recent(memberId: string, limit?: number): MemberEvents | null;
  members(): ReturnType<EventRing["members"]>;
  sessionCount(): number;
  /** Close every session. Called from the panel's shutdown path. */
  shutdown(): void;
}

const DEFAULT_PATH = "/ws/ingest";
const DEFAULT_MAX_SESSIONS = 200;

export function createClientIngestService(options: ClientIngestOptions): ClientIngestService {
  const ring = options.ring ?? createEventRing();
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessions = new Set<IngestSession>();

  function pathOf(req: UpgradeRequest): string {
    const url = req.url ?? "";
    const query = url.indexOf("?");
    return query === -1 ? url : url.slice(0, query);
  }

  function refuse(socket: UpgradeSocket, status: number, reason: string): boolean {
    try {
      socket.write(rejectResponse(status, reason));
    } catch {
      /* the socket is already gone */
    }
    try {
      socket.destroy();
    } catch {
      /* nothing further */
    }
    return false;
  }

  return {
    path: DEFAULT_PATH,

    matches(req: UpgradeRequest): boolean {
      return pathOf(req) === DEFAULT_PATH;
    },

    handleUpgrade(req: UpgradeRequest, socket: UpgradeSocket, head?: Buffer): boolean {
      const check = checkUpgrade(req);
      if (!check.ok) {
        options.log.warn("client ingest refused an upgrade", { status: check.status, reason: check.reason });
        return refuse(socket, check.status, check.reason);
      }

      if (sessions.size >= maxSessions) {
        options.log.warn("client ingest refused a connection at capacity", { sessions: sessions.size });
        return refuse(socket, 503, "ingest is at capacity");
      }

      try {
        socket.setNoDelay?.(true);
        socket.write(acceptResponse(check.accept));
      } catch (error) {
        options.log.warn("client ingest could not complete an upgrade", {
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          socket.destroy();
        } catch {
          /* nothing further */
        }
        return false;
      }

      const session = createIngestSession({
        transport: {
          send(data: Buffer): void {
            socket.write(data);
          },
          close(): void {
            socket.destroy();
          },
        },
        resolver: options.resolver,
        ring,
        log: options.log,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        remote: socket.remoteAddress,
      });

      sessions.add(session);

      const finish = (): void => {
        session.end();
        sessions.delete(session);
      };

      socket.on("data", (chunk: Buffer) => {
        session.push(chunk);
      });
      socket.on("end", finish);
      socket.on("close", finish);
      socket.on("error", (error: Error) => {
        options.log.debug("client ingest socket error", { error: error.message });
        finish();
      });

      // Bytes the HTTP parser had already read past the request. Rare, but they
      // are the first frame when they happen, and losing them would strand the
      // handshake.
      if (head !== undefined && head.length > 0) session.push(head);

      return true;
    },

    recent(memberId: string, limit?: number): MemberEvents | null {
      return ring.recent(memberId, limit);
    },

    members(): ReturnType<EventRing["members"]> {
      return ring.members();
    },

    sessionCount(): number {
      return sessions.size;
    },

    shutdown(): void {
      for (const session of sessions) session.shutdown(CLOSE.GOING_AWAY, "server shutting down");
      sessions.clear();
    },
  };
}
