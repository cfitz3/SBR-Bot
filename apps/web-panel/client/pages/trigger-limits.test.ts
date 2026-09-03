/**
 * The anti-drift guard for the browser's copy of the trigger limits.
 *
 * Runs under `node --test`, never in a browser, which is why it may import
 * `@sbr/triggers` when the module it covers may not.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_PATTERN_LENGTH as PLATFORM_MAX_PATTERN_LENGTH,
  MAX_REACTION_THRESHOLD as PLATFORM_MAX_REACTION_THRESHOLD,
  MAX_REPLY_LENGTH as PLATFORM_MAX_REPLY_LENGTH,
  MAX_TRIGGER_RULES as PLATFORM_MAX_TRIGGER_RULES,
  MIN_REACTION_THRESHOLD as PLATFORM_MIN_REACTION_THRESHOLD,
} from "@sbr/triggers";
import {
  MAX_PATTERN_LENGTH,
  MAX_REACTION_THRESHOLD,
  MAX_REPLY_LENGTH,
  MAX_TRIGGER_RULES,
  MIN_REACTION_THRESHOLD,
} from "./trigger-limits.js";

test("every limit the editor enforces is the one the validator enforces", () => {
  assert.deepEqual(
    [MAX_TRIGGER_RULES, MIN_REACTION_THRESHOLD, MAX_REACTION_THRESHOLD, MAX_PATTERN_LENGTH, MAX_REPLY_LENGTH],
    [
      PLATFORM_MAX_TRIGGER_RULES,
      PLATFORM_MIN_REACTION_THRESHOLD,
      PLATFORM_MAX_REACTION_THRESHOLD,
      PLATFORM_MAX_PATTERN_LENGTH,
      PLATFORM_MAX_REPLY_LENGTH,
    ],
  );
});
