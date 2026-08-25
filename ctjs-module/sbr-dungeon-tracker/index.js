/**
 * sbrDungeonTracker — Phase 1 exploration harness.
 *
 * What this module does: watches the local Minecraft client for the things a
 * dungeon run announces (chat, action bar, scoreboard, tab list, world events),
 * writes them to a JSON-lines file in this folder, and — only if you turn
 * streaming on — forwards them to an ingest server you configure.
 *
 * What it does not do, by design:
 *
 * - It never calls the Hypixel API. Every signal here is one the client already
 *   has locally. This module has no key and makes no HTTP request to Hypixel.
 * - It never plays the game for you. There is no command sent, no click, no
 *   warp, no movement. It reads and it writes a log.
 * - It never sees another player. Everything captured is the local client's own
 *   view; nothing is requested about anyone else.
 * - It captures nothing until you ask it to. `captureOnLoad` is false and
 *   `streaming` is false out of the box, so a fresh install is inert until
 *   somebody runs `/sbrtrack start`.
 *
 * Phase 1 is about finding out which triggers actually fire for which state
 * change. The output is a raw log to read, not a schema. See
 * `docs/EVENT_FINDINGS.md` and `CAPTURE_CHECKLIST.md`.
 */
import Safe from "./safe.js";
import Settings from "./settings.js";
import Capture from "./capture.js";
import Triggers from "./triggers.js";
import Skyblock from "./skyblock.js";
import Socket from "./socket.js";

const MODULE_VERSION = "0.1.0";
const PREFIX = "&8[&bSBR&8] &r";

const settings = Settings.load();
const config = settings.values;

/** Toggleable at runtime with `/sbrtrack stream on|off`; config.json is the default. */
let streaming = config.streaming === true;

const socket = Socket.createSocket({
  url: config.ingestUrl,
  moduleVersion: MODULE_VERSION,
  onLog(message, fields) {
    // Socket notes are worth a line in the capture even when nobody is looking
    // at chat, since "why did nothing arrive" is answered here.
    Capture.record("socket." + message.replace(/\s+/g, "_"), fields);
    if (config.debugChat) say("&7socket: " + message);
  },
});

function say(text) {
  try {
    ChatLib.chat(PREFIX + text);
  } catch (e) {
    /* chat unavailable; nothing useful to do */
  }
}

// ───────────────────────── capture → socket wiring ─────────────────────────

// Every captured record is offered to the socket. `offer` is non-blocking and
// queues when the socket is down, so this costs nothing when streaming is off
// beyond a push onto a bounded array.
Capture.onRecord(function (entry) {
  if (!streaming) return;
  socket.offer(entry);
  if (config.debugChat) say("&8" + entry.ev);
});

// ─────────────────────────────── the gate ───────────────────────────────

/**
 * Whether the socket is allowed to be open right now.
 *
 * The spec calls for connecting on world load and closing on world unload. This
 * evaluates the same condition on every pump instead, which is strictly safer:
 * the scoreboard is often not populated at the instant `worldLoad` fires, so a
 * one-shot check there would read "not SkyBlock" and never retry. Re-checking
 * means the socket opens as soon as the client can prove where it is, and
 * closes within a second of that stopping being true — including on a lobby
 * warp, which never fires a world unload at all.
 */
function shouldBeConnected() {
  if (!streaming) return false;
  if (!Capture.status().active) return false;
  return Skyblock.onSkyblock();
}

let lastGate = false;

function pump() {
  const open = shouldBeConnected();
  if (open !== lastGate) {
    lastGate = open;
    if (open) {
      Capture.record("socket.gate", { open: true, detected: Skyblock.describe() });
      socket.start(config.ingestUrl);
    } else {
      Capture.record("socket.gate", { open: false });
      socket.stop("left skyblock");
    }
  }
  if (open) socket.pump();
}

// ───────────────────────────── registration ─────────────────────────────

/**
 * The harness registers once, on first `/sbrtrack start`, and stays registered
 * for the session. ChatTriggers has no unregister-everything call worth relying
 * on, so `stop` closes the capture rather than tearing the triggers down —
 * `Capture.record` is a no-op while no session is active, which makes a stopped
 * tracker genuinely quiet rather than merely silent.
 */
let harnessReport = null;

function ensureHarness() {
  if (harnessReport !== null) return harnessReport;
  harnessReport = Triggers.registerAll(config);
  return harnessReport;
}

// The transport tick. Separate from the capture poller in triggers.js because
// it has to keep running to reconnect even when nothing is being captured.
try {
  const t = register("step", pump);
  try {
    t.setFps(5);
  } catch (e) {
    try {
      t.setDelay(1);
    } catch (e2) {
      /* default cadence */
    }
  }
} catch (e) {
  say("&cCould not register the transport tick: " + Safe.describeError(e));
}

