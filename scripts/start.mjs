/**
 * `npm start` / `npm run dev` — run the platform's apps in one terminal.
 *
 * Replaces four separate `npm run start -w @sbr/app-…` shells. Interleaves the
 * apps' logs behind colour-coded prefixes, auto-starts Docker infra if it isn't
 * already up, skips apps whose credentials are absent, and shuts everything down
 * cleanly on Ctrl+C.
 *
 * Usage:
 *   node scripts/start.mjs [app …]   # default: every configured app
 *   node scripts/start.mjs --watch   # rebuild + restart on source changes
 */
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import {
  APPS, NPM, ROOT, appById, c, die, has, info, isConfigured, ok, readEnv,
  run, say, spawn, step, warn,
} from "./lib.mjs";

const argv = process.argv.slice(2);
const watch = argv.includes("--watch");
const selection = argv.filter((a) => !a.startsWith("--"));

// ── selection ───────────────────────────────────────────────────────────────

function resolveApps() {
  if (selection.length === 0) return APPS;
  const chosen = [];
  for (const id of selection) {
    const app = appById(id);
    if (!app) die(`Unknown app "${id}".`, [`Valid apps: ${APPS.map((a) => a.id).join(", ")}`]);
    chosen.push(app);
  }
  return chosen;
}

// ── preflight ───────────────────────────────────────────────────────────────

/** Resolve a `host:port` from a connection URL, tolerating malformed input. */
function endpoint(url, fallbackPort) {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: Number(u.port) || fallbackPort };
  } catch {
    return null;
  }
}

/** TCP reachability probe — cheaper and more honest than parsing container state. */
function reachable({ host, port }, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Every app needs Postgres and Redis. If they aren't listening, try to bring the
 * compose stack up rather than making the user remember a separate command.
 */
async function ensureInfra(env) {
  const pg = endpoint(env.get("DATABASE_URL"), 5432);
  const redis = endpoint(env.get("REDIS_URL"), 6379);
  if (!pg || !redis) {
    die("DATABASE_URL and REDIS_URL must be valid URLs in .env.", ["Run `npm run setup` to scaffold them."]);
  }

  const [pgUp, redisUp] = await Promise.all([reachable(pg), reachable(redis)]);
  if (pgUp && redisUp) {
    ok(`postgres ${c.gray(`${pg.host}:${pg.port}`)} and redis ${c.gray(`${redis.host}:${redis.port}`)} reachable`);
    return;
  }

  const down = [!pgUp && "postgres", !redisUp && "redis"].filter(Boolean).join(" + ");
  warn(`${down} not reachable — starting the Docker stack`);

  if (!has("docker") || run("docker", ["info"], { quiet: true }).code !== 0) {
    die(`Cannot reach ${down} and Docker is not available to start it.`, [
      "Start Docker Desktop, then re-run this command,",
      "or point DATABASE_URL / REDIS_URL at datastores you host elsewhere.",
    ]);
  }
  if (run("docker", ["compose", "up", "-d", "--wait"]).code !== 0) {
    die("`docker compose up -d --wait` failed — see the output above.", [
      "Ports 5432/6379 may already be in use by another Postgres/Redis.",
    ]);
  }
  ok("postgres and redis are healthy");
}

/** The apps run compiled JS; build once if `dist/` is missing or we're watching. */
function ensureBuild(apps) {
  const unbuilt = apps.filter((a) => !existsSync(join(ROOT, a.dir, "dist", "main.js")));
  if (unbuilt.length === 0 && !watch) return;

  step(unbuilt.length > 0 ? "Building (first run)" : "Building");
  if (run(NPM, ["run", "build"]).code !== 0) {
    die("Build failed — see the TypeScript errors above.");
  }
  ok("build complete");
}

// ── child process supervision ───────────────────────────────────────────────

const children = new Map();
/** Just the app ids — `children` also holds the tsc compiler in --watch mode. */
const apps = new Set();
let shuttingDown = false;

/** Prefix every line of a stream with the app's colour-coded name. */
function pipePrefixed(stream, out, prefix) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? ""; // keep the trailing partial line
    for (const line of lines) out.write(`${prefix} ${line}\n`);
  });
  stream.on("end", () => {
    if (buffer) out.write(`${prefix} ${buffer}\n`);
  });
}

function launch(app) {
  const prefix = app.color(app.id.padEnd(11) + "│");
  // Spawn node directly rather than `npm run start -w …`: no shim process in the
  // middle, so Ctrl+C and exit codes reach the app itself.
  const nodeArgs = watch ? ["--watch", "dist/main.js"] : ["dist/main.js"];
  const child = spawn(process.execPath, nodeArgs, {
    cwd: join(ROOT, app.dir),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: process.stdout.isTTY ? "1" : "0" },
  });

  pipePrefixed(child.stdout, process.stdout, prefix);
  pipePrefixed(child.stderr, process.stderr, prefix);

  child.on("exit", (code, signal) => {
    children.delete(app.id);
    apps.delete(app.id);
    if (shuttingDown) return;
    if (code === 0) say(`${prefix} ${c.gray("exited cleanly")}`);
    else say(`${prefix} ${c.red(`exited with code ${code ?? signal}`)}`);
    // Count apps, not children: in --watch the tsc compiler is also a child and
    // never exits, so `children.size` never reaches zero. Keyed off it, a run
    // where every app crashed would sit here forever with only a compiler alive.
    if (apps.size === 0) {
      say(`\n${c.gray("All apps have stopped.")}`);
      process.exit(code === 0 ? 0 : 1);
    }
  });

  children.set(app.id, child);
  apps.add(app.id);
  return child;
}

