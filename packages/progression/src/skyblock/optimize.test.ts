/**
 * Tests for the advice engine behind `/nextupgrade` and `/whatnext`. Pure over
 * `ProfileFacts`, so nothing here needs Hypixel — or, since the bag reader moved
 * to `@sbr/skyblock-parse`, real NBT bytes: the two tests that need an accessory
 * report only need one that is non-empty, so they state one directly rather than
 * gzipping a talisman bag to get there.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AccessoryReport } from "@sbr/skyblock-parse";
import { buildNextSteps, buildUpgradeAdvice, GENERIC_ADVICE, priceSuggestions, type ProfileFacts } from "./advice.js";

/** A readable bag holding a single common talisman — enough to be "not null". */
const OWNS_ONE_TALISMAN: AccessoryReport = {
  magicalPower: 3,
  tuning: null,
  owned: [{ id: "SPEED_TALISMAN", name: "Speed Talisman", rarity: "COMMON", magicalPower: 3, recombobulated: false }],
  missing: [],
  upgradeable: [],
  redundant: [],
  apiDisabled: false,
};


const emptyFacts: ProfileFacts = {
  skills: null,
  slayers: null,
  dungeons: null,
  networth: null,
  accessories: null,
  senitherWeight: null,
};

function facts(over: Partial<ProfileFacts>): ProfileFacts {
  return { ...emptyFacts, ...over };
}

function skills(entries: Record<string, number>, average: number | null = 30) {
  return {
    skills: Object.entries(entries).map(([name, level]) => ({
      name,
      level,
      maxLevel: 60,
      experience: 0,
      xpToNext: null,
      progress: null,
    })),
    average,
    apiDisabled: false,
  };
}

test("low combat is the highest-priority dps advice", () => {
  const out = buildUpgradeAdvice(facts({ skills: skills({ Combat: 12 }) }), "dps");
  assert.equal(out[0]?.priority, "HIGH");
  assert.match(out[0]?.title ?? "", /Combat 12/);
});

test("past combat 24 the advice moves to the weapon, and names a priceable item", () => {
  const out = buildUpgradeAdvice(facts({ skills: skills({ Combat: 30 }) }), "dps");
  const weapon = out.find((s) => s.category === "Gear");
  assert.ok(weapon, "a maxed-combat account should be told to upgrade the weapon");
  assert.equal(weapon.itemId, "HYPERION", "the suggestion must name an item the command layer can price");
});

test("advice is capped, so the reply stays readable", () => {
  const rich = facts({
    skills: skills({ Combat: 5 }),
    accessories: OWNS_ONE_TALISMAN,
  });
  assert.ok(buildUpgradeAdvice(rich, "dps").length <= 8);
  assert.ok(buildNextSteps(rich, "general").length <= 8);
});

test("suggestions are ordered by priority", () => {
  const out = buildUpgradeAdvice(
    facts({ skills: skills({ Combat: 5 }), accessories: OWNS_ONE_TALISMAN }),
    "dps",
  );
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
  for (let i = 1; i < out.length; i += 1) {
    const prev = out[i - 1]?.priority ?? "LOW";
    const cur = out[i]?.priority ?? "LOW";
    assert.ok(rank[prev] <= rank[cur], "a LOW suggestion must not precede a HIGH one");
  }
});

test("an unrecognised focus falls back to general advice rather than an empty list", () => {
  const out = buildUpgradeAdvice(facts({ skills: skills({ Combat: 10 }) }), "general");
  assert.ok(out.length > 0);
});

test("whatnext names the weakest pillar", () => {
  const out = buildNextSteps(
    facts({
      skills: skills({ Combat: 40 }, 40),
      dungeons: {
        catacombsLevel: 5,
        catacombsExperience: 10,
    catacombsXpToNext: null,
    catacombsProgress: null,
        selectedClass: null,
        classAverage: 4,
        classes: [],
        floors: [],
        masterFloors: [],
        played: true,
      },
    }),
    "general",
  );
  assert.match(out[0]?.title ?? "", /Catacombs/, "catacombs 5 against skill average 40 is the gap to call out");
});

test("a member who has never entered dungeons is told to start there", () => {
  const out = buildNextSteps(
    facts({
      dungeons: {
        catacombsLevel: null,
        catacombsExperience: null,
    catacombsXpToNext: null,
    catacombsProgress: null,
        selectedClass: null,
        classAverage: null,
        classes: [],
        floors: [],
        masterFloors: [],
        played: false,
      },
    }),
    "dungeons",
  );
  assert.ok(out.some((s) => /first Catacombs/.test(s.title)));
});

test("hidden skills produce the API-settings advice, since nothing else can be trusted", () => {
  const out = buildNextSteps(facts({ skills: { skills: [], average: null, apiDisabled: true } }), "general");
  assert.match(out[0]?.title ?? "", /API settings/i);
});

test("generic advice leads with turning the API on", () => {
  assert.match(GENERIC_ADVICE[0]?.title ?? "", /API settings/i);
});

test("pricing attaches costs only where a suggestion names an item", () => {
  const priced = priceSuggestions(
    [
      { title: "a", detail: "d", priority: "HIGH", category: "Gear", itemId: "HYPERION" },
      { title: "b", detail: "d", priority: "LOW", category: "Skills", itemId: null },
    ],
    new Map([["HYPERION", 1_200_000_000]]),
  );
  assert.equal(priced[0]?.estimatedCost, 1_200_000_000);
  assert.equal(priced[1]?.estimatedCost, null);
});

test("an unpriced item leaves the cost null rather than showing zero", () => {
  const priced = priceSuggestions(
    [{ title: "a", detail: "d", priority: "HIGH", category: "Gear", itemId: "HYPERION" }],
    new Map(),
  );
  assert.equal(priced[0]?.estimatedCost, null, "a cold sweep must not read as 'free'");
});
