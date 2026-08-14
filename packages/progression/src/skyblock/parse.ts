/**
 * Parsers turning a raw Skyblock member blob into typed DTOs.
 *
 * Everything here is defensive by construction: the member object is `unknown`,
 * Hypixel moved several of these fields between API versions, and a profile with
 * its API settings off simply omits them. Absent data becomes `null` or an empty
 * collection — never `0`, which would read as "level zero" rather than "hidden"
 * (HYPIXEL_DATA_LAYER.md §5).
 */
import type {
  DungeonClassDTO,
  DungeonFloorDTO,
  DungeonsDTO,
  SkillDTO,
  SkillsDTO,
  SlayerBossDTO,
  SlayersDTO,
} from "@sbr/shared-types";
import { CATACOMBS_XP, RUNECRAFTING_XP, SKILL_XP, SOCIAL_XP, levelFromXp, slayerTier } from "./xp.js";

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function dig(root: unknown, ...path: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    const record = obj(cursor);
    if (!record) return undefined;
    cursor = record[key];
  }
  return cursor;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Skill caps as the game enforces them. Runecrafting and Social run their own
 * curves; the rest share the standard one and differ only in ceiling.
 */
const SKILLS: readonly { readonly name: string; readonly key: string; readonly max: number }[] = [
  { name: "Farming", key: "FARMING", max: 60 },
  { name: "Mining", key: "MINING", max: 60 },
  { name: "Combat", key: "COMBAT", max: 60 },
  // The Foraging update made 50 a soft cap: levels 51-57 are unlocked with
  // Fig/Mangrove/Helix logs and Agatha's milestones, on the same curve. Capping
  // at 50 here would report a 57 as a 50, which is worse than reporting a
  // ceiling most players cannot yet reach.
  { name: "Foraging", key: "FORAGING", max: 57 },
  { name: "Fishing", key: "FISHING", max: 50 },
  { name: "Enchanting", key: "ENCHANTING", max: 60 },
  { name: "Alchemy", key: "ALCHEMY", max: 50 },
  { name: "Taming", key: "TAMING", max: 60 },
  // Added with the Foraging update: levelled by hunting mobs and by fusing and
  // syphoning attribute shards. Counts toward the average like any other
  // gameplay skill, which does move every member's average down until they
  // level it — a real change in a real statistic, not a reporting artefact.
  { name: "Hunting", key: "HUNTING", max: 50 },
  { name: "Carpentry", key: "CARPENTRY", max: 50 },
  { name: "Runecrafting", key: "RUNECRAFTING", max: 25 },
  { name: "Social", key: "SOCIAL", max: 25 },
];

/** Excluded from skill average, as the in-game display does. */
const COSMETIC = new Set(["Carpentry", "Runecrafting", "Social"]);

function curveFor(key: string): readonly number[] {
  if (key === "RUNECRAFTING") return RUNECRAFTING_XP;
  if (key === "SOCIAL") return SOCIAL_XP;
  return SKILL_XP;
}

/** Both API generations, newest first — profiles in the wild still carry either. */
function skillXp(member: unknown, key: string): number | null {
  const modern = num(dig(member, "player_data", "experience", `SKILL_${key}`));
  if (modern !== null) return modern;
  return num(dig(member, `experience_skill_${key.toLowerCase()}`));
}

export function parseSkills(member: unknown): SkillsDTO {
  const readings = SKILLS.map((skill) => {
    const xp = skillXp(member, skill.key);
    if (xp === null) {
      const hidden: SkillDTO = {
        name: skill.name,
        level: null,
        maxLevel: skill.max,
        experience: null,
        xpToNext: null,
        progress: null,
      };
      return hidden;
    }
    const reading = levelFromXp(curveFor(skill.key), xp, skill.max);
    const dto: SkillDTO = {
      name: skill.name,
      level: reading.level,
      maxLevel: skill.max,
      experience: xp,
      xpToNext: reading.xpToNext,
      progress: reading.progress,
    };
    return dto;
  });

  // A single readable skill is enough to prove the API is on; zero means it's off.
  const counted = readings.filter((s) => !COSMETIC.has(s.name) && s.level !== null);
  const average =
    counted.length > 0
      ? counted.reduce((sum, s) => sum + (s.level ?? 0), 0) / counted.length
      : null;

  return {
    skills: readings,
    average,
    apiDisabled: readings.every((s) => s.level === null),
  };
}