// Closing promptly on world unload is still worth doing on its own: it gets a
// clean close frame out before the connection drops, so the server sees a
// departure rather than a timeout.
try {
  register("worldUnload", function () {
    if (lastGate) {
      lastGate = false;
      socket.stop("world unload");
    }
  });
} catch (e) {
  /* the pump gate covers this case anyway */
}

// ────────────────────────────── the command ──────────────────────────────

function reportStatus() {
  const cap = Capture.status();
  say("&bsbrDungeonTracker &7v" + MODULE_VERSION);
  say("&7settings from: &f" + settings.source);
  say("&7capture: " + (cap.active ? "&aactive &7(" + cap.label + ")" : "&8stopped"));
  if (cap.file !== null) say("&7file: &f" + cap.file);
  say("&7records: &f" + cap.captured + " &7buffered &f" + cap.buffered + " &7dropped &f" + cap.dropped);
  if (cap.writeError !== null) say("&cwrite error: " + cap.writeError);

  const detected = Skyblock.describe();
  say("&7server: &f" + detected.server + " &7skyblock: &f" + detected.onSkyblock);

  if (!streaming) {
    say("&7streaming: &8off &7(url " + config.ingestUrl + ")");
  } else {
    const s = socket.status();
    say("&7streaming: &a" + s.phase + " &7-> &f" + s.url);
    say("&7sent &f" + s.sent + " &7in &f" + s.frames + " &7frames, queued &f" + s.queued + " &7dropped &f" + s.dropped);
    if (s.lastError !== null) say("&clast error: " + s.lastError);
    if (s.closeCode !== null) say("&7closed with &f" + s.closeCode + " &7" + s.closeReason);
  }

  if (harnessReport !== null && harnessReport.unavailable.length > 0) {
    say("&eunavailable triggers: &f" + harnessReport.unavailable.map((u) => u.name).join(", "));
  }
}

function dump() {
  // A dump is a capture record, not a chat wall: the point is to get the
  // current scoreboard and tab list into the fixture at a moment the person
  // playing can describe, so "this is what F7 phase 3 looked like" has an
  // anchor. The chat output is just an acknowledgement.
  const snap = Triggers.snapshot();
  const detected = Skyblock.describe();
  Capture.record("manual.dump", { detected: detected, snapshot: snap });
  Capture.flush();

  say("&7--- scoreboard ---");
  say("&f" + snap.scoreboard.title);
  for (let i = 0; i < snap.scoreboard.lines.length; i += 1) {
    say("&8" + i + " &r" + snap.scoreboard.lines[i].text);
  }
  const tab = snap.tablist;
  say("&7tab list: &f" + (tab === null ? "unavailable" : tab.length + " entries") + " &7(written to the log)");
  if (!Capture.status().active) say("&eNothing was logged - no capture session is running.");
}

function usage() {
  say("&7/sbrtrack start [label] &8- begin a capture session");
  say("&7/sbrtrack stop &8- end it and flush to disk");
  say("&7/sbrtrack dump &8- snapshot scoreboard + tab list into the log");
  say("&7/sbrtrack status &8- what is running, and where it is streaming");
  say("&7/sbrtrack stream on|off &8- toggle forwarding for this session");
}

try {
  register("command", function (action) {
    const rest = Array.prototype.slice.call(arguments, 1);
    switch (String(action === undefined ? "" : action).toLowerCase()) {
      case "start": {
        ensureHarness();
        const label = rest.length > 0 ? rest.join(" ") : "session";
        const file = Capture.start(label);
        Capture.record("harness.available", harnessReport);
        say("&aCapturing &7to &f" + file);
        if (streaming) say("&7Streaming will connect once SkyBlock is detected.");
        break;
      }
      case "stop": {
        const file = Capture.stop();
        socket.stop("capture stopped");
        lastGate = false;
        say(file === null ? "&7Nothing was running." : "&aStopped. &7Wrote &f" + file);
        break;
      }
      case "dump":
        dump();
        break;
      case "status":
        reportStatus();
        break;
      case "stream": {
        const arg = String(rest[0] === undefined ? "" : rest[0]).toLowerCase();
        if (arg === "on") streaming = true;
        else if (arg === "off") streaming = false;
        else {
          say("&7Usage: /sbrtrack stream on|off");
          break;
        }
        say("&7Streaming is now &f" + (streaming ? "on" : "off") + "&7. Edit config.json to make it stick.");
        break;
      }
      default:
        usage();
    }
  }).setName("sbrtrack");
} catch (e) {
  say("&cCould not register /sbrtrack: " + Safe.describeError(e));
}

if (config.captureOnLoad === true) {
  ensureHarness();
  Capture.start("autostart");
}

say("&7loaded &bv" + MODULE_VERSION + "&7. Run &f/sbrtrack&7 for commands.");

export default { MODULE_VERSION };
