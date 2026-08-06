/**
 * Web panel HTTP server (zero-dep node:http) — Discord OAuth login + guild-scoped
 * JSON API over PanelService. This is the serving backend; a Next.js/React UI
 * (WEB_PANEL.md) would render these endpoints. Sessions live in Redis.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { pingDb } from "@sbr/db";
import { getRedis, setJson, getJson } from "@sbr/redis";
import type { PanelSession } from "@sbr/panel-core";
import type { PanelApp } from "./composition.js";

const SESSION_COOKIE = "sbr_sess";
const SESSION_TTL_S = 6 * 60 * 60;
const MANAGE_GUILD = 0x20n;

interface PanelServer {
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function redirect(res: ServerResponse, location: string, cookie?: string): void {
  const headers: Record<string, string> = { location };
  if (cookie) headers["set-cookie"] = cookie;
  res.writeHead(302, headers);
  res.end();
}

function readCookie(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === name && v) return decodeURIComponent(v);
  }
  return null;
}

async function loadSession(req: IncomingMessage): Promise<PanelSession | null> {
  const id = readCookie(req, SESSION_COOKIE);
  if (!id) return null;
  const ctx = await getRedis();
  return getJson<PanelSession>(ctx.keys.session(id));
}

export async function startPanelServer(app: PanelApp): Promise<PanelServer> {
  const cfg = app.config;
  const ctx = await getRedis();

  const server = createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      app.log.error("panel request failed", { error: error instanceof Error ? error.message : "unknown" });
      if (!res.headersSent) send(res, 500, { error: "internal_error" });
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${cfg.web.port}`);
    const path = url.pathname;

    // Health
    if (path === "/health") {
      const db = await pingDb();
      return send(res, db.ok ? 200 : 503, { status: db.ok ? "ok" : "down", db });
    }

    // OAuth start
    if (path === "/login") {
      if (!cfg.oauth.clientId || !cfg.oauth.redirectUri) return send(res, 503, { error: "oauth_not_configured" });
      const authorize = new URL("https://discord.com/api/oauth2/authorize");
      authorize.searchParams.set("client_id", cfg.oauth.clientId);
      authorize.searchParams.set("redirect_uri", cfg.oauth.redirectUri);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("scope", "identify guilds");
      return redirect(res, authorize.toString());
    }

    // OAuth callback
    if (path === "/api/auth/callback") {
      return handleCallback(url, res);
    }

    // Logout
    if (path === "/logout") {
      const id = readCookie(req, SESSION_COOKIE);
      if (id) await ctx.client.del(ctx.keys.session(id));
      return redirect(res, "/", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
    }

    // Guild-scoped API (internal Guild.id in the path; the selector maps Discord→internal)
    const overview = /^\/api\/guilds\/([^/]+)\/overview$/.exec(path);
    if (overview) {
      const session = await loadSession(req);
      const result = await app.panel.loadOverview(session, overview[1]!);
      return send(res, result.access.allowed ? 200 : denyStatus(result.access.reason), result);
    }

    const moderation = /^\/api\/guilds\/([^/]+)\/moderation$/.exec(path);
    if (moderation) {
      const session = await loadSession(req);
      const target = url.searchParams.get("target") ?? "";
      const result = await app.panel.loadModeration(session, moderation[1]!, target);
      return send(res, result.access.allowed ? 200 : denyStatus(result.access.reason), result);
    }

    send(res, 404, { error: "not_found" });
  }

  async function handleCallback(url: URL, res: ServerResponse): Promise<void> {
    const code = url.searchParams.get("code");
    if (!code) return send(res, 400, { error: "missing_code" });
    if (!cfg.oauth.clientId || !cfg.oauth.clientSecret || !cfg.oauth.redirectUri) {
      return send(res, 503, { error: "oauth_not_configured" });
    }

    // Exchange the code and read the user + their guilds.
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.oauth.clientId,
        client_secret: cfg.oauth.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: cfg.oauth.redirectUri,
      }),
    });
    if (!tokenRes.ok) return send(res, 502, { error: "token_exchange_failed" });
    const token = (await tokenRes.json()) as { access_token?: string };
    if (!token.access_token) return send(res, 502, { error: "no_access_token" });

    const auth = { authorization: `Bearer ${token.access_token}` };
    const me = (await fetch("https://discord.com/api/users/@me", { headers: auth }).then((r) => r.json())) as { id?: string };
    const guilds = (await fetch("https://discord.com/api/users/@me/guilds", { headers: auth }).then((r) => r.json())) as Array<{ id: string; permissions: string }>;
    if (!me.id) return send(res, 502, { error: "no_user" });

    // Manageable = MANAGE_GUILD ∩ platform Guild records; store internal ids.
    const manageableGuildIds: string[] = [];
    for (const g of guilds) {
      if ((BigInt(g.permissions) & MANAGE_GUILD) !== MANAGE_GUILD) continue;
      const internalId = await app.resolveGuild(g.id);
      if (internalId) manageableGuildIds.push(internalId);
    }

    const sessionId = randomUUID();
    const session: PanelSession = { discordId: me.id, manageableGuildIds };
    await setJson(ctx.keys.session(sessionId), session, SESSION_TTL_S);

    redirect(
      res,
      "/",
      `${SESSION_COOKIE}=${sessionId}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_S}; SameSite=Lax`,
    );
  }

  await new Promise<void>((resolve) => server.listen(cfg.web.port, resolve));

  return {
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function denyStatus(reason: string): number {
  return reason === "NOT_AUTHENTICATED" ? 401 : 403;
}