/** Background `tsc -b --watch` so `node --watch` sees fresh output on save. */
function startCompiler() {
  const prefix = c.gray("tsc".padEnd(11) + "│");
  const tsc = spawn(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-b", "--watch", "--preserveWatchOutput"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  pipePrefixed(tsc.stdout, process.stdout, prefix);
  pipePrefixed(tsc.stderr, process.stderr, prefix);
  children.set("tsc", tsc);
}

/**
 * Apps get this long to close their own connections before we force them.
 * The bridge bot needs the most: it has to send a Minecraft disconnect and wait
 * for Hypixel to close the socket, or the account is left logged in as a ghost.
 */
const GRACE_MS = 15_000;

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  say(`\n${c.gray("Stopping — letting apps close their connections…")}`);

  // Do NOT kill children here on Windows. The console has already delivered
  // Ctrl+C to every process in this group, so they are mid-cleanup; kill() maps
  // to TerminateProcess, which would cut that off (the exact reason the bridge
  // bot stayed logged in). There is no way to raise SIGINT programmatically on
  // Windows, so we simply wait. On POSIX a programmatic SIGTERM needs forwarding.
  if (process.platform !== "win32") {
    for (const child of children.values()) child.kill("SIGTERM");
  }

  const deadline = Date.now() + GRACE_MS;
  const poll = setInterval(() => {
    if (children.size === 0) {
      clearInterval(poll);
      say(c.gray("Stopped."));
      process.exit(exitCode);
    }
    if (Date.now() >= deadline) {
      clearInterval(poll);
      warn(`forcing ${[...children.keys()].join(", ")} after ${GRACE_MS / 1000}s`);
      for (const child of children.values()) child.kill("SIGKILL");
      setTimeout(() => process.exit(1), 500).unref();
    }
  }, 100);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  say(c.bold(`\nSBR Guild Platform — ${watch ? "dev (watch)" : "start"}`));

  if (!existsSync(join(ROOT, ".env"))) {
    die("No .env found.", ["Run `npm run setup` first — it scaffolds .env and the rest of the stack."]);
  }
  const env = readEnv();
  const requested = resolveApps(); // validate arguments before doing slow work

  step("Checking infrastructure");
  await ensureInfra(env);

  const runnable = [];
  step("Selecting apps");
  for (const app of requested) {
    const missing = app.needs.filter((k) => !isConfigured(env.get(k)));
    if (missing.length === 0) {
      runnable.push(app);
      ok(`${app.color(app.id.padEnd(11))} ${c.gray(app.label)}`);
    } else if (selection.includes(app.id)) {
      // Explicitly asked for — refusing quietly would look like a hang.
      die(`${app.id} needs ${missing.join(", ")} set in .env.`);
    } else {
      info(`${app.id.padEnd(11)} skipped — set ${missing.join(", ")} in .env to enable`);
    }
  }

  if (runnable.length === 0) {
    die("Nothing to run — every app is missing its credentials.", [
      "Add DISCORD_ADMIN_TOKEN / DISCORD_BRIDGE_TOKEN to .env, or run `npm run doctor`.",
    ]);
  }

  ensureBuild(runnable);

  step(`Running ${runnable.length} app${runnable.length === 1 ? "" : "s"} — Ctrl+C to stop all`);
  if (watch) startCompiler();
  for (const app of runnable) launch(app);

  // Wrapped, not passed by reference: Node hands the signal name to the
  // listener, which would arrive as `shutdown`'s exit code.
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  // Last-resort reaper for any exit path that bypasses `shutdown` — a stray
  // `process.exit`, or a throw from a listener. Windows does not kill children
  // when the parent goes, so without this they would linger holding port 3000.
  // Note this cannot help against an external force-kill (taskkill /f, SIGKILL):
  // no exit handler runs then, and the apps really are orphaned.
  process.on("exit", () => {
    for (const child of children.values()) child.kill("SIGKILL");
  });
  // A crashed supervisor must not report success: `npm start` is what an
  // orchestrator or CI job waits on, and exit 0 here would read as "the apps
  // ran and finished normally" when in fact nothing was ever supervised.
  process.on("uncaughtException", (error) => {
    say(c.red(`\nsupervisor error: ${error.stack ?? error.message}`));
    shutdown(1);
  });
  process.on("unhandledRejection", (reason) => {
    say(c.red(`\nsupervisor unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`));
    shutdown(1);
  });
}

main().catch((error) => die(error instanceof Error ? (error.stack ?? error.message) : String(error)));
