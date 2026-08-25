/**
 * The outbound pipe: a WebSocket to our own ingest server, over the JDK client
 * reached through ChatTriggers Java interop.
 *
 * Three constraints shape everything here.
 *
 * **Gameplay comes first.** Every operation is non-blocking. Nothing in this
 * file ever waits on a future, and the queue is bounded, so a backend that is
 * down or slow costs the player nothing. If this file has to choose between
 * delivering a record and dropping a frame, it drops the record.
 *
 * **Callbacks are not on the game thread.** `java.net.http` runs listener
 * callbacks on its own executor. Touching a ChatTriggers API from there is a
 * good way to crash a client, so the listener below only ever sets plain
 * JavaScript flags and pushes strings onto arrays. Everything that talks to
 * Minecraft happens in `pump()`, which the module calls from a trigger and is
 * therefore on the game thread.
 *
 * **The JDK allows one send in flight.** `WebSocket.sendText` throws if the
 * previous send has not completed, so `pump()` keeps exactly one outstanding
 * future and polls it rather than chaining callbacks. That is also why records
 * go out in batches: one frame per pump carrying up to `MAX_BATCH` events
 * delivers a busy dungeon run in real time, where one event per pump would
 * fall behind within a minute. Each event keeps the exact `raw_event` shape it
 * would have had on its own — the batch is transport framing, not a filter.
 */
import Safe from "./safe.js";
import Queue from "./queue.js";

const MAX_BATCH = 100;

/** First reconnect delay; doubles to the cap. */
const BACKOFF_START_MS = 2000;
const BACKOFF_MAX_MS = 60000;

/** Connecting is itself an operation that can hang; give it a deadline. */
const CONNECT_TIMEOUT_MS = 15000;

