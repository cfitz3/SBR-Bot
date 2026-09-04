/**
 * Senither weight — the guild-standard single number for "how far along is this
 * player". It is not our formula: the constants and exponents below are the
 * published Senither v1 definition, reproduced so our figure matches what
 * members see on every other tool. Changing a constant here silently disagrees
 * with the rest of the community, so treat them as fixed.
 *
 * Each component splits into `base` (earned up to the cap) and `overflow` (past
 * it, at a steeply reduced rate). We report the sum; the split is kept internal
 * because no command surfaces it.
 */
import type { DungeonsDTO, SkillsDTO, SlayersDTO } from "@sbr/shared-types";
import { CATACOMBS_XP, SKILL_XP } from "./xp.js";

/** Cumulative XP at each cap, from the shared curve. */
const SKILL_CAP_XP: Readonly<Record<number, number>> = {
  50: SKILL_XP[49] ?? 0,
  60: SKILL_XP[59] ?? 0,
};
const CATACOMBS_CAP_XP = CATACOMBS_XP[49] ?? 0;

interface SkillFactor {
  readonly exponent: number;
  readonly divider: number;
}

const SKILL_FACTORS: Readonly<Record<string, SkillFactor>> = {
  Mining: { exponent: 1.18207448, divider: 259_634 },
  Foraging: { exponent: 1.232826, divider: 259_634 },
  Enchanting: { exponent: 0.96976583, divider: 882_758 },
  Farming: { exponent: 1.217848139, divider: 220_689 },
  Combat: { exponent: 1.15797687, divider: 275_862 },
  Fishing: { exponent: 1.406418, divider: 88_274 },
  Alchemy: { exponent: 1.0, divider: 1_103_448 },
  Taming: { exponent: 1.14744, divider: 441_379 },
};

interface SlayerFactor {
  readonly divider: number;
  readonly modifier: number;
}

const SLAYER_FACTORS: Readonly<Record<string, SlayerFactor>> = {
  zombie: { divider: 2_208, modifier: 0.15 },
  spider: { divider: 2_118, modifier: 0.08 },
  wolf: { divider: 1_962, modifier: 0.015 },
  enderman: { divider: 1_430, modifier: 0.017 },
  blaze: { divider: 1_057, modifier: 0.017 },
};

const CATACOMBS_FACTOR = 0.000_214_960_461_5;
const DUNGEON_CLASS_FACTOR = 0.000_004_525_483_4;

function skillWeight(skills: SkillsDTO): number {
  let total = 0;
  for (const skill of skills.skills) {
    const factor = SKILL_FACTORS[skill.name];
    if (!factor || skill.level === null || skill.experience === null) continue;

    const capXp = SKILL_CAP_XP[skill.maxLevel] ?? 0;
    const base = Math.pow(skill.level * 10, 0.5 + factor.exponent + skill.level / 100) / 1250;
    total += skill.experience <= capXp
      ? base
      : base + Math.pow((skill.experience - capXp) / factor.divider, 0.968);
  }
  return total;
}

function slayerWeight(slayers: SlayersDTO): number {
  let total = 0;
  for (const boss of slayers.bosses) {
    const factor = SLAYER_FACTORS[boss.boss];
    if (!factor) continue;

    if (boss.experience <= 1_000_000) {
      total += boss.experience / factor.divider;
      continue;
    }

    total += 1_000_000 / factor.divider;
    // Overflow is taxed once per additional million, and the tax doubles each
    // time — this is what keeps very high slayer XP from dominating the score.
    let remaining = boss.experience - 1_000_000;
    let modifier = factor.modifier;
    while (remaining > 0) {
      const chunk = Math.min(remaining, 1_000_000);
      total += Math.pow(chunk / (factor.divider * (1.5 + modifier)), 0.942);
      modifier += modifier;
      remaining -= chunk;
    }
  }
  return total;
}

function levelledWeight(level: number, experience: number, factor: number): number {
  const base = Math.pow(level, 4.5) * factor;
  if (experience <= CATACOMBS_CAP_XP) return base;
  const splitter = (4 * CATACOMBS_CAP_XP) / base;
  return Math.floor(base) + Math.pow((experience - CATACOMBS_CAP_XP) / splitter, 0.968);
}

function dungeonWeight(dungeons: DungeonsDTO): number {
  if (dungeons.catacombsLevel === null || dungeons.catacombsExperience === null) return 0;
  let total = levelledWeight(dungeons.catacombsLevel, dungeons.catacombsExperience, CATACOMBS_FACTOR);
  for (const klass of dungeons.classes) {
    if (klass.experience <= 0) continue;
    total += levelledWeight(klass.level, klass.experience, DUNGEON_CLASS_FACTOR);
  }
  return total;
}

/**
 * The composite figure. Returns null when the profile's API is off entirely —
 * a weight of 0 would read as "this player has done nothing", which is a
 * different and wrong claim.
 */
export function senitherWeight(
  skills: SkillsDTO,
  slayers: SlayersDTO,
  dungeons: DungeonsDTO,
): number | null {
  if (skills.apiDisabled && slayers.bosses.length === 0 && !dungeons.played) return null;
  return skillWeight(skills) + slayerWeight(slayers) + dungeonWeight(dungeons);
}
