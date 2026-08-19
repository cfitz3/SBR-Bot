/**
 * The five-minute deadline, which is the one number in screening that belongs
 * to Hypixel rather than to us. The assertions are about the direction of the
 * errors: the remainder must never read as more time than there is, and a
 * closed window must never read as open.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JOIN_WINDOW_MS, formatRemaining, remainingWindowMs, windowClosed } from "./window.js";

const AT = new Date("2026-08-09T12:00:00.000Z");
const after = (ms: number) => new Date(AT.getTime() + ms);

test("the remainder counts down and floors at zero", () => {
  assert.equal(remainingWindowMs(AT, AT), JOIN_WINDOW_MS);
  assert.equal(remainingWindowMs(AT, after(60_000)), 4 * 60_000);
  assert.equal(remainingWindowMs(AT, after(JOIN_WINDOW_MS)), 0);
  // Never negative: a caller formatting this would otherwise print "-3m left".
  assert.equal(remainingWindowMs(AT, after(JOIN_WINDOW_MS + 60_000)), 0);
});

test("the window is closed exactly when nothing is left", () => {
  assert.equal(windowClosed(AT, after(JOIN_WINDOW_MS - 1)), false);
  assert.equal(windowClosed(AT, after(JOIN_WINDOW_MS)), true);
});

test("the remainder reads as words a staffer can act on", () => {
  assert.equal(formatRemaining(0), "window closed");
  assert.equal(formatRemaining(-1), "window closed");
  assert.equal(formatRemaining(30_000), "30s left");
  assert.equal(formatRemaining(120_000), "2m left");
  assert.equal(formatRemaining(125_000), "2m 5s left");
});