function createSocket(options) {
  const opts = options || {};
  const queue = Queue.createQueue(opts.queueLimit);

  const state = {
    url: opts.url || null,
    moduleVersion: opts.moduleVersion || "0.0.0",
    // Written by listener callbacks on a foreign thread; read by pump() on the
    // game thread. Plain values only — never a ChatTriggers object.
    phase: "idle", // idle | connecting | open | closed
    ws: null,
    connectFuture: null,
    connectStartedAt: 0,
    sendFuture: null,
    backoffMs: BACKOFF_START_MS,
    nextAttemptAt: 0,
    inbox: [],
    lastError: null,
    closeCode: null,
    closeReason: null,
    sent: 0,
    frames: 0,
    helloSent: false,
  };

  function note(message, fields) {
    if (typeof opts.onLog === "function") {
      try {
        opts.onLog(message, fields || {});
      } catch (e) {
        /* logging must never break the socket */
      }
    }
  }

  function buildListener() {
    const Listener = Java.type("java.net.http.WebSocket$Listener");
    // Implemented with a JS object: Rhino adapts it to the Java interface.
    // Keep every body trivial — see the thread note at the top of the file.
    return new Listener({
      onOpen: function (webSocket) {
        state.phase = "open";
        state.ws = webSocket;
        state.helloSent = false;
        try {
          webSocket.request(1);
        } catch (e) {
          /* nothing useful to do from this thread */
        }
      },
      onText: function (webSocket, data, last) {
        try {
          state.inbox.push(String(data));
          if (state.inbox.length > 32) state.inbox.shift();
        } catch (e) {
          /* ignore */
        }
        try {
          webSocket.request(1);
        } catch (e) {
          /* ignore */
        }
        return null;
      },
      onError: function (webSocket, error) {
        state.phase = "closed";
        state.ws = null;
        try {
          state.lastError = String(error);
        } catch (e) {
          state.lastError = "unprintable error";
        }
      },
      onClose: function (webSocket, statusCode, reason) {
        state.phase = "closed";
        state.ws = null;
        try {
          state.closeCode = Number(statusCode);
          state.closeReason = String(reason);
        } catch (e) {
          /* ignore */
        }
        return null;
      },
    });
  }

  function connect() {
    if (state.phase === "connecting" || state.phase === "open") return;
    if (state.url === null || String(state.url).length === 0) {
      note("ingest url is not configured");
      return;
    }

    try {
      const HttpClient = Java.type("java.net.http.HttpClient");
      const URI = Java.type("java.net.URI");
      state.phase = "connecting";
      state.connectStartedAt = Date.now();
      state.connectFuture = HttpClient.newHttpClient()
        .newWebSocketBuilder()
        .buildAsync(URI.create(String(state.url)), buildListener());
      note("connecting", { url: state.url });
    } catch (e) {
      // The most likely cause on an older ChatTriggers is that java.net.http
      // does not exist (a Java 8 client). Say so rather than retrying blindly.
      state.phase = "closed";
      state.lastError = Safe.describeError(e);
      scheduleRetry();
      note("connect failed", { error: state.lastError });
    }
  }

  function scheduleRetry() {
    state.nextAttemptAt = Date.now() + state.backoffMs;
    state.backoffMs = Math.min(state.backoffMs * 2, BACKOFF_MAX_MS);
  }

  function disconnect(reason) {
    const ws = state.ws;
    state.phase = "idle";
    state.ws = null;
    state.connectFuture = null;
    state.sendFuture = null;
    state.helloSent = false;
    if (ws !== null) {
      try {
        // 1000 = normal closure.
        ws.sendClose(1000, String(reason || "client stopping"));
      } catch (e) {
        /* already gone */
      }
    }
  }

  function helloFrame() {
    let username = null;
    try {
      username = String(Player.getName());
    } catch (e) {
      username = null;
    }
    return {
      type: "hello",
      mcUsername: username,
      moduleVersion: state.moduleVersion,
      sentAt: new Date().toISOString(),
    };
  }

  function sendRaw(text) {
    try {
      state.sendFuture = state.ws.sendText(text, true);
      state.frames += 1;
      return true;
    } catch (e) {
      state.lastError = Safe.describeError(e);
      state.phase = "closed";
      state.ws = null;
      return false;
    }
  }

  /**
   * One step of the transport, called from a trigger on the game thread.
   *
   * Everything that could touch Minecraft or block lives here rather than in a
   * callback, and each call does at most one send.
   */
  function pump() {
    const now = Date.now();

    if (state.phase === "connecting") {
      if (now - state.connectStartedAt > CONNECT_TIMEOUT_MS) {
        state.phase = "closed";
        state.connectFuture = null;
        state.lastError = "connect timed out";
        scheduleRetry();
      }
      return;
    }

    if (state.phase === "closed") {
      if (now >= state.nextAttemptAt) connect();
      return;
    }

    if (state.phase !== "open" || state.ws === null) return;

    // A send is still in flight: the JDK forbids starting another.
    if (state.sendFuture !== null) {
      let done = false;
      try {
        done = state.sendFuture.isDone();
      } catch (e) {
        done = true;
      }
      if (!done) return;
      state.sendFuture = null;
    }

    // A successful open resets the backoff — but only once the socket has
    // proved it can carry a frame, which the handshake is.
    if (!state.helloSent) {
      if (sendRaw(Safe.safeStringify(helloFrame()))) {
        state.helloSent = true;
        state.backoffMs = BACKOFF_START_MS;
        note("handshake sent");
      } else {
        scheduleRetry();
      }
      return;
    }

    const batch = queue.take(MAX_BATCH);
    if (batch.length === 0) return;

    const frame = { type: "raw_batch", count: batch.length, events: batch };
    if (sendRaw(Safe.safeStringify(frame))) {
      state.sent += batch.length;
    } else {
      // Put them back: a failed send is a disconnect, not a delivery.
      queue.unshiftAll(batch);
      scheduleRetry();
    }
  }

  /**
   * Offer one captured record to the pipe.
   *
   * Always returns immediately. When the socket is down this queues, and when
   * the queue is full the oldest record is dropped — never the player frame.
   */
  function offer(entry) {
    queue.push({
      type: "raw_event",
      eventName: entry.ev,
      timestamp: entry.t,
      seq: entry.seq,
      session: entry.session,
      payload: entry.data,
    });
  }

  function start(url) {
    if (typeof url === "string" && url.length > 0) state.url = url;
    state.backoffMs = BACKOFF_START_MS;
    state.nextAttemptAt = 0;
    if (state.phase === "idle") state.phase = "closed";
    pump();
  }

  function stop(reason) {
    disconnect(reason);
    queue.clear();
  }

  function status() {
    return {
      url: state.url,
      phase: state.phase,
      queued: queue.size(),
      queueLimit: queue.limit(),
      dropped: queue.droppedCount(),
      sent: state.sent,
      frames: state.frames,
      lastError: state.lastError,
      closeCode: state.closeCode,
      closeReason: state.closeReason,
      inbox: state.inbox.slice(-3),
    };
  }

  return { start, stop, pump, offer, status, connect, disconnect };
}

export default { createSocket, MAX_BATCH };
