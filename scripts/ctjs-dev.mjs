/**
 * Install the ChatTriggers module into a local Minecraft instance.
 *
 * ChatTriggers loads modules from a fixed directory inside `.minecraft`, so
 * developing one means getting the source there. On Linux and macOS that is a
 * symlink and the edit loop is `/ct reload`. On Windows a symlink needs
 * Developer Mode or an elevated shell, so this copies instead and you re-run the
 * script after editing — slower, but it works without asking anyone to change
 * their machine's security settings for a dev loop.
 *
 * The destination is read from `CTJS_MODULES_DIR` because there is no path that
 * is right for everyone: MultiMC, Prism, the vanilla launcher and a Modrinth
 * instance all put `.minecraft` somewhere different. The default below is the
 * vanilla launcher's, which is the only one worth guessing.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { ROOT, c, readEnv, say } from "./lib.mjs";

const MODULE_DIR = join(ROOT, "ctjs-module", "sbr-dungeon-tracker");
const MODULE_NAME = "sbr-dungeon-tracker";

/** The vanilla launcher's ChatTriggers directory, per platform. */
function defaultModulesDir() {
  const home = homedir();
  if (platform() === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), ".minecraft", "config", "ChatTriggers", "modules");
  if (platform() === "darwin") return join(home, "Library", "Application Support", "minecraft", "config", "ChatTriggers", "modules");
  return join(home, ".minecraft", "config", "ChatTriggers", "modules");
}

const env = readEnv();
const configured = env.get("CTJS_MODULES_DIR");
const modulesDir = configured ? resolve(configured) : defaultModulesDir();
const target = join(modulesDir, MODULE_NAME);
const mode = process.argv.includes("--copy") ? "copy" : platform() === "win32" ? "copy" : "link";

say(c.bold("\nSBR dungeon tracker — install to Minecraft"));
say(`  source  ${MODULE_DIR}`);
say(`  target  ${target}`);
say(`  source of path: ${configured ? ".env CTJS_MODULES_DIR" : "platform default"}`);

if (!existsSync(MODULE_DIR)) {
  say(c.red(`\n  The module is missing at ${MODULE_DIR}.`));
  process.exit(1);
}

if (!existsSync(modulesDir)) {
  // Refuse rather than create it. An absent modules directory almost always
  // means the path is wrong or ChatTriggers has never been run — and silently
  // creating a plausible-looking directory would hide both.
  say(c.red(`\n  ${modulesDir} does not exist.`));
  say("  Either ChatTriggers has not run once yet, or this is not your instance.");
  say("  Launch Minecraft with ChatTriggers installed, or set CTJS_MODULES_DIR in .env.");
  process.exit(1);
}

// Whatever is there now is either our own previous install or something we were
// not asked to touch. Only the first is safe to remove.
if (existsSync(target) || isLink(target)) {
  if (!isOurs(target)) {
    say(c.red(`\n  ${target} exists and does not look like this module.`));
    say("  Move it aside yourself — this script will not delete something it did not put there.");
    process.exit(1);
  }
  rmSync(target, { recursive: true, force: true });
}

if (mode === "link") {
  mkdirSync(modulesDir, { recursive: true });
  symlinkSync(MODULE_DIR, target, "dir");
  say(c.green("\n  linked."));
  say("  Edits to the repo are live. Run `/ct reload` in game to pick them up.");
} else {
  cpSync(MODULE_DIR, target, {
    recursive: true,
    // The player's own captures and their config live in the installed copy.
    // Overwriting either would throw away exactly the thing we asked them to
    // collect, so a re-install refreshes code and leaves those alone.
    filter: (src) => {
      const rel = src.slice(MODULE_DIR.length).replace(/\\/g, "/").replace(/^\//, "");
      if (rel === "") return true;
      return !(rel === "logs" || rel.startsWith("logs/") || rel === "config.json");
    },
  });
  say(c.green("\n  copied."));
  say("  This is a copy: re-run `npm run ctjs:dev` after editing, then `/ct reload` in game.");
  say("  Your config.json, logs/ and fixtures/ in the installed copy were left untouched.");
}

say("\n  Next:");
say("    1. In the installed copy, set `ingestUrl` in config.json to your panel:");
say(`       ws://127.0.0.1:${env.get("WEB_PANEL_PORT") ?? 3000}/ws/ingest`);
say("    2. Start the web panel, then `/sbrtrack start` and `/sbrtrack stream on` in game.");
say("    3. Watch GET /debug/ingest/:memberId on the panel. See docs/CLIENT_INGEST.md.\n");

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True when `path` is a link we made, or a directory carrying our metadata. */
function isOurs(path) {
  if (isLink(path)) {
    try {
      return resolve(readlinkSync(path)) === resolve(MODULE_DIR);
    } catch {
      return false;
    }
  }
  return existsSync(join(path, "metadata.json")) && existsSync(join(path, "index.js"));
}
