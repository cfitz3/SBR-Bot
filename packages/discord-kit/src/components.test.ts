import assert from "node:assert/strict";
import { test } from "node:test";
import type { ButtonInteraction } from "discord.js";
import { ComponentRouter, customId } from "./components.js";

/** Just enough of a ButtonInteraction for the router; it reads customId only. */
function button(id: string): ButtonInteraction {
  return { customId: id, replied: true, deferred: false } as unknown as ButtonInteraction;
}

test("customId joins segments and round-trips through the router", async () => {
  const seen: string[][] = [];
  const router = new ComponentRouter().register("rsvp", async (_i, segments) => {
    seen.push([...segments]);
  });

  const handled = await router.handle(button(customId("rsvp", "evt-1", "GOING")));
  assert.equal(handled, true);
  assert.deepEqual(seen, [["evt-1", "GOING"]]);
});

test("an unclaimed namespace is reported rather than swallowed", async () => {
  const router = new ComponentRouter();
  assert.equal(await router.handle(button("nope:1")), false);
});

test("customId rejects a segment containing the separator", () => {
  // Silently producing an unroutable button would surface as a dead control
  // days later, so this fails at the call site instead.
  assert.throws(() => customId("rsvp", "evt:1"), /must not contain/);
});

test("customId rejects an id Discord would reject", () => {
  assert.throws(() => customId("rsvp", "x".repeat(120)), /exceeds 100/);
});

test("a throwing handler still counts as routed and does not escape", async () => {
  const errors: string[] = [];
  const router = new ComponentRouter({ onError: (ns) => errors.push(ns) }).register("boom", async () => {
    throw new Error("handler exploded");
  });

  assert.equal(await router.handle(button("boom:1")), true);
  assert.deepEqual(errors, ["boom"]);
});
