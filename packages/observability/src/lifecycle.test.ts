/**
 * Lifecycle tests avoid touching the real process: `installLifecycle` registers
 * signal handlers and calls `process.exit`, so both are stubbed and restored.
 * What is asserted is the behaviour that was missing before — that a second
 * signal doesn't re-enter shutdown, and that a shutdown which never settles
 * still ends the process.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { installLifecycle } from "./lifecycle.js";
import type { Logger } from "./logger.js";

const silent: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
  child() { return silent; },
};

const realExit = process.exit;
const realListeners = {
  SIGINT: process.listeners("SIGINT"),
  SIGTERM: process.listeners("SIGTERM"),
  unhandledRejection: process.listeners("unhandledRejection"),
  uncaughtException: process.listeners("uncaughtException"),
};

afterEach(() => {
  process.exit = realExit;
  for (const [event, listeners] of Object.entries(realListeners)) {
    process.removeAllListeners(event);
    for (const l of listeners) process.on(event as "SIGINT", l as () => void);
  }
});

/** Capture exit codes instead of exiting, and let the test await the first one. */
function stubExit(): { codes: number[]; next: () => Promise<number> } {
  const codes: number[] = [];
  let resolve: ((code: number) => void) | null = null;
  const pending = new Promise<number>((r) => { resolve = r; });
  process.exit = ((code?: number) => {
    codes.push(code ?? 0);
    resolve?.(code ?? 0);
    return undefined as never;
  }) as typeof process.exit;
  return { codes, next: () => pending };
}

test("shutdown runs once even when the signal arrives repeatedly", async () => {
  const exit = stubExit();
  let calls = 0;
  const { stop } = installLifecycle({
    logger: silent,
    async shutdown() { calls += 1; },
  });

  // An orchestrator that thinks the first signal was slow sends another; the
  // old code re-entered here and closed every client twice, concurrently.
  stop("first");
  stop("second");
  stop("third");
  await exit.next();

  assert.equal(calls, 1, "shutdown should not re-enter");
  assert.deepEqual(exit.codes, [0]);
});

test("a shutdown that never settles still exits, rather than hanging forever", async () => {
  const exit = stubExit();
  const { stop } = installLifecycle({
    logger: silent,
    timeoutMs: 30,
    // Never resolves — a BullMQ close waiting on a job that will not finish.
    shutdown: () => new Promise<void>(() => {}),
  });

  stop("hang");
  const code = await exit.next();
  assert.equal(code, 1, "a watchdog exit must be non-zero so a supervisor notices");
});

test("a shutdown that throws exits non-zero instead of being swallowed", async () => {
  const exit = stubExit();
  const { stop } = installLifecycle({
    logger: silent,
    async shutdown() { throw new Error("close failed"); },
  });

  stop("boom");
  assert.equal(await exit.next(), 1);
});

test("an unhandled rejection is logged before the process goes", async () => {
  const exit = stubExit();
  const seen: string[] = [];
  const recording: Logger = { ...silent, error(msg: string) { seen.push(msg); } };

  installLifecycle({ logger: recording, async shutdown() {} });
  process.emit("unhandledRejection", new Error("nope"), Promise.resolve());
  await exit.next();

  assert.ok(
    seen.includes("unhandled promise rejection"),
    `expected a structured log line, saw: ${seen.join(", ")}`,
  );
});
