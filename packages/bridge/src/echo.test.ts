import assert from "node:assert/strict";
import { test } from "node:test";
import { EchoLedger, echoKey } from "./echo.js";

test("an unregistered line is never claimed", () => {
  const ledger = new EchoLedger();
  assert.equal(ledger.claim("[D] Alice: hello"), false);
});

test("a registered line is claimed exactly once", () => {
  const ledger = new EchoLedger();
  ledger.expect("Steve — Cata 42 | SA 45.3");
  assert.equal(ledger.claim("Steve — Cata 42 | SA 45.3"), true);
  // The second arrival is a player repeating it, not the bot's echo.
  assert.equal(ledger.claim("Steve — Cata 42 | SA 45.3"), false);
});

test("matches through the colour codes and spacing Hypixel adds", () => {
  const ledger = new EchoLedger();
  ledger.expect("Steve — Cata 42");
  assert.equal(ledger.claim("§aSteve  §r— Cata 42 "), true);
});

test("an expired registration is not claimable", () => {
  let clock = 0;
  const ledger = new EchoLedger({ ttlMs: 1_000, now: () => clock });
  ledger.expect("answer");
  clock = 2_000;
  assert.equal(ledger.claim("answer"), false);
});

test("expired entries do not accumulate", () => {
  let clock = 0;
  const ledger = new EchoLedger({ ttlMs: 1_000, now: () => clock });
  for (let i = 0; i < 50; i += 1) ledger.expect(`answer ${i}`);
  clock = 5_000;
  assert.equal(ledger.size, 0);
});

test("blank lines are not registered", () => {
  const ledger = new EchoLedger();
  ledger.expect("   ");
  assert.equal(ledger.size, 0);
  assert.equal(ledger.claim(""), false);
});

test("echoKey collapses what the server rewrites", () => {
  assert.equal(echoKey("  §b[D] Alice:   hi  there "), "[D] Alice: hi there");
});
