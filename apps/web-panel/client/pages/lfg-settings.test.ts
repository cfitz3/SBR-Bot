/**
 * The anti-drift guard for the browser's copy of the `/lfg` ping-role key.
 *
 * A key spelled one way by the picker and another by the bot is the worst shape
 * this can fail in: the save succeeds, the page shows the role, and no request
 * ever pings it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { LFG_PING_ROLE_SETTING_KEY } from "@sbr/shared-types";
import { LFG_PING_ROLE_KEY } from "./lfg-settings.js";

test("the picker writes the key the bot reads", () => {
  assert.equal(LFG_PING_ROLE_KEY, LFG_PING_ROLE_SETTING_KEY);
});
