/**
 * The exploration harness: register broadly, assume nothing, record everything.
 *
 * Two deliberate choices run through this file.
 *
 * First, every registration is attempted inside a try/catch and reported.
 * Trigger names and callback signatures differ between ChatTriggers releases,
 * and guild members will not all be on the same one. A harness that throws at
 * load because this build has no `spawnParticle` teaches us nothing; a harness
 * that records "spawnParticle: unavailable on this build" has produced its
 * first finding before the player has entered a dungeon.
 *
 * Second, handlers record `arguments` positionally rather than by name.
 * Reading `event.message` presumes a signature. Phase 1 does not get to
 * presume — working out the real signature from a capture is the job.
 *
 * Read-only throughout. Nothing here sends a chat message, runs a command,
 * clicks, moves or warps; the only writes are to our own log file and our own
 * socket.
 */
import Safe from "./safe.js";
import Capture from "./capture.js";

/** Scoreboard and tab list have no change trigger, so they are polled. */
const POLL_SECONDS = 1;
/** Tab list is long and changes slowly; polling it every second is waste. */
const TABLIST_EVERY = 3;

const registered = [];
const unavailable = [];

/**
 * Register one trigger, surviving both an unknown trigger name and a handler
 * that throws mid-session.
 */
function attempt(name, triggerType, build) {
  try {
    const trigger = register(triggerType, function () {
      try {
        Capture.record("trigger." + name, { args: Safe.safeArgs(arguments) });
      } catch (e) {
        // Never let a capture failure propagate into the Minecraft event loop.
      }
    });
    if (typeof build === "function") build(trigger);
    registered.push(name);
    return trigger;
  } catch (e) {
    unavailable.push({ name: name, reason: Safe.describeError(e) });
    return null;
  }
}

/**
 * As `attempt`, but with a handler of our own — used where the raw arguments
 * are not the interesting part (chat text, poll diffs).
 */
function attemptWith(name, triggerType, handler, build) {
  try {
    const trigger = register(triggerType, function () {
      try {
        handler.apply(null, arguments);
      } catch (e) {
        try {
          Capture.record("harness.error", { trigger: name, error: Safe.describeError(e) });
        } catch (e2) {
          /* give up quietly rather than loop */
        }
      }
    });
    if (typeof build === "function") build(trigger);
    registered.push(name);
    return trigger;
  } catch (e) {
    unavailable.push({ name: name, reason: Safe.describeError(e) });
    return null;
  }
}

function plainText(value) {
  try {
    return String(ChatLib.removeFormatting(String(value)));
  } catch (e) {
    return String(value);
  }
}

// ─────────────────────────────── pollers ───────────────────────────────

let lastScoreboardTitle = null;
let lastScoreboardLines = null;
let lastTabList = null;
let lastActionBar = null;
let pollCount = 0;

function readScoreboard() {
  const out = { title: null, lines: [] };
  try {
    out.title = plainText(Scoreboard.getTitle());
  } catch (e) {
    out.title = null;
  }
  try {
    const lines = Scoreboard.getLines();
    for (let i = 0; i < lines.length; i += 1) {
      let name;
      try {
        name = lines[i].getName();
      } catch (e) {
        name = String(lines[i]);
      }
      // Both renderings: the formatted string is what the parsing patterns in
      // EVENT_FINDINGS.md will have to match, and the plain one is what a
      // human reading the fixture can follow.
      out.lines.push({ raw: String(name), text: plainText(name) });
    }
  } catch (e) {
    out.error = Safe.describeError(e);
  }
  return out;
}

function readTabList() {
  try {
    const names = TabList.getNames();
    const out = [];
    for (let i = 0; i < names.length; i += 1) {
      const text = plainText(names[i]);
      if (text && text.trim().length > 0) out.push({ raw: String(names[i]), text: text });
    }
    return out;
  } catch (e) {
    return null;
  }
}

function sameEntries(a, b) {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].raw !== b[i].raw) return false;
  }
  return true;
}

/**
 * The poll tick.
 *
 * Diffed rather than dumped: a scoreboard recorded once a second for a
 * twenty-minute run is 1200 near-identical records, and the state change we
 * are hunting for is invisible inside them. Recording only transitions makes
 * the capture file a list of the moments something happened, which is exactly
 * what EVENT_FINDINGS.md has to be written from.
 */
