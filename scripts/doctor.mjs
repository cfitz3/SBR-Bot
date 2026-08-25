/**
 * `npm run doctor` — answers "why won't it start?" without reading any source.
 *
 * Read-only: it inspects the toolchain, .env, datastore reachability, build
 * output and migration state, then prints the exact command to fix whatever is
 * wrong. Exits non-zero if anything blocking is broken, so CI can use it too.
 */
import { existsSync, readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { join } from "node:path";
import {
  APPS, NPM, ROOT, c, has, isConfigured, parseEnv, readEnv, run, say,
} from "./lib.mjs";

// A Set, because two dead datastores are one instruction ("start Docker"), and
// printing it twice makes the fix list look longer than the problem is.
const problems = new Set();
const note = (msg) => problems.add(msg);

const PASS = () => c.green("✓");
const FAIL = () => c.red("✗");
const SKIP = () => c.yellow("—");

const line = (icon, label, detail = "") => say(`  ${icon} ${label.padEnd(28)} ${c.gray(detail)}`);
const heading = (t) => say(`\n${c.bold(t)}`);

function reachable(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (r) => (socket.destroy(), resolve(r));
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Status code of a GET, or `null` if the host could not be reached.
 *
 * `node:https` rather than `fetch` deliberately: fetch's connection pool
 * outlives the call, and this script ends in `process.exit`, which on Windows
 * aborts the process outright if it races a socket the pool is still closing.
 * A request we own can be destroyed the moment the headers arrive — and the
 * body is never read, so a credential's response never enters memory.
 */
function httpStatus(url, headers, timeout = 5000) {
  return new Promise((resolve) => {
    const req = httpsRequest(url, { headers, timeout }, (res) => {
      res.resume();
      resolve(res.statusCode ?? null);
      req.destroy();
    });
    req.once("timeout", () => (req.destroy(), resolve(null)));
    req.once("error", () => resolve(null));
    req.end();
  });
}

function endpoint(url, fallbackPort) {
  try {
    const u = new URL(url ?? "");
    return { host: u.hostname, port: Number(u.port) || fallbackPort };
  } catch {
    return null;
  }
}

/**
 * Does `/ws/ingest` answer a WebSocket upgrade?
 *
 * Spoken over a raw socket rather than with a client library, because the thing
 * being checked *is* the handshake: a 101 carrying the right accept value proves
 * the route is mounted and the framing code is reachable. `fetch` cannot ask
 * that question, and a library would be a dependency added for one probe.
 *
 * Resolves "ok", "missing" (something answered, but not with an upgrade), or
 * null when nothing was listening at all.
 */
function ingestUpgrade(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let seen = "";
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once("timeout", () => done(null));
    socket.once("error", () => done(null));
    socket.once("connect", () => {
      socket.write(
        [
          "GET /ws/ingest HTTP/1.1",
          `Host: ${host}:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Version: 13",
          // The fixed nonce from RFC 6455, so the accept value we expect back is
          // a constant rather than something this script has to compute.
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      seen += chunk.toString("utf8");
      if (!seen.includes("\r\n\r\n")) return;
      const upgraded = seen.startsWith("HTTP/1.1 101") && seen.includes("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
      done(upgraded ? "ok" : "missing");
    });
  });
}


say(c.bold("\nSBR Guild Platform — doctor"));

// ── toolchain ───────────────────────────────────────────────────────────────

heading("Toolchain");
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 20) line(PASS(), "node", process.versions.node);
else {
  line(FAIL(), "node", `${process.versions.node} — needs ≥ 20`);
  note("Install Node 20+ from https://nodejs.org");
}

const dockerInstalled = has("docker");
const dockerRunning = dockerInstalled && run("docker", ["info"], { quiet: true }).code === 0;
if (dockerRunning) line(PASS(), "docker", "daemon running");
else if (dockerInstalled) line(SKIP(), "docker", "installed but the daemon is not running");
else line(SKIP(), "docker", "not installed — you'll need your own Postgres + Redis");

// ── environment ─────────────────────────────────────────────────────────────

heading("Environment (.env)");
const envExists = existsSync(join(ROOT, ".env"));
if (!envExists) {
  line(FAIL(), ".env", "missing");
  note("Run `npm run setup` to create it");
}
const env = readEnv();

const REQUIRED = ["DATABASE_URL", "REDIS_URL"];
const OPTIONAL = [
  ["DISCORD_BRIDGE_TOKEN", "bridge bot gateway"],
  ["DISCORD_ADMIN_TOKEN", "admin bot gateway"],
  ["HYPIXEL_API_KEY", "live stats, pricing, networth"],
  ["DISCORD_OAUTH_CLIENT_ID", "web panel login"],
  ["DISCORD_OAUTH_CLIENT_SECRET", "web panel login"],
  ["SESSION_SECRET", "web panel sessions"],
  ["MC_USERNAME", "in-game Mineflayer bridge"],
  ["INTERNAL_API_TOKEN", "the panel's Discord directory"],
];

for (const key of REQUIRED) {
  if (isConfigured(env.get(key))) line(PASS(), key, "set");
  else {
    line(FAIL(), key, "missing or still a placeholder");
    note(`Set ${key} in .env (see .env.example)`);
  }
}
for (const [key, why] of OPTIONAL) {
  if (isConfigured(env.get(key))) line(PASS(), key, "set");
  else line(SKIP(), key, `unset — disables ${why}`);
}

// Unset, this one disables three separate things and looks like three separate
// bugs: the panel's pickers fall back to raw-ID fields, Moderation's member
// lookup says "directory unavailable", and `discord-member-sync` skips every
// run so the Members page shows the in-game side only.
if (!isConfigured(env.get("INTERNAL_API_TOKEN"))) {
  say(`    ${c.gray("→ raw-ID fields, \"directory unavailable\", and no Discord member scan.")}`);
  say(`    ${c.gray("  `npm run setup` generates one; the Server Members intent is still a manual step.")}`);
}

// A key set twice in one file is not a harmless duplicate. dotenv keeps the
// *last* occurrence, so an operator who edits the copy they can see and leaves a
// later copy below it is running on a value they did not choose — and nothing
// anywhere reports it. Only divergent values are worth an operator's attention;
// three identical copies of the same URL are noise.
/** Keys `.env` sets more than once with differing values; read by the live-credential checks. */
const duplicated = new Set();
if (envExists) {
  const seen = new Map();
  readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/).forEach((raw, i) => {
    for (const [key, value] of parseEnv(raw)) {
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push({ value, line: i + 1 });
    }
  });
  const divergent = [...seen].filter(([, vs]) => vs.length > 1 && new Set(vs.map((v) => v.value)).size > 1);
  const repeated = [...seen].filter(([, vs]) => vs.length > 1);
  for (const [key] of divergent) duplicated.add(key);
  if (divergent.length > 0) {
    line(FAIL(), "duplicate keys", `${divergent.length} key(s) set more than once, with different values`);
    // Naming the line that wins is the whole point: "HYPIXEL_API_KEY is
    // duplicated" sends an operator to the copy they can already see, which is
    // usually the one they just fixed. "using line 116, you edited line 31"
    // ends the search.
    for (const [key, vs] of divergent) {
      say(`      ${c.gray(`${key}: lines ${vs.map((v) => v.line).join(", ")} — using line ${vs.at(-1).line}`)}`);
    }
    note("Delete the losing copies in .env — dotenv keeps the last one, which may not be the line you edited");
  } else if (repeated.length > 0) {
    line(SKIP(), "duplicate keys", `${repeated.length} key(s) repeated, all agreeing`);
  } else line(PASS(), "duplicate keys", "none");
}

// Being *set* is not the same as being safe to run on. These two are the ones
// where a present-but-wrong value fails silently: the panel will happily sign
// sessions with a four-character secret, and will happily put a session cookie
// on a plaintext connection, and neither shows up as an error anywhere.
const secret = env.get("SESSION_SECRET");
if (isConfigured(secret)) {
  // `npm run setup` generates 32 random bytes (64 hex chars); anything much
  // shorter is a hand-edited value that weakens every session it signs.
  if (secret.trim().length >= 32) line(PASS(), "SESSION_SECRET strength", `${secret.trim().length} chars`);
  else {
    line(FAIL(), "SESSION_SECRET strength", `only ${secret.trim().length} chars — needs ≥ 32`);
    note("Replace SESSION_SECRET in .env with 32+ random chars (`openssl rand -hex 32`)");
  }
}

const redirect = env.get("DISCORD_OAUTH_REDIRECT_URI");
if (isConfigured(redirect)) {
  if (redirect.startsWith("https://")) line(PASS(), "oauth redirect", "https — session cookie is Secure");
  else if (/^http:\/\/(localhost|127\.0\.0\.1)\b/.test(redirect)) {
    line(SKIP(), "oauth redirect", "http on localhost — fine for development");
  } else {
    line(FAIL(), "oauth redirect", "plaintext http on a non-local host");
    note("Serve the panel over https: the session cookie cannot be marked Secure otherwise");
  }
}

// ── live credentials ────────────────────────────────────────────────────────

// The one credential whose *validity* is worth a network call. A rejected
// Hypixel key does not fail loudly anywhere: the guild scan just records
// "roster fetch failed" every six hours, the roster silently stops moving, and
// the panel keeps serving the last good cache. Asking Hypixel directly is the
// only way to tell an expired key from an unreachable one.
//
// The key travels in the `API-Key` header and is never printed — not the value,
// not a prefix. The only thing this reports is what Hypixel said about it.
//
// `/v2/counts`, not `/v2/key`: the key-info endpoint was removed from v2, so a
// perfectly good key gets `404 Unknown endpoint` there and this check reported
// "unexpected status 404" at the operator — a health check that cries wolf
// about the one credential it exists to vouch for. `/v2/counts` is the cheapest
// key-authed endpoint that is still real: no path parameters, no player lookup,
// one line of JSON, and it answers the only question being asked — does
// Hypixel accept this key.
const hypixelKey = env.get("HYPIXEL_API_KEY");
if (isConfigured(hypixelKey)) {
  heading("Live credentials");
  const status = await httpStatus("https://api.hypixel.net/v2/counts", { "API-Key": hypixelKey.trim() });
  if (status === null) line(SKIP(), "hypixel api key", "could not reach api.hypixel.net — offline?");
  else if (status >= 200 && status < 300) line(PASS(), "hypixel api key", "accepted");
  else if (status === 403 || status === 401) {
    line(FAIL(), "hypixel api key", `rejected (${status}) — the guild scan cannot read the roster`);
    // Order matters: if the key is also duplicated, "issue a new key" is the
    // wrong advice — the good key may already be in the file, three lines up.
    if (duplicated.has("HYPIXEL_API_KEY")) {
      note("HYPIXEL_API_KEY is set more than once and the *last* copy is the one being tested — delete the stale copies before issuing a new key");
    } else note("Issue a new key at https://developer.hypixel.net and set HYPIXEL_API_KEY in .env");
  } else if (status === 429) {
    line(SKIP(), "hypixel api key", "rate limited — could not check, try again in a minute");
  } else line(SKIP(), "hypixel api key", `unexpected status ${status}`);
}

// ── datastores ──────────────────────────────────────────────────────────────

heading("Datastores");
const pg = endpoint(env.get("DATABASE_URL"), 5432);
const redis = endpoint(env.get("REDIS_URL"), 6379);
let pgUp = false;

if (pg) {
  pgUp = await reachable(pg.host, pg.port);
  line(pgUp ? PASS() : FAIL(), "postgres", `${pg.host}:${pg.port}${pgUp ? "" : " — not reachable"}`);
  if (!pgUp) note(dockerRunning ? "Run `npm run infra:up`" : "Start Docker Desktop, then `npm run infra:up`");
} else line(FAIL(), "postgres", "DATABASE_URL is not a valid URL");

if (redis) {
  const up = await reachable(redis.host, redis.port);
  line(up ? PASS() : FAIL(), "redis", `${redis.host}:${redis.port}${up ? "" : " — not reachable"}`);
  if (!up) note(dockerRunning ? "Run `npm run infra:up`" : "Start Docker Desktop, then `npm run infra:up`");
} else line(FAIL(), "redis", "REDIS_URL is not a valid URL");

// ── build + schema ──────────────────────────────────────────────────────────

heading("Build");
const unbuilt = APPS.filter((a) => !existsSync(join(ROOT, a.dir, "dist", "main.js")));
if (!existsSync(join(ROOT, "node_modules"))) {
  line(FAIL(), "dependencies", "node_modules missing");
  note("Run `npm run setup`");
} else line(PASS(), "dependencies", "installed");

if (unbuilt.length === 0) line(PASS(), "compiled output", "all apps have dist/main.js");
else {
  line(FAIL(), "compiled output", `not built: ${unbuilt.map((a) => a.id).join(", ")}`);
  note("Run `npm run build`");
}

if (pgUp) {
  const status = run(NPM, ["run", "-s", "migrate:status", "-w", "@sbr/db"], { quiet: true });
  const out = `${status.stdout}${status.stderr}`;
  if (status.code === 0 && /up to date|No pending migration/i.test(out)) {
    line(PASS(), "migrations", "database schema is up to date");
  } else if (/pending|not yet been applied/i.test(out)) {
    line(FAIL(), "migrations", "pending migrations");
    note("Run `npm run db:migrate`");
  } else {
    line(SKIP(), "migrations", "could not determine state");
  }
} else line(SKIP(), "migrations", "skipped — database unreachable");

// ── what will run ───────────────────────────────────────────────────────────

heading("Apps");
for (const app of APPS) {
  const missing = app.needs.filter((k) => !isConfigured(env.get(k)));
  if (missing.length === 0) line(PASS(), app.id, `will start — ${app.label}`);
  else line(SKIP(), app.id, `will be skipped — needs ${missing.join(", ")}`);
}

// ── client ingest ───────────────────────────────────────────────────────────

heading("Client ingest (ctjs)");
{
  const moduleDir = join(ROOT, "ctjs-module", "sbr-dungeon-tracker");
  if (existsSync(join(moduleDir, "metadata.json"))) {
    line(PASS(), "ctjs module", "ctjs-module/sbr-dungeon-tracker");
  } else {
    line(FAIL(), "ctjs module", "ctjs-module/sbr-dungeon-tracker is missing");
    note("The ChatTriggers module is missing. `npm run ctjs:dev` has nothing to install.");
  }

  const scheme = env.get("WEB_PANEL_SCHEME") ?? "https";
  const port = Number(env.get("WEB_PANEL_PORT")) || 3000;

  if (scheme !== "http") {
    // The probe speaks plaintext. Over TLS a failure here would mean nothing, so
    // it says that rather than reporting a red mark it cannot justify.
    line(SKIP(), "/ws/ingest", `not probed — WEB_PANEL_SCHEME is ${scheme}`);
  } else {
    const result = await ingestUpgrade("127.0.0.1", port);
    if (result === "ok") {
      line(PASS(), "/ws/ingest", `upgrade accepted on 127.0.0.1:${port}`);
    } else if (result === "missing") {
      line(FAIL(), "/ws/ingest", "the panel answered, but did not upgrade");
      note("The web panel is listening but /ws/ingest refused a WebSocket upgrade — rebuild it with `npm run build`.");
    } else {
      line(SKIP(), "/ws/ingest", `nothing listening on 127.0.0.1:${port} — start the panel first`);
    }
  }
}


// ── verdict ─────────────────────────────────────────────────────────────────

if (problems.size === 0) {
  say(`\n${c.green(c.bold("Everything checks out."))} ${c.gray("Run `npm start`.")}\n`);
} else {
  say(`\n${c.bold(c.yellow(`${problems.size} thing(s) to fix:`))}`);
  for (const p of problems) say(`  ${c.gray("→")} ${p}`);
  say("");
  process.exit(1);
}
