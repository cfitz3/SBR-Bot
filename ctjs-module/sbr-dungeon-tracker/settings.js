/**
 * Reads `config.json` from the module folder.
 *
 * The ingest URL lives here rather than in a constant in the source on purpose:
 * whoever installs this module is pointing their own client at a server, and
 * they get to see and change where that is. A URL baked into `socket.js` would
 * be a thing done to them rather than by them.
 *
 * A missing or malformed file is not an error — the defaults below are a
 * working local-only configuration (capture to disk, no socket), which is also
 * the safest thing to fall back to.
 */
import Safe from "./safe.js";

const MODULE_DIR = "sbr-dungeon-tracker";
const CONFIG_FILE = "config.json";

const DEFAULTS = {
  ingestUrl: "ws://localhost:8080/ingest",
  streaming: false,
  captureOnLoad: false,
  verboseTriggers: false,
  debugChat: false,
};

function readFile() {
  try {
    const text = FileLib.read(MODULE_DIR, CONFIG_FILE);
    return text === null || text === undefined ? null : String(text);
  } catch (e) {
    return null;
  }
}

/**
 * Load settings, merging whatever the file supplies over the defaults.
 *
 * Returns the values plus a `source` describing where they came from, so
 * `/sbrtrack status` can tell "you edited the file" apart from "the file failed
 * to parse and you are looking at defaults".
 */
function load() {
  const out = {};
  for (const key in DEFAULTS) out[key] = DEFAULTS[key];

  const text = readFile();
  if (text === null) return { values: out, source: "defaults (config.json not found)", error: null };

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { values: out, source: "defaults (config.json is not valid JSON)", error: Safe.describeError(e) };
  }

  for (const key in DEFAULTS) {
    if (parsed === null || typeof parsed !== "object") break;
    const value = parsed[key];
    if (value === undefined || value === null) continue;
    // Keys prefixed with "//" in the file are comments and are ignored by
    // virtue of never appearing in DEFAULTS.
    if (typeof DEFAULTS[key] === "boolean") out[key] = value === true;
    else out[key] = String(value);
  }

  return { values: out, source: CONFIG_FILE, error: null };
}

export default { load, DEFAULTS, MODULE_DIR, CONFIG_FILE };
