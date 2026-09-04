/**
 * Skyblock experience tables and the level lookup built on them.
 *
 * Hypixel publishes cumulative XP only implicitly — the profile carries a raw
 * experience total and every consumer is expected to know the curve. These are
 * the per-level *increments*; the cumulative tables are derived once at module
 * load so a lookup is a binary-free linear scan over at most 60 entries.
 *
 * Numbers here are load-bearing: a wrong entry silently reports the wrong level
 * with full confidence. `xp.test.ts` pins the published totals (skill 50 =
 * 55,172,425 and skill 60 = 111,672,425) so a typo fails the build.
 */

/** Increment to reach each level, index 0 ⇒ level 1. Shared by all 60-cap skills. */
const SKILL_INCREMENTS = [
  50, 125, 200, 300, 500, 750, 1_000, 1_500, 2_000, 3_500,
  5_000, 7_500, 10_000, 15_000, 20_000, 30_000, 50_000, 75_000, 100_000, 200_000,
  300_000, 400_000, 500_000, 600_000, 700_000, 800_000, 900_000, 1_000_000, 1_100_000, 1_200_000,
  1_300_000, 1_400_000, 1_500_000, 1_600_000, 1_700_000, 1_800_000, 1_900_000, 2_000_000, 2_100_000, 2_200_000,
  2_300_000, 2_400_000, 2_500_000, 2_600_000, 2_750_000, 2_900_000, 3_100_000, 3_400_000, 3_700_000, 4_000_000,
  4_300_000, 4_600_000, 4_900_000, 5_200_000, 5_500_000, 5_800_000, 6_100_000, 6_400_000, 6_700_000, 7_000_000,
] as const;

/** Runecrafting has its own, much flatter curve and caps at 25. */
const RUNECRAFTING_INCREMENTS = [
  50, 100, 125, 160, 200, 250, 315, 400, 500, 625,
  785, 1_000, 1_250, 1_575, 1_970, 2_470, 3_100, 3_875, 4_850, 6_100,
  7_600, 9_500, 11_900, 14_900, 18_800,
] as const;

/** Social is profile-wide rather than per-member, and also caps at 25. */
const SOCIAL_INCREMENTS = [
  50, 100, 150, 250, 500, 750, 1_000, 1_250, 1_500, 2_000,
  2_500, 3_000, 3_750, 4_500, 6_000, 8_000, 10_000, 12_500, 15_000, 20_000,
  25_000, 30_000, 35_000, 40_000, 50_000,
] as const;

/** Catacombs (and every dungeon class) share this curve, capped at 50. */
const CATACOMBS_INCREMENTS = [
  50, 75, 110, 160, 230, 330, 470, 670, 950, 1_340,
  1_890, 2_665, 3_760, 5_260, 7_380, 10_300, 14_400, 20_000, 27_600, 38_000,
  52_500, 71_500, 97_000, 132_000, 180_000, 243_000, 328_000, 445_000, 600_000, 800_000,
  1_065_000, 1_410_000, 1_900_000, 2_500_000, 3_300_000, 4_300_000, 5_600_000, 7_200_000, 9_200_000, 12_000_000,
  15_000_000, 19_000_000, 24_000_000, 30_000_000, 38_000_000, 48_000_000, 60_000_000, 75_000_000, 93_000_000, 116_250_000,
] as const;

/** Prefix sums: `table[n]` is the total XP needed to *be* level n+1. */
function cumulative(increments: readonly number[]): readonly number[] {
  const out: number[] = [];
  let running = 0;
  for (const step of increments) {
    running += step;
    out.push(running);
  }
  return out;
}

export const SKILL_XP = cumulative(SKILL_INCREMENTS);
export const RUNECRAFTING_XP = cumulative(RUNECRAFTING_INCREMENTS);
export const SOCIAL_XP = cumulative(SOCIAL_INCREMENTS);
export const CATACOMBS_XP = cumulative(CATACOMBS_INCREMENTS);

export interface LevelReading {
  readonly level: number;
  /** XP still needed for the next level; null once capped. */
  readonly xpToNext: number | null;
  /** 0–1 through the current level; 1 once capped. */
  readonly progress: number;
}

/**
 * Resolve a raw experience total against a cumulative table.
 *
 * `maxLevel` is passed separately because several skills share `SKILL_XP` while
 * capping at 50 — the curve is the same, the ceiling is not. Overflow XP beyond
 * the cap is intentionally discarded here; the weight calculation reads the raw
 * total directly when it needs the overflow.
 */
export function levelFromXp(table: readonly number[], xp: number, maxLevel: number): LevelReading {
  const cap = Math.min(maxLevel, table.length);
  if (!Number.isFinite(xp) || xp <= 0) {
    return { level: 0, xpToNext: table[0] ?? null, progress: 0 };
  }

  let level = 0;
  while (level < cap && xp >= (table[level] ?? Infinity)) level += 1;
  if (level >= cap) return { level: cap, xpToNext: null, progress: 1 };

  const floor = level === 0 ? 0 : (table[level - 1] ?? 0);
  const ceiling = table[level] ?? floor;
  const span = ceiling - floor;
  return {
    level,
    xpToNext: ceiling - xp,
    progress: span > 0 ? (xp - floor) / span : 0,
  };
}

/**
 * Cumulative slayer XP per tier for the five standard bosses. Vampire runs a
 * separate, far shorter ladder and caps at 5.
 */
export const SLAYER_TIERS: Readonly<Record<string, readonly number[]>> = {
  zombie: [5, 15, 200, 1_000, 5_000, 20_000, 100_000, 400_000, 1_000_000],
  spider: [5, 15, 200, 1_000, 5_000, 20_000, 100_000, 400_000, 1_000_000],
  wolf: [5, 15, 200, 1_000, 5_000, 20_000, 100_000, 400_000, 1_000_000],
  enderman: [5, 15, 200, 1_000, 5_000, 20_000, 100_000, 400_000, 1_000_000],
  blaze: [5, 15, 200, 1_000, 5_000, 20_000, 100_000, 400_000, 1_000_000],
  vampire: [20, 75, 240, 840, 2_400],
};

/** Slayer tiers are a plain threshold ladder, not the level curve above. */
export function slayerTier(boss: string, xp: number): { tier: number; maxTier: number } {
  const table = SLAYER_TIERS[boss] ?? SLAYER_TIERS["zombie"] ?? [];
  let tier = 0;
  for (const threshold of table) {
    if (xp >= threshold) tier += 1;
    else break;
  }
  return { tier, maxTier: table.length };
}
