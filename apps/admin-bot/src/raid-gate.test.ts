import assert from "node:assert/strict";
import { test } from "node:test";
import { JoinWindow } from "./raid-gate.js";

test("the window counts only the joins still inside it", () => {
  const w = new JoinWindow();
  const t0 = 1_000_000;
  assert.equal(w.record("g", 60, t0), 1);
  assert.equal(w.record("g", 60, t0 + 10_000), 2);
  assert.equal(w.record("g", 60, t0 + 20_000), 3);
  // A minute later the first three have aged out and this is a fresh burst,
  // which is the whole point: a busy server is not a raid.
  assert.equal(w.record("g", 60, t0 + 90_000), 1);
});

test("guilds are counted separately", () => {
  const w = new JoinWindow();
  w.record("a", 60, 0);
  w.record("a", 60, 1);
  assert.equal(w.record("b", 60, 2), 1);
});

test("pruning drops guilds that have gone quiet", () => {
  const w = new JoinWindow();
  w.record("a", 60, 0);
  w.prune(60, 120_000);
  assert.equal(w.record("a", 60, 120_001), 1);
});
