import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModerationActionDTO } from "@sbr/shared-types";
import {
  countWarnsInWindow,
  describeRung,
  escalationReason,
  parsePolicy,
  resolveLadder,
  rungFor,
  DEFAULT_LADDER,
  DEFAULT_ESCALATION_WINDOW_DAYS,
} from "./escalation.js";

const NOW = new Date("2026-08-06T00:00:00.000Z");

function warnAt(iso: string): Pick<ModerationActionDTO, "type" | "createdAt"> {
  return { type: "WARN", createdAt: iso };
}

test("a rung fires on the warning that reaches it, not on the ones after", () => {
  assert.equal(rungFor(DEFAULT_LADDER, 2), null);
  assert.equal(rungFor(DEFAULT_LADDER, 3)?.action, "MUTE");
  // The fourth warning must not re-fire the third-warning mute.
  assert.equal(rungFor(DEFAULT_LADDER, 4), null);
  assert.equal(rungFor(DEFAULT_LADDER, 5)?.durationSeconds, 86_400);
  assert.equal(rungFor(DEFAULT_LADDER, 7)?.action, "BAN");
  // Past the top of the ladder nothing further happens on its own.
  assert.equal(rungFor(DEFAULT_LADDER, 9), null);
});

test("warnings outside the window do not count", () => {
  const rows = [
    warnAt("2026-08-05T00:00:00.000Z"),
    warnAt("2026-06-01T00:00:00.000Z"),
    warnAt("2024-01-01T00:00:00.000Z"), // years ago
  ];
  assert.equal(countWarnsInWindow(rows, 90, NOW), 2);
  assert.equal(countWarnsInWindow(rows, 7, NOW), 1);
});

test("only warnings count, not other actions in the history", () => {
  const rows: Pick<ModerationActionDTO, "type" | "createdAt">[] = [
    warnAt("2026-08-05T00:00:00.000Z"),
    { type: "MUTE", createdAt: "2026-08-05T00:00:00.000Z" },
    { type: "NOTE", createdAt: "2026-08-05T00:00:00.000Z" },
  ];
  assert.equal(countWarnsInWindow(rows, 90, NOW), 1);
});

test("a warning exactly on the window boundary still counts", () => {
  const boundary = new Date(NOW.getTime() - 90 * 86_400_000).toISOString();
  assert.equal(countWarnsInWindow([warnAt(boundary)], 90, NOW), 1);
});

test("a guild rung replaces the default at the same count and keeps the rest", () => {
  const ladder = resolveLadder([
    { warns: 3, action: "MUTE", durationSeconds: 600, source: "GUILD" },
  ]);
  assert.deepEqual(
    ladder.map((r) => [r.warns, r.durationSeconds, r.source]),
    [
      [3, 600, "GUILD"],
      [5, 86_400, "DEFAULT"],
      [7, 604_800, "DEFAULT"],
    ],
  );
});

test("a guild rung at a new count is inserted in order", () => {
  const ladder = resolveLadder([{ warns: 4, action: "BAN", durationSeconds: null, source: "GUILD" }]);
  assert.deepEqual(ladder.map((r) => r.warns), [3, 4, 5, 7]);
});

test("an absent policy is the platform default", () => {
  const policy = parsePolicy(null);
  assert.equal(policy.enabled, true);
  assert.equal(policy.windowDays, DEFAULT_ESCALATION_WINDOW_DAYS);
  assert.deepEqual(policy.rungs, DEFAULT_LADDER);
});

test("a mangled policy falls back rather than disabling escalation", () => {
  // Every field is the wrong type; none of it should throw and none of it
  // should leave the guild with no ladder at all.
  const policy = parsePolicy({ enabled: "yes", windowDays: "forever", rungs: "none" });
  assert.equal(policy.enabled, true);
  assert.equal(policy.windowDays, DEFAULT_ESCALATION_WINDOW_DAYS);
  assert.deepEqual(policy.rungs, DEFAULT_LADDER);
});

test("individual bad rungs are dropped and the good ones survive", () => {
  const policy = parsePolicy({
    rungs: [
      { warns: 3, action: "MUTE", durationSeconds: 60 },
      { warns: 0, action: "MUTE", durationSeconds: 60 }, // impossible count
      { warns: 4, action: "KICK", durationSeconds: 60 }, // not an escalation action
      { warns: 5, action: "MUTE", durationSeconds: null }, // an endless mute the mute path would refuse
      { warns: 6, action: "BAN", durationSeconds: null }, // permanent ban is legitimate
    ],
  });
  assert.deepEqual(
    policy.rungs.map((r) => [r.warns, r.source]),
    [
      [3, "GUILD"],
      [5, "DEFAULT"],
      [6, "GUILD"],
      [7, "DEFAULT"],
    ],
  );
  assert.equal(policy.rungs.find((r) => r.warns === 3)?.durationSeconds, 60);
});

test("windowDays is clamped to a year and floored", () => {
  assert.equal(parsePolicy({ windowDays: 4000 }).windowDays, 365);
  assert.equal(parsePolicy({ windowDays: 7.9 }).windowDays, 7);
  assert.equal(parsePolicy({ windowDays: -3 }).windowDays, DEFAULT_ESCALATION_WINDOW_DAYS);
});

test("a guild can turn the ladder off", () => {
  assert.equal(parsePolicy({ enabled: false }).enabled, false);
});

test("the audit reason says what tripped the rung", () => {
  assert.equal(escalationReason(3, 90), "Automatic escalation: 3 warnings in 90 days");
  assert.equal(escalationReason(1, 30), "Automatic escalation: 1 warning in 30 days");
});

test("a rung describes itself in the units it was written in", () => {
  assert.equal(describeRung(DEFAULT_LADDER[0]!), "3 warnings → mute for 1h");
  assert.equal(describeRung(DEFAULT_LADDER[1]!), "5 warnings → mute for 1d");
  assert.equal(describeRung(DEFAULT_LADDER[2]!), "7 warnings → ban for 7d");
  assert.equal(
    describeRung({ warns: 9, action: "BAN", durationSeconds: null, source: "GUILD" }),
    "9 warnings → ban permanently",
  );
});
