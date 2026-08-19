/**
 * The bridge bot's loopback control API — the ticket half.
 *
 * Ticket channels live in the community server, and this process is the one
 * holding a gateway connection to it. So "Publish" on the panel's tickets page
 * and `/tickets close` on the admin bot both have to end up here: the panel has
 * no gateway at all, and the admin bot is a different client in a different
 * server. Everything else about tickets — categories, limits, transcripts on
 * disk — is database work either of them can do directly, and does.
 *
 * This is deliberately a near-copy of `apps/admin-bot/src/internal-api.ts`
 * rather than a shared abstraction: the two answer different questions, and the
 * thing worth keeping identical is the security posture, which is short enough
 * to read twice. Loopback bind, bearer token compared in constant time, no
 * cookies and no session. The token is shared with the admin bot's API because
 * both sockets sit in the same trust domain on the same host; a second secret
 * would be a second thing to rotate and no additional boundary.
 *
 * Every route answers with a `problem` string on failure rather than a bare
 * status, because the caller renders it to whoever pressed the button. A panel
 * that says "check my permissions in that channel" is worth a great deal more
 * than one that says 500.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Logger } from "@sbr/observability";
import type { TicketGateway } from "./tickets.js";

const BIND_HOST = "127.0.0.1";

/** Bodies here are a couple of ids and a close reason. */
const MAX_BODY_BYTES = 16 * 1024;

export interface BridgeApiDeps {
  /**
   * Resolved per request rather than captured, because the gateway is built
   * after the Discord client logs in — and a request arriving in that window
   * should say "not ready" rather than crash on a null.
   */
  readonly tickets: () => TicketGateway | null;
  /** Platform guild id → Discord snowflake, so callers never map ids themselves. */
  readonly toDiscordGuildId: (internalGuildId: string) => Promise<string | null>;
  readonly token: string;
  readonly port: number;
  readonly logger: Logger;
}

function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

/** Size-checked while streaming: content-length is a claim, not a guarantee. */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buf);
  }
  if (total === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export class BridgeApi {
  private readonly d: BridgeApiDeps;
  private readonly log: Logger;
  private server: Server | null = null;

  constructor(deps: BridgeApiDeps) {
    this.d = deps;
    this.log = deps.logger.child({ service: "bridge-api" });
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.log.error("bridge api request failed", { error: String(error) });
        if (!res.headersSent) sendJson(res, 500, { problem: "INTERNAL", detail: "the bridge could not answer" });
      });
    });
    server.headersTimeout = 15_000;
    server.requestTimeout = 30_000;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.d.port, BIND_HOST, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.log.info("bridge api listening", { host: BIND_HOST, port: this.d.port });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!tokenMatches(this.d.token, bearer(req))) {
      sendJson(res, 401, { problem: "UNAUTHORIZED", detail: "bad or missing token" });
      return;
    }

    const url = new URL(req.url ?? "/", `http://${BIND_HOST}`);
    const match = /^\/internal\/g\/([^/]+)\/([a-z-]+)$/.exec(url.pathname);
    if (!match) {
      sendJson(res, 404, { problem: "NOT_FOUND", detail: "no such route" });
      return;
    }
    const [, rawGuildId, resource] = match;
    const guildId = decodeURIComponent(rawGuildId ?? "");

    const tickets = this.d.tickets();
    if (tickets === null) {
      // 503, not 500: the caller should say "the bot is starting up", and a
      // retry a few seconds later will work.
      sendJson(res, 503, { problem: "NOT_READY", detail: "the bridge bot is still connecting" });
      return;
    }

    const method = req.method ?? "GET";
    if (method === "GET" && resource === "ticket-transcript") {
      const ticketId = url.searchParams.get("ticketId") ?? "";
      const transcript = await tickets.transcript(ticketId);
      if (transcript === null) {
        sendJson(res, 404, { problem: "NO_TICKET", detail: "no such ticket" });
        return;
      }
      sendJson(res, 200, { name: transcript.name, content: transcript.content });
      return;
    }

    if (method !== "POST") {
      sendJson(res, 405, { problem: "METHOD_NOT_ALLOWED", detail: "use POST" });
      return;
    }

    const body = await readBody(req);
    switch (resource) {
      case "ticket-panel":
        await this.publish(res, tickets, guildId, body);
        return;
      case "ticket-transcript":
        await this.resend(res, tickets, body);
        return;
      case "ticket-close":
        await this.close(res, tickets, guildId, body);
        return;
      default:
        sendJson(res, 404, { problem: "NOT_FOUND", detail: "no such route" });
        return;
    }
  }

  private async publish(
    res: ServerResponse,
    tickets: TicketGateway,
    guildId: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const panelId = str(body["panelId"]);
    if (panelId === null) {
      sendJson(res, 400, { problem: "BAD_REQUEST", detail: "panelId is required" });
      return;
    }
    const result = await tickets.publishPanel(guildId, panelId);
    if (!result.ok) {
      sendJson(res, 422, { problem: result.problem, detail: result.detail });
      return;
    }
    sendJson(res, 200, { channelId: result.channelId, messageId: result.messageId, edited: result.edited });
  }

  /**
   * Re-send a transcript. The opener is read from the ticket, never from the
   * body — a caller naming the recipient is a way to mail somebody else's
   * conversation to themselves.
   */
  private async resend(res: ServerResponse, tickets: TicketGateway, body: Record<string, unknown>): Promise<void> {
    const ticketId = str(body["ticketId"]);
    if (ticketId === null) {
      sendJson(res, 400, { problem: "BAD_REQUEST", detail: "ticketId is required" });
      return;
    }
    const sent = await tickets.deliverTranscriptById(ticketId);
    if (sent === null) {
      sendJson(res, 404, { problem: "NO_TICKET", detail: "no such ticket" });
      return;
    }
    if (!sent) {
      sendJson(res, 422, { problem: "NOT_DELIVERED", detail: "they have DMs closed — it is still on the panel" });
      return;
    }
    sendJson(res, 200, { sent: true });
  }

  private async close(
    res: ServerResponse,
    tickets: TicketGateway,
    guildId: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const ticketId = str(body["ticketId"]);
    const actorDiscordId = str(body["actorDiscordId"]);
    if (ticketId === null || actorDiscordId === null) {
      sendJson(res, 400, { problem: "BAD_REQUEST", detail: "ticketId and actorDiscordId are required" });
      return;
    }
    const discordGuildId = await this.d.toDiscordGuildId(guildId);
    if (discordGuildId === null) {
      sendJson(res, 404, { problem: "GUILD_NOT_FOUND", detail: "that server isn't linked here" });
      return;
    }
    const result = await tickets.closeById(ticketId, actorDiscordId, discordGuildId, str(body["reason"]));
    if (!result.ok) {
      sendJson(res, 422, { problem: result.problem, detail: result.detail });
      return;
    }
    sendJson(res, 200, { number: result.ticket.number });
  }
}
