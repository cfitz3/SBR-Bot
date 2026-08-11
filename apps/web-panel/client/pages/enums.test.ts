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
  MILESTONE_METRICS as PLATFORM_MILESTONE_METRICS,
  MilestoneType as PlatformMilestoneType,
  TicketCategory as PlatformTicketCategory,
  WordAction as PlatformWordAction,
  WordMatchType as PlatformWordMatchType,
} from "@sbr/shared-types";
import { MILESTONE_METRICS, MilestoneType, TicketCategory, WordAction, WordMatchType } from "./enums.js";

test("the milestone metrics the page offers are the ones the platform defines", () => {
  assert.deepEqual([...MILESTONE_METRICS], [...PLATFORM_MILESTONE_METRICS]);
});

test("every enum copy matches the platform's, in declaration order", () => {
  const cases = [
    ["MilestoneType", MilestoneType, PlatformMilestoneType],
    ["TicketCategory", TicketCategory, PlatformTicketCategory],
    ["WordMatchType", WordMatchType, PlatformWordMatchType],
    ["WordAction", WordAction, PlatformWordAction],
  ] as const;

  for (const [name, mine, platform] of cases) {
    assert.deepEqual(Object.keys(mine), Object.keys(platform), `${name} keys drifted`);
    assert.deepEqual({ ...mine }, { ...platform }, `${name} values drifted`);
  }
});
