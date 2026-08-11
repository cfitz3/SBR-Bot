import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMINISTRATOR, MANAGE_GUILD, canManageGuild } from "./permissions.js";

test("Manage Server alone is enough", () => {
  assert.equal(canManageGuild(MANAGE_GUILD.toString()), true);
});

test("Administrator alone is enough, because Discord never expands it", () => {
  // The regression this file exists for: a role with Administrator checked and
  // Manage Server unchecked. Discord's own UI lets this person manage the
  // guild; testing 0x20 alone would drop them, and the panel would show an
  // empty selector that reads as "the platform doesn't know this guild".
  assert.equal(canManageGuild(ADMINISTRATOR.toString()), true);
});

test("an ordinary member is refused", () => {
  // Send Messages | Read History — a normal member's permissions.
  assert.equal(canManageGuild((0x800n | 0x10000n).toString()), false);
  assert.equal(canManageGuild("0"), false);
});

test("a realistic administrator bitfield is accepted", () => {
  // What Discord actually sends a guild owner: every bit set.
  assert.equal(canManageGuild("4398046511103"), true);
});

test("a numeric bitfield is read, not refused for not being a string", () => {
  // What an unversioned request to /users/@me/guilds actually came back with,
  // and the reason every guild vanished from the selector: 25 guilds returned,
  // 0 past the gate, because the guard tested the JSON type before the bits.
  assert.equal(canManageGuild(0x20), true);
  assert.equal(canManageGuild(0x8), true);
  assert.equal(canManageGuild(0x800 | 0x10000), false);
  assert.equal(canManageGuild(0), false);
});

test("a number that JSON could not carry exactly is refused", () => {
  // Past 2^53 the parsed value is not the value Discord sent — some bit is
  // already wrong, so testing it answers a question about a different number.
  assert.equal(canManageGuild(2 ** 53), false);
  assert.equal(canManageGuild(12.5), false);
  assert.equal(canManageGuild(Number.NaN), false);
  assert.equal(canManageGuild(Number.POSITIVE_INFINITY), false);
  assert.equal(canManageGuild(-32), false);
});

test("malformed input is refused rather than thrown out of", () => {
  // One bad entry must not abort a login over the other guilds in the list.
  for (const bad of ["", "  ", "not-a-number", "12.5", null, undefined, {}, [], true]) {
    assert.equal(canManageGuild(bad), false, `${JSON.stringify(bad)} should be refused`);
  }
});

test("a negative bitfield is refused instead of read as two's complement", () => {
  // `BigInt("-1") & 0x20n` is 0x20n — a value that means nothing would pass.
  assert.equal(canManageGuild("-1"), false);
});