const SLAYER_BOSSES = ["zombie", "spider", "wolf", "enderman", "blaze", "vampire"] as const;

export function parseSlayers(member: unknown): SlayersDTO {
  const root = obj(dig(member, "slayer", "slayer_bosses")) ?? obj(dig(member, "slayer_bosses"));
  const bosses: SlayerBossDTO[] = [];
  let total = 0;

  for (const boss of SLAYER_BOSSES) {
    const data = obj(root?.[boss]);
    if (!data) continue;
    const xp = num(data["xp"]) ?? 0;
    total += xp;

    // Hypixel keys kills as `boss_kills_tier_0`; players count tiers from 1.
    const kills: Record<string, number> = {};
    for (const [key, value] of Object.entries(data)) {
      const match = /^boss_kills_tier_(\d+)$/.exec(key);
      const count = num(value);
      if (match?.[1] !== undefined && count !== null) {
        kills[String(Number(match[1]) + 1)] = count;
      }
    }

    const { tier, maxTier } = slayerTier(boss, xp);
    bosses.push({ boss, experience: xp, tier, maxTier, kills });
  }

  return { bosses, totalExperience: total };
}

const DUNGEON_CLASSES = ["healer", "mage", "berserk", "archer", "tank"] as const;

function floors(source: unknown): DungeonFloorDTO[] {
  const completions = obj(dig(source, "tier_completions"));
  const fastest = obj(dig(source, "fastest_time_s_plus"));
  if (!completions) return [];

  return Object.entries(completions)
    .map(([floor, value]) => {
      const dto: DungeonFloorDTO = {
        floor,
        completions: num(value) ?? 0,
        fastestSPlusMs: num(fastest?.[floor]),
      };
      return dto;
    })
    .sort((a, b) => Number(a.floor) - Number(b.floor));
}

/**
 * SkyBlock Level, from the profile's own levelling track. 100 XP to a level.
 *
 * The fraction is kept rather than floored, for the same reason catacombs keeps
 * its progress: a member who moves from 214.1 to 214.9 has had a real week, and
 * a headline number that reads 214 both times says they did nothing. Callers
 * that want the badge Hypixel prints can floor it themselves.
 *
 * Null, never 0, when the section is absent — a profile with its API settings
 * off hides `leveling` entirely, and "hidden" is not "level zero"
 * (HYPIXEL_DATA_LAYER.md §5).
 */
export function skyblockLevel(member: unknown): number | null {
  const xp = num(dig(member, "leveling", "experience"));
  return xp === null ? null : xp / 100;
}

export function parseDungeons(member: unknown): DungeonsDTO {
  const dungeons = obj(dig(member, "dungeons"));
  const catacombs = obj(dig(dungeons, "dungeon_types", "catacombs"));
  const master = obj(dig(dungeons, "dungeon_types", "master_catacombs"));
  const classRoot = obj(dig(dungeons, "player_classes"));

  if (!dungeons || (!catacombs && !classRoot)) {
    return {
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
    };
  }

  const cataXp = num(catacombs?.["experience"]);
  const classes: DungeonClassDTO[] = DUNGEON_CLASSES.map((name) => {
    const xp = num(dig(classRoot, name, "experience")) ?? 0;
    return { name, level: levelFromXp(CATACOMBS_XP, xp, 50).level, experience: xp };
  });

  const selected = dig(dungeons, "selected_dungeon_class");

  const cata = cataXp === null ? null : levelFromXp(CATACOMBS_XP, cataXp, 50);

  return {
    catacombsLevel: cata?.level ?? null,
    catacombsExperience: cataXp,
    catacombsXpToNext: cata?.xpToNext ?? null,
    catacombsProgress: cata?.progress ?? null,
    selectedClass: typeof selected === "string" && selected.length > 0 ? selected : null,
    classAverage: classes.reduce((sum, c) => sum + c.level, 0) / classes.length,
    classes,
    floors: floors(catacombs),
    masterFloors: floors(master),
    // Entering a dungeon at all creates the node; XP of 0 is a real reading here.
    played: cataXp !== null || classes.some((c) => c.experience > 0),
  };
}
