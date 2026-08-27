import assert from "node:assert/strict";
import { test } from "node:test";
import type { LockdownStateDTO, SafetyStatusDTO } from "@sbr/shared-types";
import {
  LOCKDOWN_REASON_MAX,
  lockdownId,
  parseLockdownId,
  renderLockdownControls,
  renderLockdownEmbed,
  trimLockdownReason,
} from "./render.js";

const NOW = new Date("2026-03-01T12:00:00.000Z");

function lock(over: Partial<LockdownStateDTO> = {}): LockdownStateDTO {
  return {
    guildId: "g1",
    scope: "SERVER",
    channelId: null,
    reason: "raid",
    actorDiscordId: "200000000000000001",
    startedAt: "2026-03-01T11:50:00.000Z",
    expiresAt: null,
    lockedChannelIds: ["c1"],
    ...over,
  };
}

const status = (l: LockdownStateDTO | null): SafetyStatusDTO => ({ lockdown: l, antiRaid: null });
const prompt = { channelId: "300000000000000001", duration: "30m", reason: "raid" };

test("a customId round-trips, so the click means what the card said", () => {
  const id = lockdownId("server", prompt);
  assert.deepEqual(parseLockdownId(id.split(":").slice(1)), { action: "server", ...prompt });
});

test("a reason containing a colon survives the round trip", () => {
  // The reason is the last segment and is rejoined from the remainder, because
  // a staffer typing "raid: alt accounts" should not silently lose half of it.
  const id = lockdownId("channel", { ...prompt, reason: "raid: alt accounts" });
  assert.equal(parseLockdownId(id.split(":").slice(1))?.reason, "raid: alt accounts");
});

test("an absent channel and duration round-trip as absent, not as a dash", () => {
  const id = lockdownId("lift", { channelId: null, duration: null, reason: "" });
  assert.deepEqual(parseLockdownId(id.split(":").slice(1)), {
    action: "lift",
    channelId: null,
    duration: null,
    reason: "",
  });
});

test("a control from some other feature is not claimed", () => {
  assert.equal(parseLockdownId(["explode", "-", "-", ""]), null);
  assert.equal(parseLockdownId([]), null);
});

test("the reason is trimmed to what a customId can carry, with the widest id still fitting", () => {
  const trimmed = trimLockdownReason("y".repeat(200));
  assert.equal(trimmed.length, LOCKDOWN_REASON_MAX);
  const widest = lockdownId("channel", { channelId: "300000000000000001", duration: "30m", reason: trimmed });
  assert.ok(widest.length <= 100, `customId was ${widest.length}`);
});

test("the prompt says what will shut and what will not", () => {
  const view = renderLockdownEmbed(status(null), { ...prompt, now: NOW });
  assert.equal(view.color, "WARNING");
  assert.match(view.description ?? "", /Nothing is locked/);
  const detail = view.fields?.[0]?.value ?? "";
  assert.match(detail, /Channels already shut stay shut/);
  assert.equal(view.fields?.length, 1, "one consolidated field, not five one-word ones");
  assert.equal(view.timestamp, NOW.toISOString());
});

test("a live lock is dated from when it started, not from when the card was drawn", () => {
  const view = renderLockdownEmbed(status(lock()), { ...prompt, now: NOW });
  assert.equal(view.timestamp, "2026-03-01T11:50:00.000Z");
  assert.equal(view.color, "DANGER");
});

test("a lock with no expiry says so rather than leaving the line blank", () => {
  const view = renderLockdownEmbed(status(lock()), { ...prompt, now: NOW });
  assert.match(view.fields?.[0]?.value ?? "", /only when a staffer ends it/);
});

test("an absorbed channel lock is named, so the staffer who set it can see where it went", () => {
  const view = renderLockdownEmbed(status(lock({ absorbedChannelId: "c9" })), { ...prompt, now: NOW });
  assert.match(view.fields?.[0]?.value ?? "", /<#c9>/);
});

test("a notice leads the description rather than hiding in the footer", () => {
  // The footer is for static notes. What just happened is the headline.
  const view = renderLockdownEmbed(status(null), { ...prompt, notice: "Lifted.", now: NOW });
  assert.match(view.description ?? "", /^Lifted\./);
  assert.equal(view.footer, undefined);
});
