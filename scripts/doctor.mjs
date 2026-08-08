/**
 * `npm run doctor` — answers "why won't it start?" without reading any source.
 *
 * Read-only: it inspects the toolchain, .env, datastore reachability, build
 * output and migration state, then prints the exact command to fix whatever is
 * wrong. Exits non-zero if anything blocking is broken, so CI can use it too.
 */
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import {
  APPS, NPM, ROOT, c, has, isConfigured, readEnv, run, say,
} from "./lib.mjs";

const problems = [];
const note = (msg) => problems.push(msg);

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

function endpoint(url, fallbackPort) {
  try {
    const u = new URL(url ?? "");
    return { host: u.hostname, port: Number(u.port) || fallbackPort };
  } catch {
    return null;
  }
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

// ── verdict ─────────────────────────────────────────────────────────────────

if (problems.length === 0) {
  say(`\n${c.green(c.bold("Everything checks out."))} ${c.gray("Run `npm start`.")}\n`);
} else {
  say(`\n${c.bold(c.yellow(`${problems.length} thing(s) to fix:`))}`);
  for (const p of problems) say(`  ${c.gray("→")} ${p}`);
  say("");
  process.exit(1);
}
