/**
 * Shared helpers for the SBR launcher scripts (setup / start / doctor).
 *
 * Zero runtime dependencies and cross-platform (Windows/macOS/Linux) by design:
 * these run *before* `npm install` has necessarily happened, so they may only use
 * the Node standard library.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ── output ──────────────────────────────────────────────────────────────────

const useColor = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;
const ESC = String.fromCharCode(27);
const paint = (code) => (s) => (useColor ? `${ESC}[${code}m${s}${ESC}[0m` : String(s));

export const c = {
  bold: paint("1"),
  dim: paint("2"),
  red: paint("31"),
  green: paint("32"),
  yellow: paint("33"),
  blue: paint("34"),
  magenta: paint("35"),
  cyan: paint("36"),
  gray: paint("90"),
};

export const say = (msg = "") => process.stdout.write(`${msg}\n`);
export const step = (msg) => say(`\n${c.bold(c.blue("▸"))} ${c.bold(msg)}`);
export const ok = (msg) => say(`  ${c.green("✓")} ${msg}`);
export const warn = (msg) => say(`  ${c.yellow("!")} ${msg}`);
export const fail = (msg) => say(`  ${c.red("✗")} ${msg}`);
export const info = (msg) => say(`  ${c.gray(msg)}`);

/** Print a fatal error with optional remediation hints, then exit non-zero. */
export function die(msg, hints = []) {
  say(`\n${c.red(c.bold("✗ " + msg))}`);
  for (const h of hints) say(`  ${c.gray("→")} ${h}`);
  say("");
  process.exit(1);
}

// ── process execution ───────────────────────────────────────────────────────

/** `npm` is a plain binary on POSIX and a `.cmd` shim on Windows. */
export const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * Since Node 18.20/20.12, spawning a Windows `.cmd`/`.bat` file without a shell
 * fails with EINVAL — so those need `shell: true`. Everything else is spawned
 * without a shell, which keeps arguments free of quoting hazards.
 */
const needsShell = (cmd) => process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd);

/**
 * Passing an argv array alongside `shell: true` is deprecated (DEP0190) because
 * the parts are concatenated unescaped. Quote them ourselves and hand the shell
 * a single command string instead.
 *
 * Inside cmd.exe double quotes, `&` `|` `<` `>` `^` are already literal — the
 * caret is *not* an escape there, so prefixing them with one would pass the
 * caret through as part of the value. What genuinely needs handling is a quote
 * in the argument, which would otherwise end the quoted run and let the rest of
 * the value be parsed as command syntax.
 */
