import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_RELAY_SYNC,
  formatGameDuration,
  MAX_GAME_MUTE_SECONDS,
  MAX_GAME_REASON_LENGTH,
  parseRelaySync,
  resolveGameCommand,
  sanitizeGameReason,
  type GameCommandPlan,
  type RelaySyncPolicy,
} from "./relay-sync.js";
import type { ModActionType } from "@sbr/shared-types";

const ign = "Notch";
const reason = "Ban evasion";

/** The plan for one action, with the reason most of these cases do not care about. */
function plan(
  policy: RelaySyncPolicy,
  input: { type: ModActionType; ign?: string | null; durationSeconds?: number | null; reason?: string },
): GameCommandPlan {
  return resolveGameCommand(policy, {
    type: input.type,
    ign: input.ign === undefined ? ign : input.ign,
    durationSeconds: input.durationSeconds ?? null,
    reason: input.reason ?? reason,
  });
}

/** The line that would be typed, or null when nothing would be. */
function line(
  policy: RelaySyncPolicy,
  input: { type: ModActionType; ign?: string | null; durationSeconds?: number | null; reason?: string },
): string | null {
  const p = plan(policy, input);
  return p.kind === "send" ? p.command : null;
}

test("the shipped defaults map a warning to a short mute and a ban to a kick", () => {
  assert.equal(line(DEFAULT_RELAY_SYNC, { type: "WARN" }), "/g mute Notch 10m");
  assert.equal(line(DEFAULT_RELAY_SYNC, { type: "BAN" }), "/g kick Notch Ban evasion");
});

test("a kick carries its reason and a mute does not", () => {
  // Hypixel reads `/g mute <name> <time>` and nothing else; a reason appended
  // there is parsed as part of the duration and the mute is refused.
  assert.equal(line(DEFAULT_RELAY_SYNC, { type: "BAN", reason: "Alt account" }), "/g kick Notch Alt account");
  assert.equal(line(DEFAULT_RELAY_SYNC, { type: "MUTE", durationSeconds: 3600 }), "/g mute Notch 1h");
});

test("a kick with nothing sendable in its reason is blocked, not skipped", () => {
  const p = plan(DEFAULT_RELAY_SYNC, { type: "BAN", reason: "🚫🚫🚫" });
  assert.equal(p.kind, "blocked");
  assert.match(p.kind === "blocked" ? p.why : "", /reason/);
});

test("a reason is stripped down to what guild chat will carry", () => {
  assert.equal(sanitizeGameReason("Ban evasion — see #mod-log"), "Ban evasion see mod-log");
  // A leading slash would turn the reason into a second command.
  assert.equal(sanitizeGameReason("/gc hello"), "gc hello");
  assert.equal(sanitizeGameReason("two\nlines"), "two lines");
  assert.equal(sanitizeGameReason("   "), null);
  assert.equal(sanitizeGameReason("🙂"), null);
});

test("an over-long reason is truncated rather than refused", () => {
  const long = sanitizeGameReason("word ".repeat(40));
  assert.ok(long !== null);
  assert.ok(long.length <= MAX_GAME_REASON_LENGTH);
  assert.doesNotMatch(long, /\s$/);
});

test("a same-duration mute mirrors the Discord duration exactly", () => {
  assert.equal(line(DEFAULT_RELAY_SYNC, { type: "MUTE", durationSeconds: 3600 }), "/g mute Notch 1h");
});

test("an unbounded mute is blocked rather than sent as a permanent one", () => {
  // Hypixel requires a time argument; inventing one would be this module
  // deciding a punishment length nobody configured. Blocked, not skipped: the
  // mapping said to mute and no mute happened.
  assert.equal(plan(DEFAULT_RELAY_SYNC, { type: "MUTE", durationSeconds: null }).kind, "blocked");
});

test("an unlinked target skips, and says which kind of nothing it was", () => {
  // Not a failure: nobody verified an account, so there is no guild slot to
  // take. The reason still names the cause, so the card does not read as though
  // the mapping simply had no opinion.
  for (const missing of [null, "  "]) {
    const p = plan(DEFAULT_RELAY_SYNC, { type: "BAN", ign: missing });
    assert.equal(p.kind, "skip");
    assert.match(p.kind === "skip" ? p.why : "", /linked Minecraft account/);
  }
});

test("the master switch silences every row", () => {
  const off: RelaySyncPolicy = { ...DEFAULT_RELAY_SYNC, enabled: false };
  for (const type of ["WARN", "MUTE", "UNMUTE", "BAN"] as const) {
    assert.equal(plan(off, { type, durationSeconds: 60 }).kind, "skip");
  }
});

test("one disabled row leaves the others alone", () => {
  const policy = parseRelaySync({
    rows: [{ discordAction: "WARN", gameAction: "g mute", durationMode: "fixed", fixedSeconds: 600, enabled: false }],
  });
  assert.equal(plan(policy, { type: "WARN" }).kind, "skip");
  assert.equal(line(policy, { type: "BAN" }), "/g kick Notch Ban evasion");
});

test("actions with no in-game equivalent skip rather than block", () => {
  assert.equal(plan(DEFAULT_RELAY_SYNC, { type: "KICK" }).kind, "skip");
  assert.equal(plan(DEFAULT_RELAY_SYNC, { type: "UNBAN" }).kind, "skip");
  // Not a mappable action at all.
  assert.equal(plan(DEFAULT_RELAY_SYNC, { type: "NOTE" }).kind, "skip");
});

test("a guild row overrides only its own action", () => {
  const policy = parseRelaySync({
    rows: [{ discordAction: "MUTE", gameAction: "g mute", durationMode: "fixed", fixedSeconds: 300 }],
  });
  // The fixed duration wins over the Discord one it was told to ignore.
  assert.equal(line(policy, { type: "MUTE", durationSeconds: 86_400 }), "/g mute Notch 5m");
  assert.equal(line(policy, { type: "UNMUTE" }), "/g unmute Notch");
});

test("unreadable rows fall back to the default for that action", () => {
  const policy = parseRelaySync({ rows: [{ discordAction: "WARN" }, "nonsense", 7] });
  assert.equal(policy.rows.length, DEFAULT_RELAY_SYNC.rows.length);
  assert.equal(line(policy, { type: "WARN" }), "/g mute Notch 10m");
});

test("a fixed-duration mute with no duration is discarded, not stored as zero", () => {
  const policy = parseRelaySync({
    rows: [{ discordAction: "WARN", gameAction: "g mute", durationMode: "fixed", fixedSeconds: 0 }],
  });
  assert.equal(line(policy, { type: "WARN" }), "/g mute Notch 10m");
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
  const clamped = line(DEFAULT_RELAY_SYNC, { type: "MUTE", durationSeconds: 365 * 86_400 });
  assert.equal(clamped, `/g mute Notch ${formatGameDuration(MAX_GAME_MUTE_SECONDS)}`);
});
