import assert from "node:assert/strict";
import { test } from "node:test";
import {
  burstReached,
  defaultRules,
  describeRules,
  evaluateJoin,
  parseAntiRaid,
  simulateRaid,
  type AntiRaidRules,
} from "./antiraid.js";

function rules(over: Partial<AntiRaidRules> = {}): AntiRaidRules {
  return { ...defaultRules("MEDIUM"), ...over };
}

const young = { accountAgeHours: 1, hasAvatar: true };
const old = { accountAgeHours: 24 * 30, hasAvatar: true };

test("a quiet server gates nobody, however new their account", () => {
  const decision = evaluateJoin(rules(), { ...young, joinsInWindow: 1, postureActive: false });
  assert.equal(decision.action, "ALLOW");
  assert.deepEqual(decision.reasons, []);
  assert.equal(decision.engages, false);
});

test("the join that trips the burst engages the posture and is itself gated by it", () => {
  const decision = evaluateJoin(rules({ burst: { joins: 3, windowSeconds: 60 } }), {
    ...young,
    joinsInWindow: 3,
    postureActive: false,
  });
  assert.equal(decision.engages, true);
  assert.equal(decision.action, "FLAG");
  assert.match(decision.reasons[0] ?? "", /under the/);
});

test("an established account is let in even during a raid", () => {
  const decision = evaluateJoin(rules(), { ...old, joinsInWindow: 50, postureActive: true });
  assert.equal(decision.action, "ALLOW");
});

test("the avatar rule only applies when the guild asked for it", () => {
  const ctx = { accountAgeHours: 24 * 30, hasAvatar: false, joinsInWindow: 1, postureActive: true };
  assert.equal(evaluateJoin(rules(), ctx).action, "ALLOW");
  assert.equal(evaluateJoin(rules({ requireAvatar: true }), ctx).action, "FLAG");
});

test("switching anti-raid off stops it gating even while the posture is on", () => {
  const decision = evaluateJoin(rules({ enabled: false }), {
    ...young,
    joinsInWindow: 99,
    postureActive: true,
  });
  assert.equal(decision.action, "ALLOW");
});

test("a guild that only wants the manual switch never auto-engages", () => {
  const decision = evaluateJoin(rules({ autoEngage: false, burst: { joins: 2, windowSeconds: 60 } }), {
    ...young,
    joinsInWindow: 40,
    postureActive: false,
  });
  assert.equal(decision.engages, false);
  assert.equal(decision.action, "ALLOW");
});

test("every preset flags rather than removing, and tightens as sensitivity rises", () => {
  const low = defaultRules("LOW");
  const medium = defaultRules("MEDIUM");
  const high = defaultRules("HIGH");
  for (const preset of [low, medium, high]) assert.equal(preset.joinAction, "FLAG");
  assert.ok(low.burst.joins > medium.burst.joins);
  assert.ok(medium.burst.joins > high.burst.joins);
  assert.ok(high.minAccountAgeHours > medium.minAccountAgeHours);
  assert.equal(high.requireAvatar, true);
});

test("burstReached is the threshold the presets are written against", () => {
  const r = rules({ burst: { joins: 8, windowSeconds: 60 } });
  assert.equal(burstReached(r, 7), false);
  assert.equal(burstReached(r, 8), true);
});

test("stored rules keep their own fields and take defaults for the rest", () => {
  const parsed = parseAntiRaid({ burst: { joins: 4 }, joinAction: "KICK" }, "LOW");
  assert.equal(parsed.burst.joins, 4);
  // The window was not stored, so the preset's window survives rather than the
  // whole burst reverting.
  assert.equal(parsed.burst.windowSeconds, defaultRules("LOW").burst.windowSeconds);
  assert.equal(parsed.joinAction, "KICK");
  assert.equal(parsed.minAccountAgeHours, defaultRules("LOW").minAccountAgeHours);
});

test("unusable stored values fall back rather than being trusted", () => {
  const parsed = parseAntiRaid({
    burst: { joins: 0, windowSeconds: 99_999 },
    minAccountAgeHours: -5,
    joinAction: "DELETE",
    autoLiftMinutes: 0,
  });
  const base = defaultRules("MEDIUM");
  assert.equal(parsed.burst.joins, base.burst.joins);
  assert.equal(parsed.burst.windowSeconds, base.burst.windowSeconds);
  assert.equal(parsed.minAccountAgeHours, base.minAccountAgeHours);
  assert.equal(parsed.joinAction, base.joinAction);
  assert.equal(parsed.autoLiftMinutes, base.autoLiftMinutes);
});

test("stays on until lifted is a stored answer, not a missing one", () => {
  assert.equal(parseAntiRaid({ autoLiftMinutes: null }).autoLiftMinutes, null);
  assert.equal(parseAntiRaid({}).autoLiftMinutes, defaultRules("MEDIUM").autoLiftMinutes);
  assert.equal(parseAntiRaid(null).autoLiftMinutes, defaultRules("MEDIUM").autoLiftMinutes);
});

test("the dry run reports which arrival engaged the posture and what each one got", () => {
  const run = simulateRaid(
    rules({ burst: { joins: 3, windowSeconds: 60 }, joinAction: "KICK" }),
    [young, young, young, old, young],
  );
  assert.equal(run.engagedAt, 3);
  // The first two arrive before the posture exists and cost nothing.
  assert.deepEqual(
    run.outcomes.map((o) => o.action),
    ["ALLOW", "ALLOW", "KICK", "ALLOW", "KICK"],
  );
  assert.equal(run.totals.KICK, 2);
  assert.equal(run.totals.ALLOW, 3);
});

test("the dry run can answer the other question: an ordinary arrival while on", () => {
  const run = simulateRaid(rules(), [young], true);
  assert.equal(run.engagedAt, null);
  assert.equal(run.totals.FLAG, 1);
});

test("the description says what the configuration does, in one sentence", () => {
  assert.match(describeRules(rules({ enabled: false })), /switched off/);
  const text = describeRules(rules({ burst: { joins: 8, windowSeconds: 60 }, requireAvatar: true }));
  assert.match(text, /8 joins in 60s/);
  assert.match(text, /no profile picture/);
  assert.match(text, /flagged for staff/);
  assert.match(describeRules(rules({ autoLiftMinutes: null })), /until lifted/);
  assert.match(describeRules(rules({ autoEngage: false })), /staff switch it on/);
});
