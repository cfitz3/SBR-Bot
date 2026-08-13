/**
 * Web panel HTTP server (zero-dep node:http) — Discord OAuth login, the
 * guild-scoped JSON API over PanelService, and the static UI that reads it.
 * Sessions live in Redis.
 *
 * The UI is served from this same process rather than a separate framework
 * server: the session is an HttpOnly cookie this file issues, and putting a
 * second runtime in front of it would mean either duplicating the auth or
 * proxying every request through it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { panelOrigin } from "@sbr/config";
import { pingDb } from "@sbr/db";
import { getRedis, setJson, getJson, pingRedis } from "@sbr/redis";
import {
  commandStatsToCsv,
  rollupsToCsv,
  type AnalyticsVM,
  type MutationResult,
  type PageResult,
  type PanelSession,
  type RollupPeriod,
} from "@sbr/panel-core";
import type { PanelApp } from "./composition.js";
import { canManageGuild } from "./permissions.js";
import { resolveAsset } from "./static.js";

const SESSION_COOKIE = "sbr_sess";
/**
 * The CSRF half of the double-submit pair. Deliberately *not* HttpOnly — the
 * client has to read it to echo it back in a header, and that is exactly what
 * makes it a defence: a cross-origin page can cause the session cookie to be
 * sent, but same-origin policy stops it reading this one to forge the header.
 */
const CSRF_COOKIE = "sbr_csrf";
const CSRF_HEADER = "x-csrf-token";
const SESSION_TTL_S = 6 * 60 * 60;

/** Config payloads are a handful of fields; anything larger is not a real write. */
const MAX_BODY_BYTES = 16 * 1024;

/** OAuth round-trips are short; a state that outlives the redirect is a liability. */
const OAUTH_STATE_TTL_S = 10 * 60;

/**
 * Pinned, because an unversioned `discord.com/api/...` is not "whatever is
 * current" — it is whatever Discord still treats as the default, which is a
 * version old enough to send `permissions` on `/users/@me/guilds` as a JSON
 * *number* rather than the decimal string every current doc describes. Reading
 * that field as a string then matched nothing, and the panel showed an empty
 * guild selector whose wording blamed the platform for not knowing the guild.
 * The version an unversioned call resolves to is Discord's to change; the
 * shape our parsing depends on shouldn't be.
 */
const DISCORD_API = "https://discord.com/api/v10";

/** Discord's API is fast or broken; a request that hangs must not hang a login. */
const DISCORD_TIMEOUT_MS = 10_000;

const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * The only path that accepts a body. Writes live under their own prefix rather
 * than overloading the page routes with a verb, so "which URLs mutate" is
 * answerable by looking at the URL — by a reader, a log grep, or a proxy.
 */
const ACTION_PATH = /^\/api\/guilds\/([^/]+)\/actions\/([a-z.-]+)$/;

/**
 * The UI builds its DOM in JavaScript and loads nothing off-origin, so the
 * policy can be this tight — no 'unsafe-inline' anywhere, which is the whole
 * reason `index.html` carries no inline script or style.
 */
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
};

/** node:http leaves these unbounded by default, which is a slowloris invitation. */
const HEADERS_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;

/** Bounded fetch — Node's fetch has no default timeout. */
async function fetchJson(url: string, init: RequestInit = {}): Promise<{ ok: boolean; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { ok: res.ok, json };
  } catch {
    return { ok: false, json: undefined };
  } finally {
    clearTimeout(timer);
  }
}

interface PanelServer {
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...SECURITY_HEADERS });
  res.end(payload);
}

/**
 * Serve a file from `public/`, or answer false so the caller can 404.
 *
 * Nothing is fingerprinted, so everything is `no-cache`: the browser may keep
 * the copy but must revalidate. A stale `main.js` against a changed API is a
 * confusing failure to debug, and these assets are a few kilobytes.
 */
async function serveAsset(method: string, res: ServerResponse, pathname: string): Promise<boolean> {
  const asset = resolveAsset(pathname);
  if (!asset) return false;

  let body: Buffer;
  try {
    body = await readFile(asset.filePath);
  } catch {
    return false; // missing file — including a client build that hasn't run yet
  }

  res.writeHead(200, {
    "content-type": asset.contentType,
    "content-length": body.byteLength,
    "cache-control": "no-cache",
    ...SECURITY_HEADERS,
  });
  res.end(method === "HEAD" ? undefined : body);
  return true;
}

