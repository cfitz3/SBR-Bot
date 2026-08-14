/**
 * The anti-drift guard for the browser's copies of the platform enums.
 *
 * This file runs under `node --test`, never in a browser, which is why it may
 * import `@sbr/shared-types` when the modules it covers may not.
 *
 * Key *order* is asserted, not just membership: the pages build their option
 * lists with `Object.keys`, so a value appended here but prepended upstream
 * would render a dropdown whose order disagrees with every other surface.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BridgeCapability as PlatformBridgeCapability,
  MILESTONE_METRICS as PLATFORM_MILESTONE_METRICS,
  MilestoneType as PlatformMilestoneType,
  WordAction as PlatformWordAction,
  WordMatchType as PlatformWordMatchType,
} from "@sbr/shared-types";
import { BridgeCapability, MILESTONE_METRICS, MilestoneType, WordAction, WordMatchType } from "./enums.js";

test("the milestone metrics the page offers are the ones the platform defines", () => {
  assert.deepEqual([...MILESTONE_METRICS], [...PLATFORM_MILESTONE_METRICS]);
});

test("every enum copy matches the platform's, in declaration order", () => {
  const cases = [
    ["MilestoneType", MilestoneType, PlatformMilestoneType],
    ["WordMatchType", WordMatchType, PlatformWordMatchType],
    ["WordAction", WordAction, PlatformWordAction],
    ["BridgeCapability", BridgeCapability, PlatformBridgeCapability],
  ] as const;

  for (const [name, mine, platform] of cases) {
    assert.deepEqual(Object.keys(mine), Object.keys(platform), `${name} keys drifted`);
    assert.deepEqual({ ...mine }, { ...platform }, `${name} values drifted`);
  }
});