function poll() {
  pollCount += 1;

  const board = readScoreboard();
  if (board.title !== lastScoreboardTitle) {
    Capture.record("scoreboard.title", { from: lastScoreboardTitle, to: board.title });
    lastScoreboardTitle = board.title;
  }
  if (!sameEntries(board.lines, lastScoreboardLines)) {
    Capture.record("scoreboard.lines", { title: board.title, lines: board.lines });
    lastScoreboardLines = board.lines;
  }

  if (pollCount % TABLIST_EVERY === 0) {
    const tab = readTabList();
    if (!sameEntries(tab, lastTabList)) {
      Capture.record("tablist", { entries: tab });
      lastTabList = tab;
    }
  }

  // Flushing here rather than on its own timer keeps the module to one
  // repeating trigger.
  Capture.flush();
}

// ───────────────────────────── registration ─────────────────────────────

/**
 * Register the sampling set. Returns a report of what this ChatTriggers build
 * actually supports — itself a Phase 1 finding worth recording.
 */
function registerAll(config) {
  const verbose = config && config.verboseTriggers;

  // Chat is the single richest source in Skyblock: run start, secrets, deaths,
  // phase messages, score and completion all announce themselves here.
  attemptWith(
    "chat",
    "chat",
    function (event) {
      let raw = null;
      let text = null;
      try {
        raw = String(ChatLib.getChatMessage(event, true));
      } catch (e) {
        raw = null;
      }
      try {
        text = raw === null ? null : plainText(raw);
      } catch (e) {
        text = null;
      }
      Capture.record("chat", { raw: raw, text: text, args: Safe.safeArgs(arguments) });
    },
    function (t) {
      // Catch-all criteria. Without it the trigger matches nothing on some builds.
      try {
        t.setCriteria("${*}");
      } catch (e) {
        /* other builds capture everything by default */
      }
    },
  );

  // The action bar carries live run state in dungeons (health, secrets found).
  attemptWith(
    "actionBar",
    "actionBar",
    function (message) {
      const text = plainText(message);
      // Deduplicated: the action bar re-sends the same string many times a
      // second, and only the transitions are informative.
      if (text === lastActionBar) return;
      lastActionBar = text;
      Capture.record("actionBar", { raw: String(message), text: text });
    },
    function (t) {
      try {
        t.setCriteria("${*}");
      } catch (e) {
        /* ignore */
      }
    },
  );

  attemptWith("worldLoad", "worldLoad", function () {
    // Reset the poll baselines: a new world is a new scoreboard, and diffing
    // against the old one would report the whole board as a change.
    lastScoreboardTitle = null;
    lastScoreboardLines = null;
    lastTabList = null;
    lastActionBar = null;
    Capture.record("worldLoad", { at: new Date().toISOString() });
  });

  attemptWith("worldUnload", "worldUnload", function () {
    Capture.record("worldUnload", { at: new Date().toISOString() });
    Capture.flush();
  });

  attemptWith("serverConnect", "serverConnect", function () {
    Capture.record("serverConnect", { args: Safe.safeArgs(arguments) });
  });

  attemptWith("serverDisconnect", "serverDisconnect", function () {
    Capture.record("serverDisconnect", { args: Safe.safeArgs(arguments) });
    Capture.flush();
  });

  // Chest GUIs are how secrets are opened, so the title of an opening GUI is a
  // candidate secret signal.
  attemptWith("guiOpened", "guiOpened", function () {
    let title = null;
    try {
      title = plainText(Player.getContainer().getName());
    } catch (e) {
      title = null;
    }
    Capture.record("guiOpened", { title: title, args: Safe.safeArgs(arguments) });
  });

  // The periodic poller. `step` rather than `tick` because it is expressed in
  // seconds and does not fire twenty times a second.
  attemptWith("poll", "step", poll, function (t) {
    try {
      t.setDelay(POLL_SECONDS);
    } catch (e) {
      try {
        t.setFps(1);
      } catch (e2) {
        /* leave at the default cadence */
      }
    }
  });

  if (verbose) {
    // Everything below fires constantly. It is off unless a capture session is
    // specifically hunting for a signal the quiet set does not carry — boss
    // phase changes being the expected case, since those may only be
    // distinguishable by sound or particle.
    attempt("soundPlay", "soundPlay");
    attempt("spawnParticle", "spawnParticle");
    attempt("entityDeath", "entityDeath");
    attempt("playerJoin", "playerJoin");
    attempt("playerLeave", "playerLeave");

    let ticks = 0;
    attemptWith("tick", "tick", function () {
      ticks += 1;
      // Throttled hard: a bare tick record is worthless, but a heartbeat every
      // hundred ticks gives a capture a timebase to line other events up
      // against.
      if (ticks % 100 === 0) Capture.record("tick", { ticks: ticks });
    });
  }

  const report = { registered: registered.slice(), unavailable: unavailable.slice(), verbose: !!verbose };
  Capture.record("harness.registered", report);
  return report;
}

function snapshot() {
  return { scoreboard: readScoreboard(), tablist: readTabList() };
}

export default { registerAll, snapshot, readScoreboard, readTabList };
