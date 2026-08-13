import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_RELAY_SYNC,
  formatGameDuration,
  MAX_GAME_MUTE_SECONDS,
  parseRelaySync,
  resolveGameCommand,
  type RelaySyncPolicy,
} from "./relay-sync.js";

const ign = "Notch";

test("the shipped defaults map a warning to a short mute and a ban to a kick", () => {
  assert.equal(
    resolveGameCommand(DEFAULT_RELAY_SYNC, { type: "WARN", ign, durationSeconds: null }),
    "/g mute Notch 10m",
  );
  assert.equal(
    resolveGameCommand(DEFAULT_RELAY_SYNC, { type: "BAN", ign, durationSeconds: null }),
    "/g kick Notch",
  );
});

test("a same-duration mute mirrors the Discord duration exactly", () => {
  assert.equal(
    resolveGameCommand(DEFAULT_RELAY_SYNC, { type: "MUTE", ign, durationSeconds: 3600 }),
    "/g mute Notch 1h",
  );
});

test("an unbounded mute produces no command rather than a permanent one", () => {
  // Hypixel requires a time argument; inventing one would be this module
  // deciding a punishment length nobody configured.
  assert.equal(resolveGameCommand(DEFAULT_RELAY_SYNC, { type: "MUTE", ign, durationSeconds: null }), null);
});

test("an unlinked target produces no command", () => {
  assert.equal(resolveGameCommand(DEFAULT_RELAY_SYNC, { type: "WARN", ign: null, durationSeconds: null }), null);
  assert.equal(resolveGameCommand(DEFAULT_RELAY_SYNC, { type: "WARN", ign: "  ", durationSeconds: null }), null);
});

test("the master switch silences every row", () => {
  const off: RelaySyncPolicy = { ...DEFAULT_RELAY_SYNC, enabled: false };
  for (const type of ["WARN", "MUTE", "UNMUTE", "BAN"] as const) {
    assert.equal(resolveGameCommand(off, { type, ign, durationSeconds: 60 }), null);
  }
});

test("one disabled row leaves the others alone", () => {
  const policy = parseRelaySync({
    rows: [{ discordAction: "WARN", gameAction: "g mute", durationMode: "fixed", fixedSeconds: 600, enabled: false }],
  });
  assert.equal(resolveGameCommand(policy, { type: "WARN", ign, durationSeconds: null }), null);
  assert.equal(resolveGameCommand(policy, { type: "BAN", ign, durationSeconds: null }), "/g kick Notch");
});

test("actions with no in-game equivalent stay silent", () => {
  assert.equal(resolveGameCommand(DEFAULT_RELAY_SYNC, { type: "KICK", ign, durationSeconds: null }), null);
  assert.equal(resolveGameCommand(DEFAULT_RELAY_SYNC, { type: "UNBAN", ign, durationSeconds: null }), null);
  // Not a mappable action at all.
  assert.equal(resolveGameCommand(DEFAULT_RELAY_SYNC, { type: "NOTE", ign, durationSeconds: null }), null);
});

test("a guild row overrides only its own action", () => {
  const policy = parseRelaySync({
    rows: [{ discordAction: "MUTE", gameAction: "g mute", durationMode: "fixed", fixedSeconds: 300 }],
  });
  // The fixed duration wins over the Discord one it was told to ignore.
  assert.equal(
    resolveGameCommand(policy, { type: "MUTE", ign, durationSeconds: 86_400 }),
    "/g mute Notch 5m",
  );
  assert.equal(resolveGameCommand(policy, { type: "UNMUTE", ign, durationSeconds: null }), "/g unmute Notch");
});

test("unreadable rows fall back to the default for that action", () => {
  const policy = parseRelaySync({ rows: [{ discordAction: "WARN" }, "nonsense", 7] });
  assert.equal(policy.rows.length, DEFAULT_RELAY_SYNC.rows.length);
  assert.equal(resolveGameCommand(policy, { type: "WARN", ign, durationSeconds: null }), "/g mute Notch 10m");
});

test("a fixed-duration mute with no duration is discarded, not stored as zero", () => {
  const policy = parseRelaySync({
    rows: [{ discordAction: "WARN", gameAction: "g mute", durationMode: "fixed", fixedSeconds: 0 }],
  });
  assert.equal(resolveGameCommand(policy, { type: "WARN", ign, durationSeconds: null }), "/g mute Notch 10m");
});

test("a wholly unreadable policy is the default policy", () => {
  assert.deepEqual(parseRelaySync(null), DEFAULT_RELAY_SYNC);
  assert.deepEqual(parseRelaySync("off"), DEFAULT_RELAY_SYNC);
});

test("durations render as the largest whole unit that does not overstate them", () => {
  assert.equal(formatGameDuration(45), "45s");
  assert.equal(formatGameDuration(90 * 60), "90m");
  assert.equal(formatGameDuration(2 * 3600), "2h");
  assert.equal(formatGameDuration(7 * 86_400), "7d");
});

test("a mute longer than Hypixel accepts is clamped rather than refused", () => {
  const clamped = resolveGameCommand(DEFAULT_RELAY_SYNC, {
    type: "MUTE",
    ign,
    durationSeconds: 365 * 86_400,
  });
  assert.equal(clamped, `/g mute Notch ${formatGameDuration(MAX_GAME_MUTE_SECONDS)}`);
});
