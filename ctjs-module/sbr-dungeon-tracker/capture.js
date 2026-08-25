/**
 * The capture log: buffered JSON-lines written to the module's own folder.
 *
 * Phase 1 captures everything and filters nothing, so the two things that
 * matter here are that writing never costs a frame and that a crash never
 * costs the session. Records are appended to an in-memory buffer and flushed
 * on a timer, on session stop, and on world unload - Minecraft calls no
 * shutdown hook we can rely on, so "flush when the world goes away" is the
 * closest thing to a save point there is.
 *
 * One file per session rather than one rolling log, because the point of a
 * session is to be a labelled sample: `f7-phase-transition.jsonl` is a fixture
 * somebody can read, and a single 400 MB log of everything ever is not.
 */
import Safe from "./safe.js";

const MODULE_DIR = "sbr-dungeon-tracker";
const LOG_DIR = "logs";

/** Flush at this many buffered records even if the timer has not come round. */
const FLUSH_AT = 200;
/** Hard ceiling on one session, so a forgotten `/sbrtrack start` cannot fill a disk. */
const MAX_RECORDS = 200000;

const state = {
  active: false,
  label: null,
  file: null,
  seq: 0,
  dropped: 0,
  buffer: [],
  counts: {},
  listeners: [],
};

function ensureLogDir() {
  try {
    if (typeof FileLib !== "undefined" && typeof FileLib.makeDirectory === "function") {
      FileLib.makeDirectory("./config/ChatTriggers/modules/" + MODULE_DIR + "/" + LOG_DIR);
      return;
    }
  } catch (e) {
    /* fall through to the Java route */
  }
  try {
    const File = Java.type("java.io.File");
    new File("./config/ChatTriggers/modules/" + MODULE_DIR + "/" + LOG_DIR).mkdirs();
  } catch (e) {
    // Both routes failed; FileLib.append may still create parents itself. If it
    // does not, `/sbrtrack status` will show a write error and say so.
  }
}

function slug(text) {
  return String(text || "session")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "session";
}

function stamp() {
  const d = new Date();
  const p = (n) => (n < 10 ? "0" + n : String(n));
  return (
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  );
}

/** Start a session. Returns the file name it will write to. */
function start(label) {
  if (state.active) flush();
  ensureLogDir();
  state.active = true;
  state.label = label || null;
  state.file = LOG_DIR + "/" + slug(label) + "-" + stamp() + ".jsonl";
  state.seq = 0;
  state.dropped = 0;
  state.buffer = [];
  state.counts = {};

  record("session.start", {
    label: state.label,
    module: "sbrDungeonTracker",
    startedAt: new Date().toISOString(),
    player: playerName(),
  });
  return state.file;
}

function stop() {
  if (!state.active) return null;
  record("session.stop", { stoppedAt: new Date().toISOString(), captured: state.seq, dropped: state.dropped });
  flush();
  const file = state.file;
  state.active = false;
  return file;
}

function playerName() {
  try {
    return String(Player.getName());
  } catch (e) {
    return null;
  }
}

/**
 * Append one record.
 *
 * `payload` is already-safe data from `safe.js`; this function does no
 * coercion of its own beyond the final stringify, so a caller that hands it a
 * raw Java object gets `{"$java":...}` rather than an exception.
 */
function record(eventName, payload) {
  if (!state.active) return;
  if (state.seq >= MAX_RECORDS) {
    state.dropped += 1;
    return;
  }

  state.seq += 1;
  state.counts[eventName] = (state.counts[eventName] || 0) + 1;

  const entry = {
    t: Date.now(),
    seq: state.seq,
    ev: eventName,
    session: state.label,
    data: payload === undefined ? null : payload,
  };

  state.buffer.push(Safe.safeStringify(entry));

  // Notify anything downstream (the WebSocket forwarder) *after* the record is
  // safely buffered, so a socket failure can never cost us the capture.
  for (let i = 0; i < state.listeners.length; i += 1) {
    try {
      state.listeners[i](entry);
    } catch (e) {
      /* a listener must never break capture */
    }
  }

  if (state.buffer.length >= FLUSH_AT) flush();
}

let lastWriteError = null;

function flush() {
  if (state.buffer.length === 0 || state.file === null) return;
  const text = state.buffer.join("\n") + "\n";
  state.buffer = [];
  try {
    FileLib.append(MODULE_DIR, state.file, text);
    lastWriteError = null;
  } catch (e) {
    lastWriteError = Safe.describeError(e);
  }
}

/** Register a callback that receives every record as it is captured. */
function onRecord(fn) {
  state.listeners.push(fn);
}

function status() {
  return {
    active: state.active,
    label: state.label,
    file: state.file,
    captured: state.seq,
    dropped: state.dropped,
    buffered: state.buffer.length,
    counts: state.counts,
    writeError: lastWriteError,
  };
}

export default { start, stop, record, flush, onRecord, status, MODULE_DIR };
