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
import { CONFIG_CHANNEL_SLOTS } from "@sbr/shared-types";
import { CHANNEL_SLOT_COPY } from "./channel-slots.js";

test("the page renders exactly the slots the platform defines, in registry order", () => {
  assert.deepEqual(
    CHANNEL_SLOT_COPY.map((s) => s.slot),
    [...CONFIG_CHANNEL_SLOTS],
  );
});

test("every slot carries copy someone can act on", () => {
  for (const { slot, label, hint } of CHANNEL_SLOT_COPY) {
    assert.ok(label.length > 0, `${slot} has no label`);
    assert.ok(hint.length > 20, `${slot}'s hint says too little`);
  }
});
