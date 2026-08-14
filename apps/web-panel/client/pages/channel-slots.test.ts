/**
 * The anti-drift guard for the browser's copy of the channel slot registry.
 *
 * This file runs under `node --test`, never in a browser, which is why it may
 * import `@sbr/shared-types` when the module it covers may not. A slot the API
 * accepts with no control on the page is invisible config; a control for a slot
 * the API rejects saves into an error. Both are caught here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { copy } from "@sbr/brand";
import { CONFIG_CHANNEL_SLOTS } from "@sbr/shared-types";
import { CHANNEL_SLOT_ORDER } from "./channel-slots.js";

test("the page renders exactly the slots the platform defines, in registry order", () => {
  assert.deepEqual([...CHANNEL_SLOT_ORDER], [...CONFIG_CHANNEL_SLOTS]);
});

test("every slot carries copy someone can act on", () => {
  // The words come from the brand layer now, so this reads the resolved table
  // rather than the page: an override that empties a hint is as broken as a
  // default that never had one.
  for (const slot of CHANNEL_SLOT_ORDER) {
    const entry = copy.panel.channelSlot[slot];
    assert.ok(entry.label.length > 0, `${slot} has no label`);
    assert.ok(entry.hint.length > 20, `${slot}'s hint says too little`);
  }
});
