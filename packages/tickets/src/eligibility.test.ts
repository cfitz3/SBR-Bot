import assert from "node:assert/strict";
import test from "node:test";
import { evaluateEligibility, isOpen, localTime, nextOpening, type EligibilityInput } from "./eligibility.js";
import { category, settings } from "./fixtures.test.js";

const NOW = new Date("2026-08-12T12:00:00.000Z"); // a Wednesday, midday UTC

function input(over: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    settings: settings(),
    category: category(),
    memberRoleIds: [],
    memberOpenCount: 0,
    categoryOpenCount: 0,
    lastOpenedAt: null,
    now: NOW,
    timeZone: "UTC",
    ...over,
  };
}

test("a member with nothing against them is allowed", () => {
  const result = evaluateEligibility(input());
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "OK");
  assert.equal(result.retryAfterSeconds, null);
  assert.equal(result.opensAt, null);
});

test("BLOCKED", () => {
  const result = evaluateEligibility(
    input({ settings: settings({ blocklistRoleIds: ["bad"] }), memberRoleIds: ["ok", "bad"] }),
  );
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "BLOCKED");
});

test("CATEGORY_DISABLED", () => {
  assert.equal(evaluateEligibility(input({ category: category({ enabled: false }) })).reason, "CATEGORY_DISABLED");
});

test("MISSING_ROLE — the member needs all required roles, not any", () => {
  const cat = category({ requiredRoleIds: ["verified", "member"] });
  assert.equal(evaluateEligibility(input({ category: cat, memberRoleIds: ["verified"] })).reason, "MISSING_ROLE");
  assert.equal(evaluateEligibility(input({ category: cat, memberRoleIds: ["verified", "member"] })).reason, "OK");
});

test("MEMBER_LIMIT", () => {
  const cat = category({ memberLimit: 2 });
  assert.equal(evaluateEligibility(input({ category: cat, memberOpenCount: 1 })).reason, "OK");
  assert.equal(evaluateEligibility(input({ category: cat, memberOpenCount: 2 })).reason, "MEMBER_LIMIT");
});

test("TOTAL_LIMIT", () => {
  const cat = category({ totalLimit: 50 });
  assert.equal(evaluateEligibility(input({ category: cat, categoryOpenCount: 49 })).reason, "OK");
  assert.equal(evaluateEligibility(input({ category: cat, categoryOpenCount: 50 })).reason, "TOTAL_LIMIT");
});

test("COOLDOWN carries the seconds left, and expires", () => {
  const cat = category({ cooldownSeconds: 600 });
  const recent = evaluateEligibility(
    input({ category: cat, lastOpenedAt: new Date(NOW.getTime() - 60_000) }),
  );
  assert.equal(recent.reason, "COOLDOWN");
  assert.equal(recent.retryAfterSeconds, 540);

  const expired = evaluateEligibility(
    input({ category: cat, lastOpenedAt: new Date(NOW.getTime() - 601_000) }),
  );
  assert.equal(expired.reason, "OK");
});

test("CLOSED_HOURS names when staff are next open", () => {
  // Open Wednesdays 13:00–17:00 UTC. It is 12:00 on a Wednesday.
  const hours = { "3": { open: "13:00", close: "17:00" } };
  const result = evaluateEligibility(input({ settings: settings({ workingHours: hours }) }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "CLOSED_HOURS");
  assert.equal(result.opensAt, "2026-08-12T13:00:00.000Z");
});

test("no configured hours means always open", () => {
  assert.equal(evaluateEligibility(input({ settings: settings({ workingHours: {} }) })).reason, "OK");
});

test("a schedule that never opens gives no opensAt rather than a wrong one", () => {
  const hours = { "3": { open: "13:00", close: "13:00" } }; // an empty window
  const result = evaluateEligibility(input({ settings: settings({ workingHours: hours }) }));
  assert.equal(result.reason, "CLOSED_HOURS");
  assert.equal(result.opensAt, null);
});

test("checks run in the documented order — blocked beats every other reason", () => {
  const result = evaluateEligibility(
    input({
      settings: settings({ blocklistRoleIds: ["bad"], workingHours: { "3": { open: "13:00", close: "17:00" } } }),
      category: category({ enabled: false, requiredRoleIds: ["nope"], memberLimit: 1, totalLimit: 1 }),
      memberRoleIds: ["bad"],
      memberOpenCount: 9,
      categoryOpenCount: 9,
    }),
  );
  assert.equal(result.reason, "BLOCKED");
});

// ── working hours ───────────────────────────────────────────────────────────

test("localTime reads wall clock in the guild's own zone", () => {
  const t = localTime(new Date("2026-08-12T12:00:00.000Z"), "UTC");
  assert.deepEqual(t, { weekday: 3, minutes: 720 });
  // New York is UTC-4 in August, so the same instant is 08:00 the same day.
  assert.deepEqual(localTime(new Date("2026-08-12T12:00:00.000Z"), "America/New_York"), {
    weekday: 3,
    minutes: 480,
  });
});

test("isOpen handles a window that wraps midnight", () => {
  const hours = { "3": { open: "22:00", close: "02:00" } };
  assert.equal(isOpen(hours, new Date("2026-08-12T23:00:00.000Z"), "UTC"), true);
  assert.equal(isOpen(hours, new Date("2026-08-12T01:00:00.000Z"), "UTC"), true);
  assert.equal(isOpen(hours, new Date("2026-08-12T12:00:00.000Z"), "UTC"), false);
});

test("an absent day is closed; an unparseable window fails open", () => {
  assert.equal(isOpen({ "1": { open: "09:00", close: "17:00" } }, NOW, "UTC"), false);
  assert.equal(isOpen({ "3": { open: "nine", close: "five" } }, NOW, "UTC"), true);
});

test("nextOpening walks forward into the following week", () => {
  // Open Mondays only. From Wednesday that is five days away.
  const hours = { "1": { open: "09:00", close: "17:00" } };
  const opens = nextOpening(hours, NOW, "UTC");
  assert.notEqual(opens, null);
  assert.equal(localTime(opens as Date, "UTC").weekday, 1);
  assert.equal(nextOpening({ "3": { open: "13:00", close: "13:00" } }, NOW, "UTC"), null);
});