const quote = (a) => (/^[\w.:@/\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);

/** Run a command to completion, streaming its output. Returns the exit code. */
export function run(cmd, args, opts = {}) {
  const shell = needsShell(cmd);
  const [file, argv] = shell ? [[cmd, ...args].map(quote).join(" "), []] : [cmd, args];

  const res = spawnSync(file, argv, {
    cwd: ROOT,
    stdio: opts.quiet ? "pipe" : "inherit",
    encoding: "utf8",
    shell,
    ...opts,
  });
  if (res.error) {
    return { code: res.error.code === "ENOENT" ? 127 : 1, stdout: "", stderr: String(res.error.message) };
  }
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Run a command, failing the whole script (with hints) if it exits non-zero. */
export function runOrDie(cmd, args, { message, hints = [], ...opts } = {}) {
  const { code } = run(cmd, args, opts);
  if (code !== 0) die(message ?? `\`${cmd} ${args.join(" ")}\` failed (exit ${code}).`, hints);
}

/** True if `cmd` exists on PATH. */
export function has(cmd) {
  const probe = process.platform === "win32" ? ["where", [cmd]] : ["which", [cmd]];
  return run(probe[0], probe[1], { quiet: true }).code === 0;
}

export { spawn };

// ── .env handling ───────────────────────────────────────────────────────────

/**
 * Parse a dotenv file into a Map, preserving declaration order. Deliberately
 * minimal — it mirrors what `dotenv` accepts for the keys this repo uses.
 */
export function parseEnv(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip an inline comment, then surrounding quotes.
    if (!value.startsWith('"') && !value.startsWith("'")) value = value.split(/\s+#/)[0].trim();
    if (value.length > 1 && /^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
    out.set(key, value);
  }
  return out;
}

/** Read the repo's `.env` (merged over `.env.local`) as a Map. Empty if absent. */
export function readEnv() {
  const merged = new Map();
  for (const name of [".env", ".env.local"]) {
    const path = join(ROOT, name);
    if (existsSync(path)) for (const [k, v] of parseEnv(readFileSync(path, "utf8"))) merged.set(k, v);
  }
  return merged;
}

/**
 * True when a value is actually usable — the `.env.example` placeholders
 * (`your_hypixel_api_key_here`, `change_me_...`) must not count as configured,
 * or apps would start and then fail against the real service.
 */
export function isConfigured(value) {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  if (!v) return false;
  return !(v.startsWith("your_") || v.startsWith("change_me") || v.endsWith("_here"));
}

/**
 * Bring `.env` into line with `.env.example`, without ever touching a value the
 * user has already set:
 *   - create it from the template on first run,
 *   - replace a missing/placeholder SESSION_SECRET with a real random one,
 *   - append keys added to the template since this `.env` was created.
 *
 * Paths are parameters so this is testable against a scratch directory.
 */
export function scaffoldEnv(envPath = join(ROOT, ".env"), examplePath = join(ROOT, ".env.example")) {
  if (!existsSync(examplePath)) throw new Error(`.env.example not found at ${examplePath}`);

  const created = !existsSync(envPath);
  if (created) writeEnvFile(envPath, readFileSync(examplePath, "utf8"));

  let text = readFileSync(envPath, "utf8");
  let generatedSecret = false;
  const generated = [];

  /**
   * Fill in a secret the operator has no reason to choose themselves.
   *
   * Both of these are shared secrets with no external counterpart to match — a
   * session signing key and a loopback bearer token — so the only thing asking
   * a human for one achieves is a weak value, or (as happened with
   * INTERNAL_API_TOKEN) an empty one that quietly disables a whole feature.
   */
  const fill = (key) => {
    if (isConfigured(parseEnv(text).get(key))) return false;
    const value = randomBytes(32).toString("hex");
    const line = new RegExp(`^${key}=.*$`, "m");
    text = line.test(text)
      ? text.replace(line, `${key}=${value}`)
      : `${text.trimEnd()}\n${key}=${value}\n`;
    generated.push(key);
    return true;
  };

  generatedSecret = fill("SESSION_SECRET");
  fill("INTERNAL_API_TOKEN");

  const example = parseEnv(readFileSync(examplePath, "utf8"));
  const present = parseEnv(text);
  const addedKeys = [...example.keys()].filter((k) => !present.has(k));
  if (addedKeys.length > 0) {
    const block = addedKeys.map((k) => `${k}=${example.get(k)}`).join("\n");
    text = `${text.trimEnd()}\n\n# Added by \`npm run setup\` from .env.example\n${block}\n`;
  }

  if (created || generated.length > 0 || addedKeys.length > 0) writeEnvFile(envPath, text);
  return { created, generatedSecret, generated, addedKeys };
}

/**
 * Write `.env` the way a file holding live credentials deserves.
 *
 * Two properties, neither of which a plain `writeFileSync` gives you:
 *
 *   - **Atomic.** The target is the user's hand-edited secrets file, and the
 *     values in it (a Minecraft account, an API key, bot tokens) are not
 *     recoverable from anywhere else in the repo. Truncating it and then dying
 *     mid-write would destroy them, so the new contents are staged next to it
 *     and moved into place in one step. A crash leaves either the old file or
 *     the new one, never a half of each.
 *   - **Owner-only.** `.env.example` is a committed file with ordinary 0644
 *     permissions, so copying it produced a world-readable secrets file on any
 *     multi-user POSIX host. chmod is a no-op on Windows, which is why it is
 *     applied unconditionally rather than behind a platform check.
 */
export function writeEnvFile(envPath, text) {
  const tmp = `${envPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, envPath);
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // Best effort: the write already failed, and reporting the cleanup
      // failure instead of the original cause would bury the useful error.
    }
    throw error;
  }
  // rename preserves the *temp* file's mode, but an existing .env may predate
  // this function; re-assert so an old world-readable file is tightened too.
  try {
    chmodSync(envPath, 0o600);
  } catch {
    // Some filesystems (a mounted share, WSL interop) reject chmod outright.
    // The file is written either way; permissions are a hardening bonus here.
  }
}

// ── app registry ────────────────────────────────────────────────────────────

/**
 * The four runnable apps. `needs` lists the env vars without which the app has
 * nothing to do — the launcher skips those rather than starting a process that
 * would immediately log-and-exit.
 */
export const APPS = [
  {
    id: "workers",
    dir: "apps/workers",
    color: c.magenta,
    label: "BullMQ scheduled jobs",
    needs: [],
  },
  {
    id: "web-panel",
    dir: "apps/web-panel",
    color: c.cyan,
    label: "Discord-OAuth HTTP API",
    needs: [],
  },
  {
    id: "admin-bot",
    dir: "apps/admin-bot",
    color: c.yellow,
    label: "staff moderation bot",
    needs: ["DISCORD_ADMIN_TOKEN"],
  },
  {
    id: "bridge-bot",
    dir: "apps/bridge-bot",
    color: c.green,
    label: "member bridge bot",
    needs: ["DISCORD_BRIDGE_TOKEN"],
  },
  {
    id: "guide-bot",
    dir: "apps/guide-bot",
    color: c.blue,
    label: "progression advisor",
    needs: ["DISCORD_GUIDE_TOKEN"],
  },
];

export const appById = (id) => APPS.find((a) => a.id === id);