function redirect(res: ServerResponse, location: string, cookies: readonly string[] = []): void {
  const headers: Record<string, string | string[]> = { location };
  if (cookies.length > 0) headers["set-cookie"] = [...cookies];
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
  const session = await getJson<PanelSession>(ctx.keys.session(id));
  // A cookie pointing at a value that isn't a well-formed session is the same
  // situation as no cookie at all — an unauthenticated caller — not a 500.
  if (!session || typeof session.discordId !== "string" || !Array.isArray(session.manageableGuildIds)) {
    return null;
  }
  return session;
}

/**
 * Cookie attributes. `Secure` is omitted on a plaintext redirect URI because a
 * browser silently drops a Secure cookie over http, which would present as
 * "login succeeds but I'm never logged in" on a local dev box.
 */
function sessionCookie(value: string, maxAgeS: number, secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=${value}`, "HttpOnly", "Path=/", `Max-Age=${maxAgeS}`, "SameSite=Lax"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** The readable half of the pair — same lifetime, no HttpOnly (see CSRF_COOKIE). */
function csrfCookie(value: string, maxAgeS: number, secure: boolean): string {
  const parts = [`${CSRF_COOKIE}=${value}`, "Path=/", `Max-Age=${maxAgeS}`, "SameSite=Lax"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Constant-time compare that tolerates length mismatch without throwing. */
function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual requires equal lengths; comparing the length first leaks
  // only that, which an attacker guessing a 128-bit token already knows.
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Read a bounded JSON body.
 *
 * The cap is enforced while reading rather than from `content-length`, because a
 * chunked request can lie about its length or omit it entirely — trusting the
 * header is how a "16 KB limit" turns into an unbounded buffer.
 */
async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.byteLength;
      if (size > MAX_BODY_BYTES) return { ok: false, error: "body_too_large" };
      chunks.push(buf);
    }
  } catch {
    return { ok: false, error: "body_read_failed" };
  }
  if (size === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}

export async function startPanelServer(app: PanelApp): Promise<PanelServer> {
  const cfg = app.config;
  const ctx = await getRedis();
  // Declared by WEB_PANEL_SCHEME rather than sniffed from the redirect URI: the
  // scheme is the one place an operator states how the panel is reached, and a
  // browser drops a Secure cookie over http regardless of what we intended.
  const secureCookies = cfg.web.secureCookies;
  if (!secureCookies) {
    app.log.warn(
      'WEB_PANEL_SCHEME="http" — session cookies are not marked Secure and travel in plaintext. Use https once a certificate is available.',
    );
  }
  // The origin writes must come from. Resolved from the public URL, falling back
  // to the redirect URI and then the local bind address, so the check is active
  // on a bare-IP box instead of silently disabled.
  const selfOrigin = panelOrigin(cfg);

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void route(req, res).catch((error: unknown) => {
      app.log.error("panel request failed", { error: error instanceof Error ? error.message : "unknown" });
      if (!res.headersSent) send(res, 500, { error: "internal_error" });
    });
  };

  // TLS in-process only when cert material was supplied; the common shape is a
  // reverse proxy terminating TLS and forwarding plaintext to this port, which
  // is still `scheme=https` as far as cookies and origins are concerned.
  const server = cfg.web.tls
    ? createTlsServer(
        {
          cert: await readFile(cfg.web.tls.certPath),
          key: await readFile(cfg.web.tls.keyPath),
        },
        handler,
      )
    : createServer(handler);

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Base only exists to make a relative request target parseable; the origin
    // that matters for security decisions is `selfOrigin`, checked separately.
    const url = new URL(req.url ?? "/", selfOrigin);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // Writes: the one path that accepts a body, and the only one that takes POST.
    const action = ACTION_PATH.exec(path);
    if (action) {
      if (method !== "POST") {
        res.setHeader("allow", "POST");
        return send(res, 405, { error: "method_not_allowed" });
      }
      return handleAction(req, res, action[1]!, action[2]!);
    }

    // Everything else is a read. Rejecting other verbs up front — rather than
    // silently treating a POST as a GET — is what stops a cross-origin form
    // reaching an authenticated endpoint that never expected one.
    if (!READ_METHODS.has(method)) {
      res.setHeader("allow", "GET, HEAD");
      return send(res, 405, { error: "method_not_allowed" });
    }

    // Health. Redis is as load-bearing as Postgres here — without it no session
    // resolves and every authenticated route 500s — so reporting on the database
    // alone would show green during a total outage of the panel's actual work.
    if (path === "/health") {
      const [db, redis] = await Promise.all([pingDb(), pingRedis()]);
      const healthy = db.ok && redis.ok;
      return send(res, healthy ? 200 : 503, { status: healthy ? "ok" : "down", db, redis });
    }

    // OAuth start
    if (path === "/login") {
      if (!cfg.oauth.clientId || !cfg.oauth.redirectUri) return send(res, 503, { error: "oauth_not_configured" });
      // A single-use `state`, held server-side, ties the callback back to the
      // browser that started the flow. Without it any site can drive a victim
      // through a callback carrying the attacker's code, silently logging the
      // victim into the attacker's account.
      const state = randomUUID();
      await setJson(ctx.keys.oauthState(state), { createdAt: Date.now() }, OAUTH_STATE_TTL_S);

      const authorize = new URL("https://discord.com/api/oauth2/authorize");
      authorize.searchParams.set("client_id", cfg.oauth.clientId);
      authorize.searchParams.set("redirect_uri", cfg.oauth.redirectUri);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("scope", "identify guilds");
      authorize.searchParams.set("state", state);
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
      return redirect(res, "/", [
        sessionCookie("", 0, secureCookies),
        csrfCookie("", 0, secureCookies),
      ]);
    }

    // Guild selector — the one page with no guild in scope.
    if (path === "/api/guilds") {
      const result = await app.panel.loadSelector(await loadSession(req));
      return sendPage(res, result);
    }

    // Guild-scoped API (internal Guild.id in the path; the selector maps Discord→internal)
    const guildScoped = /^\/api\/guilds\/([^/]+)\/([a-z-]+)$/.exec(path);
    if (guildScoped) {
      const guildId = guildScoped[1]!;
      const page = guildScoped[2]!;
      const session = await loadSession(req);

      switch (page) {
        case "overview":
          return sendPage(res, await app.panel.loadOverview(session, guildId));
        case "moderation":
          return sendPage(
            res,
            await app.panel.loadModeration(session, guildId, url.searchParams.get("target") ?? ""),
          );
        case "analytics": {
          // Unrecognised or absent query params are omitted rather than passed
          // as undefined, so the service's own defaults and clamp decide the
          // window instead of a NaN reaching the date arithmetic.
          const result = await app.panel.loadAnalytics(session, guildId, analyticsOptions(url));
          // The export is the same authorized read in a different encoding —
          // routing it through loadAnalytics rather than its own query is what
          // keeps the access decision identical to the one on screen.
          // Tested on `data` rather than `access.allowed`: they are the same
          // condition (PageResult pairs them), but only this one narrows the
          // union — a denied read still falls through to the JSON envelope.
          if (url.searchParams.get("format") === "csv" && result.data !== null) {
            return sendCsv(res, url.searchParams.get("table"), result.data);
          }
          return sendPage(res, result);
        }
        case "events":
          return sendPage(
            res,
            await app.panel.loadEvents(session, guildId, url.searchParams.get("event") ?? ""),
          );
        case "members":
          return sendPage(
            res,
            await app.panel.loadMembers(session, guildId, {
              q: url.searchParams.get("q") ?? "",
              side: url.searchParams.get("side") ?? "all",
            }),
          );
        case "settings":
          return sendPage(res, await app.panel.loadSettings(session, guildId));
        case "milestones":
          return sendPage(res, await app.panel.loadMilestones(session, guildId));
        case "tickets":
          return sendPage(res, await app.panel.loadTickets(session, guildId));
        case "wordlist":
          return sendPage(res, await app.panel.loadWordlist(session, guildId));
        case "permissions":
          return sendPage(res, await app.panel.loadPermissions(session, guildId));
        case "health":
          return sendPage(res, await app.panel.loadHealth(session, guildId));
        // Backs the pickers rather than a page of its own. Three route names for
        // one read so the resource is in the URL — a log line then says which
        // picker was open, and a cache in front of the panel can vary on it.
        case "directory-channels":
          return sendPage(
            res,
            await app.panel.loadDirectory(session, guildId, "channels", url.searchParams.get("q") ?? ""),
          );
        case "directory-roles":
          return sendPage(
            res,
            await app.panel.loadDirectory(session, guildId, "roles", url.searchParams.get("q") ?? ""),
          );
        case "directory-members":
          return sendPage(
            res,
            await app.panel.loadDirectory(session, guildId, "members", url.searchParams.get("q") ?? ""),
          );
        default:
          return send(res, 404, { error: "not_found" });
      }
    }

    // Anything left that isn't the API is a UI asset. Checked last so a typo'd
    // API path can never be answered with the HTML shell, which would surface as
    // "the panel returns HTML where JSON was expected".
    if (!path.startsWith("/api/") && (await serveAsset(req.method ?? "GET", res, path))) return;

    send(res, 404, { error: "not_found" });
  }

  async function handleCallback(url: URL, res: ServerResponse): Promise<void> {
    const code = url.searchParams.get("code");
    if (!code) return send(res, 400, { error: "missing_code" });
    if (!cfg.oauth.clientId || !cfg.oauth.clientSecret || !cfg.oauth.redirectUri) {
      return send(res, 503, { error: "oauth_not_configured" });
    }

    // Consume the state before doing any work. DEL returning 1 is both the
    // check and the single-use guarantee: a replayed callback finds nothing.
    const state = url.searchParams.get("state");
    if (!state) return send(res, 400, { error: "missing_state" });
    const consumed = await ctx.client.del(ctx.keys.oauthState(state));
    if (consumed !== 1) return send(res, 400, { error: "invalid_state" });

    // Exchange the code and read the user + their guilds.
    const token = await fetchJson(`${DISCORD_API}/oauth2/token`, {
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
    if (!token.ok) return send(res, 502, { error: "token_exchange_failed" });
    const accessToken = (token.json as { access_token?: string } | undefined)?.access_token;
    if (!accessToken) return send(res, 502, { error: "no_access_token" });

    const auth = { authorization: `Bearer ${accessToken}` };
    const [meRes, guildsRes] = await Promise.all([
      fetchJson(`${DISCORD_API}/users/@me`, { headers: auth }),
      fetchJson(`${DISCORD_API}/users/@me/guilds`, { headers: auth }),
    ]);
    const me = meRes.json as { id?: string } | undefined;
    if (!meRes.ok || !me?.id) return send(res, 502, { error: "no_user" });
    // A failed or malformed guild list must not read as "manages nothing" —
    // that would silently present an empty panel instead of an upstream error.
    if (!guildsRes.ok || !Array.isArray(guildsRes.json)) {
      return send(res, 502, { error: "guild_list_failed" });
    }
    const guilds = guildsRes.json as Array<{ id?: unknown; permissions?: unknown }>;

    // Manageable = MANAGE_GUILD ∩ platform Guild records; store internal ids.
    const manageableGuildIds: string[] = [];
    // Counted alongside, because an empty result has three different causes and
    // the selector renders all of them as "no guilds to show": Discord returned
    // nothing (the `guilds` scope was never granted), nothing passed the
    // permission gate, or nothing matched a platform Guild row. Summarising the
    // funnel at login is what tells them apart from a log line instead of a
    // database session.
    let manageableCount = 0;
    const unmatched: string[] = [];
    for (const g of guilds) {
      if (typeof g.id !== "string") continue;
      if (!canManageGuild(g.permissions)) continue;
      manageableCount += 1;
      const internalId = await app.resolveGuild(g.id);
      if (internalId) manageableGuildIds.push(internalId);
      else unmatched.push(g.id);
    }

    // Info, not debug: this is the one place Discord authority and platform
    // records have to agree, and when they disagree the user is locked out of a
    // panel that looks like it simply has nothing in it. The unmatched ids are
    // capped because someone in fifty servers would otherwise log fifty
    // snowflakes on every sign-in.
    app.log.info("panel login resolved guilds", {
      discordId: me.id,
      returnedByDiscord: guilds.length,
      passedPermissionGate: manageableCount,
      matchedPlatformGuild: manageableGuildIds.length,
      unmatchedDiscordGuildIds: unmatched.slice(0, 10),
    });

    const sessionId = randomUUID();
    // Minted with the session and stored beside it, so a write is checked
    // against the server's copy rather than against the cookie it arrived with.
    const csrfToken = randomUUID();
    const session: PanelSession = { discordId: me.id, manageableGuildIds, csrfToken };
    await setJson(ctx.keys.session(sessionId), session, SESSION_TTL_S);

    redirect(res, "/", [
      sessionCookie(sessionId, SESSION_TTL_S, secureCookies),
      csrfCookie(csrfToken, SESSION_TTL_S, secureCookies),
    ]);
  }

  /**
   * Guild-scoped write. Authorization, rate limiting and validation all live in
   * PanelMutations; what this function owns is the parts that are only true over
   * HTTP — proving the request came from the panel's own UI, and bounding the
   * body before it is parsed.
   */
  async function handleAction(
    req: IncomingMessage,
    res: ServerResponse,
    guildId: string,
    name: string,
  ): Promise<void> {
    const session = await loadSession(req);
    if (!session) return send(res, 401, { error: "not_authenticated" });

    const csrf = checkCsrf(req, session);
    if (csrf) return send(res, 403, { error: csrf });

    const body = await readJsonBody(req);
    if (!body.ok) return send(res, body.error === "body_too_large" ? 413 : 400, { error: body.error });
    const b: Record<string, unknown> =
      typeof body.value === "object" && body.value !== null ? (body.value as Record<string, unknown>) : {};

    const m = app.mutations;
    switch (name) {
      case "config.channel":
        return sendMutation(res, await m.setChannel(session, guildId, b["slot"], b["channelId"]));
      case "config.hypixel":
        return sendMutation(res, await m.setHypixelGuild(session, guildId, b["guild"]));
      case "config.setting":
        return sendMutation(res, await m.setSetting(session, guildId, b["key"], b["value"]));
      case "config.role-mapping":
        return sendMutation(res, await m.setRoleMapping(session, guildId, b["role"], b["discordRoleId"]));
      case "config.feature":
        return sendMutation(res, await m.setFeature(session, guildId, b["feature"], b["enabled"]));
      case "config.recruitment":
        return sendMutation(res, await m.setRecruitment(session, guildId, b));
      case "config.screening":
        return sendMutation(res, await m.setScreeningPolicy(session, guildId, b));
      case "xp.source":
        return sendMutation(res, await m.setXpSource(session, guildId, b));
      case "xp.adjust":
        return sendMutation(res, await m.adjustXp(session, guildId, b));
      case "milestone.upsert":
        return sendMutation(res, await m.upsertMilestone(session, guildId, b));
      case "milestone.remove":
        return sendMutation(res, await m.removeMilestone(session, guildId, b["key"]));
      case "ticket.type.upsert":
        return sendMutation(res, await m.upsertTicketType(session, guildId, b));
      case "ticket.type.remove":
        return sendMutation(res, await m.removeTicketType(session, guildId, b["key"]));
      case "ticket.panel.save":
        return sendMutation(res, await m.saveTicketPanel(session, guildId, b));
      case "wordlist.upsert":
        return sendMutation(res, await m.upsertWordlistRule(session, guildId, b));
      case "wordlist.delete":
        return sendMutation(res, await m.deleteWordlistRule(session, guildId, b["id"]));
      case "moderation.defaults":
        return sendMutation(res, await m.setModerationDefaults(session, guildId, b));
      case "moderation.relay-sync":
        return sendMutation(res, await m.setRelaySync(session, guildId, b));
      case "automod.test":
        return sendMutation(res, await m.testAutomod(session, guildId, b));
      case "automod.rule.upsert":
        return sendMutation(res, await m.upsertAutomodRule(session, guildId, b));
      case "automod.rule.remove":
        return sendMutation(res, await m.removeAutomodRule(session, guildId, b));
      case "automod.enable":
        return sendMutation(res, await m.setAutomodEnabled(session, guildId, b));
      case "config.cooldowns":
        return sendMutation(res, await m.setCooldowns(session, guildId, b));
      // Permissions. Six writes because the page edits four independent stores
      // and one of them has a delete — batching them behind one action name
      // would make a failed rank mapping look like a failed capability floor.
      case "roles.binding":
        return sendMutation(res, await m.setRoleBinding(session, guildId, b));
      case "roles.rank":
        return sendMutation(res, await m.setRankMapping(session, guildId, b));
      case "roles.capability":
        return sendMutation(res, await m.setCapabilityFloor(session, guildId, b));
      case "roles.command":
        return sendMutation(res, await m.setCommandFloor(session, guildId, b));
      case "roles.exception":
        return sendMutation(res, await m.setPermissionException(session, guildId, b));
      case "roles.exception.remove":
        return sendMutation(res, await m.removePermissionException(session, guildId, b));
      case "health.run-job":
        return sendMutation(res, await m.runJob(session, guildId, b));
      case "bridge.suspend":
        return sendMutation(res, await m.setBridgeSuspended(session, guildId, b["suspended"]));
      case "moderation.action":
        return sendMutation(res, await m.applyModeration(session, guildId, b));
      case "application.decide":
        return sendMutation(
          res,
          await m.decideApplication(session, guildId, b["applicationId"], b["accept"], b["reason"]),
        );
      case "ticket.close":
        return sendMutation(res, await m.closeTicket(session, guildId, b["ticketId"], b["reason"]));
      case "event.create":
        return sendMutation(res, await m.createEvent(session, guildId, b));
      case "event.cancel":
        return sendMutation(res, await m.cancelEvent(session, guildId, b["eventId"]));
      case "member.role":
        return sendMutation(res, await m.setMemberRole(session, guildId, b["discordId"], b["role"]));
      case "member.unlink":
        return sendMutation(res, await m.unlinkMember(session, guildId, b["discordId"], b["minecraftUuid"]));
      default:
        return send(res, 404, { error: "not_found" });
    }
  }

  /**
   * Double-submit CSRF, plus an origin check where the browser offers one.
   *
   * The header is compared against the token held *in the session*, not against
   * the cookie it was sent with — a cookie-vs-header comparison passes for
   * anyone who can write cookies for this domain (a subdomain, say), and the
   * server already has the authoritative copy.
   */
  function checkCsrf(req: IncomingMessage, session: PanelSession): string | null {
    const origin = req.headers.origin;
    // Absent on same-origin fetch in some browsers; present and wrong is fatal.
    if (typeof origin === "string" && origin !== selfOrigin) return "bad_origin";

    if (!session.csrfToken) return "csrf_stale_session";
    const header = req.headers[CSRF_HEADER];
    const token = typeof header === "string" ? header : null;
    if (!token || !tokensMatch(token, session.csrfToken)) return "bad_csrf";
    return null;
  }

  // Bound how long a client may hold a socket without completing a request.
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;

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

/**
 * Status for a write outcome. A refusal is not a server fault, so each kind maps
 * to what the caller should do about it: fix the body (400), slow down (429), or
 * accept that the domain said no (409).
 */
function sendMutation(res: ServerResponse, result: MutationResult): void {
  // Discriminated on `error` and `ok`, not on `access.allowed`: they describe
  // the same three outcomes, but only the top-level fields narrow the union.
  if (result.error === null) {
    return send(res, result.ok ? 200 : denyStatus(result.access.reason), result);
  }

  if (result.error.kind === "RATE_LIMITED") {
    const retryAfterMs = result.error.retryAfterMs ?? 0;
    res.setHeader("retry-after", String(Math.ceil(retryAfterMs / 1000)));
    return send(res, 429, result);
  }
  return send(res, result.error.kind === "INVALID_INPUT" ? 400 : 409, result);
}

/** Every page result carries its own access decision; the status follows it. */
function sendPage(res: ServerResponse, result: PageResult<unknown>): void {
  send(res, result.access.allowed ? 200 : denyStatus(result.access.reason), result);
}

/**
 * CSV export of an analytics window (WEB_PANEL.md §4).
 *
 * `content-disposition: attachment` plus the existing `nosniff` is what keeps a
 * downloaded export a download: without it a browser is free to render the
 * response inline, and same-origin HTML is a far worse thing to hand back than
 * a file.
 */
function sendCsv(res: ServerResponse, table: string | null, data: AnalyticsVM): void {
  const commands = table === "commands";
  const body = commands ? commandStatsToCsv(data.topCommands) : rollupsToCsv(data.rollups);
  const stamp = data.until.slice(0, 10);

  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "content-disposition": `attachment; filename="sbr-${commands ? "commands" : "rollups"}-${stamp}.csv"`,
    "cache-control": "no-store",
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

function analyticsOptions(url: URL): { period?: RollupPeriod; rangeDays?: number } {
  const opts: { period?: RollupPeriod; rangeDays?: number } = {};

  const period = url.searchParams.get("period");
  if (period === "HOURLY" || period === "DAILY" || period === "WEEKLY" || period === "MONTHLY") {
    opts.period = period;
  }

  const days = Number(url.searchParams.get("days"));
  if (Number.isFinite(days)) opts.rangeDays = days;

  return opts;
}
