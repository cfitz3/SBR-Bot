/**
 * What actually reaches Discord's command registry.
 *
 * The two behaviours here are the ones that used to be nobody's job.
 * `deprecatedBy` was honoured at runtime and not at registration, so the picker
 * described a deprecated alias in its own words; and there was no way at all to
 * withdraw a command short of deleting its handler, which is how a retired
 * feature ends up half-removed and half-live.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isRegistrable, toSlashCommand, toSlashCommands } from "./builders.js";
import type { CommandSpecLike } from "./builders.js";

const spec = (over: Partial<CommandSpecLike> = {}): CommandSpecLike => ({
  name: "stats",
  description: "A player's SkyBlock profile at a glance",
  ...over,
});

/** The registration payload, as the plain JSON Discord is actually sent. */
function json(s: CommandSpecLike): { name: string; description: string } {
  return toSlashCommand(s) as { name: string; description: string };
}

test("an ordinary spec registers under its own description", () => {
  assert.equal(json(spec()).description, "A player's SkyBlock profile at a glance");
});

test("a deprecated alias describes itself as one, derived rather than written", () => {
  // Derived from `deprecatedBy` so renaming the replacement cannot leave the
  // picker pointing at a command that no longer exists.
  assert.equal(json(spec({ name: "slayer", deprecatedBy: "slayers" })).description, "Deprecated — use /slayers");
});

test("a description too long for Discord is clamped, deprecation notice included", () => {
  const long = json(spec({ description: "x".repeat(200) }));
  assert.equal(long.description.length, 100);
  const alias = json(spec({ deprecatedBy: "y".repeat(200) }));
  assert.equal(alias.description.length, 100);
});

test("registrability is opt-out: absent means yes, only an explicit false means no", () => {
  assert.equal(isRegistrable(spec()), true);
  assert.equal(isRegistrable(spec({ enabled: true })), true);
  assert.equal(isRegistrable(spec({ enabled: false })), false);
});

test("a disabled spec leaves Discord's registry entirely", () => {
  const registry = new Map<string, CommandSpecLike>([
    ["stats", spec()],
    ["runs", spec({ name: "runs", description: "Open looking-for-group posts", enabled: false })],
    ["help", spec({ name: "help", description: "What I can do" })],
  ]);
  const names = (toSlashCommands(registry) as { name: string }[]).map((c) => c.name);
  // Not "present but erroring": a member who can still see it in the picker
  // reads the refusal as a broken bot rather than as a retired feature.
  assert.deepEqual(names, ["stats", "help"]);
});
