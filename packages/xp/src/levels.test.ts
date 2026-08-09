import test from "node:test";
import assert from "node:assert/strict";
import { LEVEL_STEP, levelForXp, levelProgress, progressBar, xpForLevel } from "./levels.js";

test("level 0 is free and level 1 costs one step", () => {
  assert.equal(xpForLevel(0), 0);
  assert.equal(xpForLevel(1), LEVEL_STEP);
  assert.equal(xpForLevel(2), LEVEL_STEP * 3);
});

test("levelForXp inverts xpForLevel exactly at every boundary", () => {
  // The closed-form inverse is where a curve like this usually goes wrong: a
  // float that lands a hair under the boundary costs someone a level.
  for (let level = 0; level <= 200; level += 1) {
    assert.equal(levelForXp(xpForLevel(level)), level, `at level ${level}`);
    assert.equal(levelForXp(xpForLevel(level) - 1), Math.max(0, level - 1), `just below ${level}`);
  }
});

test("a negative total floors at level 0 rather than going imaginary", () => {
  assert.equal(levelForXp(-500), 0);
  assert.equal(levelProgress(-500).intoLevel, 0);
});

test("progress reports the distance into the level and its span", () => {
  const p = levelProgress(xpForLevel(3) + 40);
  assert.equal(p.level, 3);
  assert.equal(p.intoLevel, 40);
  assert.equal(p.levelSpan, LEVEL_STEP * 4);
});

test("the bar fills proportionally and never overflows its width", () => {
  assert.equal(progressBar({ level: 1, intoLevel: 0, levelSpan: 100 }), "▱▱▱▱▱▱▱▱▱▱");
  assert.equal(progressBar({ level: 1, intoLevel: 50, levelSpan: 100 }), "▰▰▰▰▰▱▱▱▱▱");
  assert.equal(progressBar({ level: 1, intoLevel: 999, levelSpan: 100 }), "▰▰▰▰▰▰▰▰▰▰");
  assert.equal(progressBar({ level: 1, intoLevel: 5, levelSpan: 0 }).length, 10);
});
