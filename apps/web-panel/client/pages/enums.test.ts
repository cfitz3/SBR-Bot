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
  ACHIEVEMENT_CATEGORIES as PLATFORM_ACHIEVEMENT_CATEGORIES,
  ACHIEVEMENT_TIERS as PLATFORM_ACHIEVEMENT_TIERS,
  BridgeCapability as PlatformBridgeCapability,
  COMMUNITY_MILESTONE_METRICS as PLATFORM_COMMUNITY_METRICS,
  categoryOfMetric,
  MILESTONE_METRICS as PLATFORM_MILESTONE_METRICS,
  MilestoneType as PlatformMilestoneType,
  TAG_SCOPES as PLATFORM_TAG_SCOPES,
  WordAction as PlatformWordAction,
  WordMatchType as PlatformWordMatchType,
} from "@sbr/shared-types";
import {
  ACHIEVEMENT_CATEGORIES,
  ACHIEVEMENT_TIERS,
  BridgeCapability,
  CATEGORY_OF_METRIC,
  COMMUNITY_MILESTONE_METRICS,
  MILESTONE_METRICS,
  MilestoneType,
  TagScope,
  WordAction,
  WordMatchType,
} from "./enums.js";

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

test("the tag scopes the page offers are the ones the platform defines, in order", () => {
  assert.deepEqual(Object.keys(TagScope), [...PLATFORM_TAG_SCOPES]);
});

test("the community subset the page treats specially is the platform's", () => {
  assert.deepEqual([...COMMUNITY_MILESTONE_METRICS], [...PLATFORM_COMMUNITY_METRICS]);
});

test("the achievement categories and tiers the page groups by are the platform's", () => {
  assert.deepEqual([...ACHIEVEMENT_CATEGORIES], [...PLATFORM_ACHIEVEMENT_CATEGORIES]);
  assert.deepEqual([...ACHIEVEMENT_TIERS], [...PLATFORM_ACHIEVEMENT_TIERS]);
});

test("every metric groups into the same family the platform puts it in", () => {
  for (const metric of PLATFORM_MILESTONE_METRICS) {
    assert.equal(CATEGORY_OF_METRIC[metric], categoryOfMetric(metric), `${metric} grouped differently`);
  }
  // And nothing extra: a stale entry left behind after a metric is renamed
  // would group nothing and look harmless right up until it didn't.
  assert.deepEqual(Object.keys(CATEGORY_OF_METRIC).sort(), [...PLATFORM_MILESTONE_METRICS].sort());
});
