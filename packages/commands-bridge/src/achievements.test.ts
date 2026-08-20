/**
 * `/milestones` rendering: how the achievement model reaches a member.
 *
 * What is being tested is editorial rather than arithmetic — which entries get
 * named, in what grouping, and what is deliberately withheld. The standing
 * itself (who has earned what) is `@sbr/progression`'s job and is not re-checked
 * here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AchievementDTO, AchievementsDTO } from "@sbr/shared-types";
import { renderAchievementsEmbed } from "./render.js";

function ach(overrides: Partial<AchievementDTO> = {}): AchievementDTO {
  return {
    key: "level:100",
    label: "SkyBlock Level 100",
    description: null,
    type: "SKYBLOCK_LEVEL",
    metric: "skyblockLevel",
    threshold: 100,
    xpReward: 0,
    current: 120,
    progress: 1,
    achievedAt: "2026-08-01T00:00:00.000Z",
    tier: "BRONZE",
    icon: null,
    category: "PROGRESSION",
    hidden: false,
    ...overrides,
  };
}

function data(overrides: Partial<AchievementsDTO> = {}): AchievementsDTO {
  return {
    earned: [ach()],
    upcoming: [],
    earnedCount: 1,
    totalCount: 2,
    hiddenLocked: 0,
    xpEarned: 0,
    measuredAt: "2026-08-19T00:00:00.000Z",
    configured: true,
    ...overrides,
  };
}

const fields = (view: { fields?: readonly { name: string; value: string }[] }) => view.fields ?? [];

test("earned achievements are grouped into one field per category", () => {
  const view = renderAchievementsEmbed("Alpha", data({
    earned: [
      ach({ key: "level:100" }),
      ach({ key: "cata:40", label: "Catacombs 40", metric: "catacombsLevel", category: "DUNGEONS" }),
      ach({ key: "cata:30", label: "Catacombs 30", metric: "catacombsLevel", category: "DUNGEONS" }),
    ],
    earnedCount: 3,
    totalCount: 4,
  }));

  const names = fields(view).map((f) => f.name);
  assert.deepEqual(names, ["Progression (1)", "Dungeons (2)"]);
  const dungeons = fields(view)[1];
  assert.ok(dungeons !== undefined && dungeons.value.includes("Catacombs 40"));
  assert.ok(dungeons.value.includes("Catacombs 30"));
});

test("categories keep their reading order rather than the order they were earned", () => {
  const view = renderAchievementsEmbed("Alpha", data({
    earned: [
      ach({ key: "slayer", metric: "slayerXp", category: "SLAYER", label: "Slayer" }),
      ach({ key: "nw", metric: "networth", category: "WEALTH", label: "Rich" }),
    ],
    earnedCount: 2,
  }));
  assert.deepEqual(fields(view).map((f) => f.name), ["Wealth (1)", "Slayer (1)"]);
});

test("the rarest tier in a category is named first", () => {
  const view = renderAchievementsEmbed("Alpha", data({
    earned: [
      ach({ key: "a", label: "Common", tier: "BRONZE" }),
      ach({ key: "b", label: "Rare", tier: "PLATINUM" }),
      ach({ key: "c", label: "Middling", tier: "SILVER" }),
    ],
    earnedCount: 3,
  }));
  const value = fields(view)[0]?.value ?? "";
  assert.ok(value.indexOf("Rare") < value.indexOf("Middling"), value);
  assert.ok(value.indexOf("Middling") < value.indexOf("Common"), value);
});

test("a definition's own icon replaces the tier badge", () => {
  const view = renderAchievementsEmbed("Alpha", data({
    earned: [ach({ icon: "⚔️", tier: "GOLD" })],
  }));
  const value = fields(view)[0]?.value ?? "";
  assert.ok(value.includes("⚔️"), value);
  assert.ok(!value.includes("🥇"), value);
});

test("a long category is truncated with a count of the rest", () => {
  const view = renderAchievementsEmbed("Alpha", data({
    earned: Array.from({ length: 9 }, (_, i) => ach({ key: `k${i}`, label: `Milestone ${i}` })),
    earnedCount: 9,
    totalCount: 9,
  }));
  const value = fields(view)[0]?.value ?? "";
  assert.ok(value.includes("…and 3 more"), value);
  assert.ok(!value.includes("Milestone 8"), value);
});

test("hidden achievements are counted in the tally and never named", () => {
  const view = renderAchievementsEmbed("Alpha", data({
    earned: [],
    upcoming: [],
    earnedCount: 0,
    totalCount: 5,
    hiddenLocked: 2,
  }));
  assert.match(view.description ?? "", /0\/5/);
  assert.match(view.description ?? "", /2 hidden achievements still to find/);
});

test("one hidden achievement is described in the singular", () => {
  const view = renderAchievementsEmbed("Alpha", data({ hiddenLocked: 1 }));
  assert.match(view.description ?? "", /1 hidden achievement still to find/);
});

test("no hidden achievements means no line about them", () => {
  const view = renderAchievementsEmbed("Alpha", data());
  assert.doesNotMatch(view.description ?? "", /hidden/);
});

test("upcoming is capped at four and carries a progress bar", () => {
  const view = renderAchievementsEmbed("Alpha", data({
    earned: [],
    earnedCount: 0,
    totalCount: 6,
    upcoming: Array.from({ length: 6 }, (_, i) =>
      ach({ key: `u${i}`, label: `Next ${i}`, achievedAt: null, progress: 0.5, current: 50 }),
    ),
  }));
  // One placeholder field, the "Up next" separator, then four targets.
  assert.equal(fields(view).length, 1 + 1 + 4);
  assert.ok((fields(view)[2]?.value ?? "").includes("50%"));
});

test("an unmeasured target says so instead of drawing an empty bar", () => {
  const view = renderAchievementsEmbed("Alpha", data({
    earned: [],
    earnedCount: 0,
    upcoming: [ach({ achievedAt: null, progress: null, current: null })],
  }));
  const value = fields(view).at(-1)?.value ?? "";
  assert.match(value, /not measured yet/);
  assert.ok(!value.includes("░"), value);
});

test("achievements switched off is not the same reply as none earned", () => {
  const off = renderAchievementsEmbed("Alpha", data({ configured: false }));
  assert.match(off.description ?? "", /aren't switched on/);
  assert.equal(off.fields, undefined);

  const empty = renderAchievementsEmbed("Alpha", data({ totalCount: 0, earned: [], earnedCount: 0 }));
  assert.match(empty.description ?? "", /hasn't set up any/);
});
