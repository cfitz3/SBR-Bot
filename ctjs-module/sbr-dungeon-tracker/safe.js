/**
 * Turning whatever a ChatTriggers trigger handed us into something JSON can
 * hold.
 *
 * This is the piece the whole exploration harness rests on. Trigger callbacks
 * receive Java objects - packets, entities, ChatTriggers' own wrappers - and
 * `JSON.stringify` on one of those either throws, walks into a cycle, or spends
 * a frame serialising an entire world. Since Phase 1 is precisely about finding
 * out what those objects *are*, we cannot know their shapes in advance, so
 * every value is coerced defensively and nothing is ever trusted to be plain.
 *
 * The rule everywhere below: on any doubt, degrade to a string. A capture log
 * full of `"<java.lang.Object>"` is a finding. A capture log that stopped
 * because a getter threw is not.
 */

/** Deep enough to see a packet's interesting fields, shallow enough to stay cheap. */
const MAX_DEPTH = 4;
/** Long chat components can run to hundreds of characters of formatting codes. */
const MAX_STRING = 2000;
const MAX_ARRAY = 64;
const MAX_KEYS = 40;

function isJavaObject(value) {
  // Rhino surfaces Java objects as host objects: typeof is "object" but they
  // carry a `getClass` the JS side can call. Cheaper and more reliable than
  // instanceof against a Java.type lookup.
  try {
    return value !== null && typeof value === "object" && typeof value.getClass === "function";
  } catch (e) {
    return false;
  }
}

function javaClassName(value) {
  try {
    return String(value.getClass().getName());
  } catch (e) {
    return "unknown";
  }
}

function clampString(text) {
  const s = String(text);
  return s.length > MAX_STRING ? s.slice(0, MAX_STRING) + "...<truncated " + s.length + ">" : s;
}

/**
 * A JSON-safe rendering of `value`.
 *
 * Java objects become `{ "$java": "<class name>", "$string": "<toString()>" }`
 * rather than being walked. Walking them is what a naive harness does and it is
 * how you end up serialising a `World`: the point of capture is to learn which
 * class arrives on which trigger, and the class name plus its own `toString`
 * answers that without the risk.
 */
function safeValue(value, depth) {
  const d = depth || 0;

  if (value === null || value === undefined) return null;

  const t = typeof value;
  if (t === "string") return clampString(value);
  if (t === "boolean") return value;
  if (t === "number") return isFinite(value) ? value : String(value);
  if (t === "function") return "<function>";
  if (t === "symbol") return "<symbol>";

  if (isJavaObject(value)) {
    const out = { $java: javaClassName(value) };
    try {
      out.$string = clampString(value);
    } catch (e) {
      out.$string = "<toString threw: " + describeError(e) + ">";
    }
    return out;
  }

  if (d >= MAX_DEPTH) return "<depth limit>";

  if (Array.isArray(value)) {
    const arr = [];
    const n = Math.min(value.length, MAX_ARRAY);
    for (let i = 0; i < n; i += 1) arr.push(safeValue(value[i], d + 1));
    if (value.length > n) arr.push("<+" + (value.length - n) + " more>");
    return arr;
  }

  if (t === "object") {
    const out = {};
    let count = 0;
    // A plain `for...in` rather than Object.keys: some ChatTriggers wrappers
    // expose their fields on the prototype, and Object.keys would report them
    // as empty objects - the least useful possible capture.
    for (const key in value) {
      if (count >= MAX_KEYS) {
        out.$truncated = true;
        break;
      }
      let raw;
      try {
        raw = value[key];
      } catch (e) {
        // A getter that throws is itself worth knowing about.
        out[key] = "<getter threw: " + describeError(e) + ">";
        count += 1;
        continue;
      }
      if (typeof raw === "function") continue;
      out[key] = safeValue(raw, d + 1);
      count += 1;
    }
    return out;
  }

  return clampString(value);
}

function describeError(error) {
  try {
    if (error === null || error === undefined) return "unknown";
    if (error.message) return String(error.message);
    return String(error);
  } catch (e) {
    return "unprintable";
  }
}

/**
 * The `arguments` object of a trigger callback, as an array.
 *
 * Captured positionally and without naming anything, because trigger
 * signatures differ between ChatTriggers versions and this module has to run
 * against whichever one a member happens to have installed. Guessing that
 * argument 2 is the event and reading `.message` off it is how a harness
 * silently records nulls; recording all of them and reading the findings later
 * is how you learn what the signature actually is.
 */
function safeArgs(args) {
  const out = [];
  const n = Math.min(args.length, 12);
  for (let i = 0; i < n; i += 1) out.push(safeValue(args[i], 0));
  return out;
}

/** `JSON.stringify` that returns a diagnostic object instead of throwing. */
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (e) {
    try {
      return JSON.stringify({ $unserializable: describeError(e) });
    } catch (e2) {
      return '{"$unserializable":"double failure"}';
    }
  }
}

export default { safeValue, safeArgs, safeStringify, describeError, isJavaObject, javaClassName };
