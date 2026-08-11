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

test("malformed input is refused rather than thrown out of", () => {
  // One bad entry must not abort a login over the other guilds in the list.
  for (const bad of ["", "  ", "not-a-number", "12.5", null, undefined, 32, {}, []]) {
    assert.equal(canManageGuild(bad), false, `${JSON.stringify(bad)} should be refused`);
  }
});

test("a negative bitfield is refused instead of read as two's complement", () => {
  // `BigInt("-1") & 0x20n` is 0x20n — a value that means nothing would pass.
  assert.equal(canManageGuild("-1"), false);
});
