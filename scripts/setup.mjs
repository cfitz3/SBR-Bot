/**
 * `npm run setup` — one command that takes a fresh clone to a runnable state.
 *
 * Replaces the former six-step manual quickstart (copy .env, docker compose up,
 * install, build, migrate, test). Every step is idempotent, so re-running after
 * a `git pull` is the normal way to resync.
 *
 * Flags: --skip-infra (no Docker), --skip-build, --skip-migrate.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  APPS, NPM, ROOT, c, die, has, info, isConfigured, ok, readEnv,
  run, runOrDie, say, scaffoldEnv, step, warn,
} from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const skip = (name) => args.has(`--skip-${name}`);

const ENV_PATH = join(ROOT, ".env");
const ENV_EXAMPLE = join(ROOT, ".env.example");

// ── 1. toolchain preflight ──────────────────────────────────────────────────

function preflight() {
  step("Checking your toolchain");

  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    die(`Node ${process.versions.node} is too old — this project needs Node 20 or newer.`, [
      "Install the current LTS from https://nodejs.org",
    ]);
  }
  ok(`Node ${process.versions.node}`);

  if (!has(NPM)) die("npm was not found on your PATH.", ["It ships with Node — reinstall Node."]);
  ok("npm");
}

// ── 2. environment file ─────────────────────────────────────────────────────

function ensureEnvFile() {
  step("Preparing your .env");

  let result;
  try {
    result = scaffoldEnv(ENV_PATH, ENV_EXAMPLE);
  } catch (error) {
    die(error.message);
  }

  if (result.created) ok("created .env from .env.example");
  if (result.generatedSecret) ok("generated a random SESSION_SECRET");
  if (result.addedKeys.length > 0) {
    ok(`added ${result.addedKeys.length} new key(s) from .env.example: ${result.addedKeys.join(", ")}`);
  }
  if (!result.created && !result.generatedSecret && result.addedKeys.length === 0) {
    ok(".env is present and up to date");
  }
  return result.created;
}

// ── 3. dependencies ─────────────────────────────────────────────────────────

function installDeps() {
  step("Installing dependencies");
  if (existsSync(join(ROOT, "node_modules", ".package-lock.json"))) {
    info("node_modules present — running `npm install` to reconcile any drift");
  }
  runOrDie(NPM, ["install"], {
    message: "`npm install` failed.",
    hints: ["Check your network/proxy, then re-run `npm run setup`."],
  });
  ok("dependencies installed");
}

// ── 4. infrastructure (Postgres + Redis) ────────────────────────────────────

/** True when the Docker CLI exists *and* the daemon is actually reachable. */
function dockerReady() {
  if (!has("docker")) return { ok: false, why: "the `docker` command was not found" };
  if (run("docker", ["info"], { quiet: true }).code !== 0) {
    return { ok: false, why: "the Docker daemon is not running" };
  }
  return { ok: true };
}

function startInfra() {
  step("Starting Postgres + Redis");

  const docker = dockerReady();
  if (!docker.ok) {
    warn(`Skipping containers — ${docker.why}.`);
    info("Start Docker Desktop and re-run `npm run setup`, or point DATABASE_URL/REDIS_URL");
    info("at datastores you host elsewhere.");
    return false;
  }

  // `--wait` blocks until the compose healthchecks pass, so the migration below
  // never races an unready Postgres (the classic step-3 failure in the old flow).
  const { code } = run("docker", ["compose", "up", "-d", "--wait"]);
  if (code !== 0) {
    warn("`docker compose up -d --wait` failed — see the output above.");
    info("Common cause: ports 5432/6379 are already in use by another Postgres/Redis.");
    return false;
  }
  ok("postgres (:5432) and redis (:6379) are healthy");
  return true;
}

// ── 5. build + migrate ──────────────────────────────────────────────────────

function build() {
  step("Building the workspace");
  runOrDie(NPM, ["run", "build"], {
    message: "The build failed.",
    hints: ["Fix the TypeScript errors above, then re-run `npm run setup`."],
  });
  ok("prisma client generated and TypeScript compiled");
}

function migrate(infraUp) {
  step("Applying database migrations");
  if (!infraUp) {
    warn("Skipped — no reachable database. Run `npm run db:migrate` once one is up.");
    return false;
  }
  const { code } = run(NPM, ["run", "migrate:deploy", "-w", "@sbr/db"]);
  if (code !== 0) {
    warn("Migrations failed — check DATABASE_URL in .env against the running Postgres.");
    return false;
  }
  ok("schema applied");
  return true;
}

// ── 6. closing report ───────────────────────────────────────────────────────

/**
 * Tell the user exactly what will and won't start, and which env var unlocks
 * each thing that won't — the question the old README left them to work out.
 */
function report(freshEnv) {
  const env = readEnv();
  step("Ready");

  for (const app of APPS) {
    const missing = app.needs.filter((k) => !isConfigured(env.get(k)));
    if (missing.length === 0) ok(`${app.color(app.id.padEnd(11))} ${c.gray(app.label)}`);
    else info(`${app.id.padEnd(11)} ${c.gray(`will be skipped — set ${missing.join(", ")} in .env`)}`);
  }

  const optional = [
    ["HYPIXEL_API_KEY", "live Hypixel stats, pricing and networth"],
    ["DISCORD_OAUTH_CLIENT_ID", "web panel login"],
  ].filter(([k]) => !isConfigured(env.get(k)));

  if (optional.length > 0) {
    say(`\n  ${c.gray("Optional, for full functionality:")}`);
    for (const [k, why] of optional) info(`  ${k.padEnd(24)} → ${why}`);
  }

  say(`\n  ${c.bold("Next:")} ${c.cyan("npm start")}       ${c.gray("run everything that is configured")}`);
  say(`        ${c.cyan("npm run dev")}     ${c.gray("same, with rebuild-on-save")}`);
  say(`        ${c.cyan("npm run doctor")}  ${c.gray("check config + infra health any time")}`);
  if (freshEnv) say(`\n  ${c.yellow("Edit .env")} ${c.gray("to add your Discord/Hypixel credentials first.")}`);
  say("");
}

// ── main ────────────────────────────────────────────────────────────────────

say(c.bold("\nSBR Guild Platform — setup"));
preflight();
const freshEnv = ensureEnvFile();
installDeps();
const infraUp = skip("infra") ? (warn("\nSkipping infra (--skip-infra)"), false) : startInfra();
if (!skip("build")) build();
if (!skip("migrate")) migrate(infraUp);
report(freshEnv);
