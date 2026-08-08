import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDungeons, parseSkills, parseSlayers } from "./parse.js";
import { senitherWeight } from "./weight.js";
import { CATACOMBS_XP, RUNECRAFTING_XP, SKILL_XP, levelFromXp, slayerTier } from "./xp.js";

// ── Tables ──────────────────────────────────────────────────────────────────
// These pin the published totals. A single mistyped increment shifts a total and
// fails here rather than silently reporting the wrong level to a member.

test("the skill curve matches the published level 50 and 60 totals", () => {
  assert.equal(SKILL_XP[49], 55_172_425);
  assert.equal(SKILL_XP[59], 111_672_425);
});

test("the catacombs curve matches the published level 50 total", () => {
  assert.equal(CATACOMBS_XP[49], 569_809_640);
});

test("runecrafting caps at 25 with its own flatter curve", () => {
  assert.equal(RUNECRAFTING_XP.length, 25);
  assert.equal(RUNECRAFTING_XP[24], 92_400);
});

test("a level lookup reports the level, remaining xp and progress", () => {
  const r = levelFromXp(SKILL_XP, 50, 60);
  assert.equal(r.level, 1);
  assert.equal(r.xpToNext, 125);
  assert.equal(r.progress, 0);
});

test("mid-level progress is the fraction through the current level", () => {
  // 50 xp reaches level 1; level 2 costs a further 125.
  const r = levelFromXp(SKILL_XP, 50 + 62.5, 60);
  assert.equal(r.level, 1);
  assert.equal(r.progress, 0.5);
});

test("a capped skill reports no next level rather than continuing", () => {
  const r = levelFromXp(SKILL_XP, 999_999_999, 50);
  assert.equal(r.level, 50);
  assert.equal(r.xpToNext, null);
  assert.equal(r.progress, 1);
});

test("the same curve stops at 50 for a 50-cap skill and 60 for a 60-cap one", () => {
  assert.equal(levelFromXp(SKILL_XP, 111_672_425, 50).level, 50);
  assert.equal(levelFromXp(SKILL_XP, 111_672_425, 60).level, 60);
});

test("zero experience is level 0, not level 1", () => {
  assert.equal(levelFromXp(SKILL_XP, 0, 60).level, 0);
});

test("slayer tiers ladder on thresholds and vampire caps at 5", () => {
  assert.deepEqual(slayerTier("zombie", 1_000_000), { tier: 9, maxTier: 9 });
  assert.deepEqual(slayerTier("zombie", 4), { tier: 0, maxTier: 9 });
  assert.deepEqual(slayerTier("vampire", 2_400), { tier: 5, maxTier: 5 });
});

// ── Parsing ─────────────────────────────────────────────────────────────────

test("skills parse from the modern player_data shape", () => {
  const skills = parseSkills({
    player_data: { experience: { SKILL_MINING: 55_172_425, SKILL_COMBAT: 50 } },
  });
  const mining = skills.skills.find((s) => s.name === "Mining");
  assert.equal(mining?.level, 50);
  assert.equal(skills.apiDisabled, false);
});

test("skills still parse from the legacy top-level shape", () => {
  const skills = parseSkills({ experience_skill_mining: 55_172_425 });
  assert.equal(skills.skills.find((s) => s.name === "Mining")?.level, 50);
});

test("a hidden skill is null rather than level 0", () => {
  const skills = parseSkills({ player_data: { experience: { SKILL_MINING: 100 } } });
  const combat = skills.skills.find((s) => s.name === "Combat");
  assert.equal(combat?.level, null);
  assert.equal(combat?.experience, null);
});

test("a profile with the skill API off is flagged, with a null average", () => {
  const skills = parseSkills({});
  assert.equal(skills.apiDisabled, true);
  assert.equal(skills.average, null);
});

test("skill average excludes the cosmetic skills", () => {
  // Two counted skills at 50 and 0, plus Runecrafting at 25 which must not count.
  const skills = parseSkills({
    player_data: {
      experience: { SKILL_MINING: 55_172_425, SKILL_COMBAT: 0, SKILL_RUNECRAFTING: 92_400 },
    },
  });
  assert.equal(skills.average, 25);
});

test("slayer kills are re-keyed from Hypixel's 0-based tiers to the player's 1-based ones", () => {
  const slayers = parseSlayers({
    slayer: { slayer_bosses: { zombie: { xp: 400_000, boss_kills_tier_4: 120 } } },
  });
  const zombie = slayers.bosses[0];
  assert.equal(zombie?.tier, 8);
  assert.equal(zombie?.kills["5"], 120);
  assert.equal(slayers.totalExperience, 400_000);
});

test("dungeons parse levels, classes and floor completions", () => {
  const dungeons = parseDungeons({
    dungeons: {
      selected_dungeon_class: "berserk",
      dungeon_types: {
        catacombs: {
          experience: 569_809_640,
          tier_completions: { "7": 210, "1": 5 },
          fastest_time_s_plus: { "7": 220_000 },
        },
      },
      player_classes: { berserk: { experience: 569_809_640 } },
    },
  });
  assert.equal(dungeons.catacombsLevel, 50);
  assert.equal(dungeons.selectedClass, "berserk");
  assert.equal(dungeons.played, true);
  // Floors sort numerically, not lexicographically.
  assert.deepEqual(dungeons.floors.map((f) => f.floor), ["1", "7"]);
  assert.equal(dungeons.floors[1]?.fastestSPlusMs, 220_000);
  assert.equal(dungeons.floors[0]?.fastestSPlusMs, null);
});

test("a player who has never entered a dungeon reports not-played, not level 0", () => {
  const dungeons = parseDungeons({ player_data: {} });
  assert.equal(dungeons.played, false);
  assert.equal(dungeons.catacombsLevel, null);
});

// ── Weight ──────────────────────────────────────────────────────────────────

test("weight is null when there is nothing readable, not zero", () => {
  const member = {};
  assert.equal(
    senitherWeight(parseSkills(member), parseSlayers(member), parseDungeons(member)),
    null,
  );
});

test("weight rises with progress", () => {
  const low = { player_data: { experience: { SKILL_MINING: 1_000_000 } } };
  const high = { player_data: { experience: { SKILL_MINING: 55_172_425 } } };
  const w = (m: unknown) => senitherWeight(parseSkills(m), parseSlayers(m), parseDungeons(m)) ?? 0;
  assert.ok(w(high) > w(low), "a maxed skill must outweigh a partial one");
});

test("slayer overflow past a million is taxed rather than counted linearly", () => {
  const one = parseSlayers({ slayer: { slayer_bosses: { zombie: { xp: 1_000_000 } } } });
  const two = parseSlayers({ slayer: { slayer_bosses: { zombie: { xp: 2_000_000 } } } });
  const empty = parseSkills({});
  const none = parseDungeons({});
  const a = senitherWeight(empty, one, none) ?? 0;
  const b = senitherWeight(empty, two, none) ?? 0;
  assert.ok(b > a, "more xp must weigh more");
  assert.ok(b < a * 2, "but the second million must be worth less than the first");
});
