import assert from "node:assert/strict";
import test from "node:test";
import type { ModerationActionDTO } from "@sbr/shared-types";
import {
  describeState,
  holdsEnforcement,
  inForce,
  isInForce,
  punishmentState,
} from "./expiry.js";

const NOW = new Date("2026-03-01T12:00:00.000Z");

function action(over: Partial<ModerationActionDTO> = {}): ModerationActionDTO {
  return {
    id: "a1",
    guildId: "g1",
    type: "MUTE",
    actorDiscordId: "staff",
    targetDiscordId: "member",
    reason: "spam",
    durationSeconds: 3600,
    expiresAt: "2026-03-01T13:00:00.000Z",
    surfaces: ["DISCORD", "GUILD_CHAT"],
    enforcement: "CONFIRMED",
    enforcementDetail: null,
    active: true,
    createdAt: "2026-03-01T11:00:00.000Z",
    ...over,
  };
}

test("a mute with time left is in force", () => {
  assert.equal(punishmentState(action(), NOW), "ACTIVE");
  assert.equal(isInForce(action(), NOW), true);
});

test("a mute whose clock ran out reads expired, whatever the flag still says", () => {
  const stale = action({ expiresAt: "2026-03-01T11:30:00.000Z" });
  assert.equal(punishmentState(stale, NOW), "EXPIRED");
  assert.equal(isInForce(stale, NOW), false);
});

test("expiry wins over the flag once the sweep has cleared it", () => {
  // The sweep clears `active`; the action still ended by expiry, not by hand.
  const swept = action({ expiresAt: "2026-03-01T11:30:00.000Z", active: false });
  assert.equal(punishmentState(swept, NOW), "EXPIRED");
});

test("a still-dated punishment with the flag cleared was lifted by a staffer", () => {
  assert.equal(punishmentState(action({ active: false }), NOW), "LIFTED");
});

test("a permanent ban has no expiry and stays in force", () => {
  const ban = action({ type: "BAN", expiresAt: null, durationSeconds: null });
  assert.equal(punishmentState(ban, NOW), "ACTIVE");
});

test("an expiry exactly now has passed", () => {
  // Ties go to expired: a mute due to lift at 12:00:00 is not still being served
  // at 12:00:00, and the alternative leaves a one-tick window nobody can explain.
  assert.equal(punishmentState(action({ expiresAt: NOW.toISOString() }), NOW), "EXPIRED");
});

test("warns, kicks, notes and role changes hold no enforcement state", () => {
  for (const type of ["WARN", "KICK", "NOTE", "ROLE_CHANGE", "UNMUTE", "UNBAN", "GUILD_EXPEL"] as const) {
    assert.equal(holdsEnforcement(type), false, type);
    assert.equal(punishmentState(action({ type }), NOW), "MOMENTARY", type);
    assert.equal(isInForce(action({ type }), NOW), false, type);
  }
  assert.equal(holdsEnforcement("MUTE"), true);
  assert.equal(holdsEnforcement("BAN"), true);
});

test("a kick flagged active is not something a member is still serving", () => {
  // The row stays active=true forever because nothing lifts a kick; reporting it
  // as a live punishment would put every kick a guild ever issued on the list.
  assert.deepEqual(inForce([action({ type: "KICK", expiresAt: null })], NOW), []);
});

test("inForce keeps only the live rows, in the order given", () => {
  const rows = [
    action({ id: "live", expiresAt: "2026-03-01T18:00:00.000Z" }),
    action({ id: "gone", expiresAt: "2026-03-01T09:00:00.000Z" }),
    action({ id: "perm", type: "BAN", expiresAt: null }),
    action({ id: "lifted", active: false }),
  ];
  assert.deepEqual(
    inForce(rows, NOW).map((r) => r.id),
    ["live", "perm"],
  );
});

test("states describe themselves in words staff use", () => {
  assert.equal(describeState("ACTIVE"), "in force");
  assert.equal(describeState("EXPIRED"), "expired");
  assert.equal(describeState("LIFTED"), "lifted");
  assert.equal(describeState("MOMENTARY"), "");
});
