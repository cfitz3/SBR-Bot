/**
 * The anti-drift guard for the browser's copy of the link-help limit.
 *
 * Runs under `node --test`, never in a browser, which is why it may import
 * `@sbr/guild-config` when the module it covers may not.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_LINK_HELP_BODY as PLATFORM_MAX_LINK_HELP_BODY } from "@sbr/guild-config";
import { MAX_LINK_HELP_BODY } from "./link-help-limits.js";

test("the editor's cap is the one the policy parser enforces", () => {
  assert.equal(MAX_LINK_HELP_BODY, PLATFORM_MAX_LINK_HELP_BODY);
});
