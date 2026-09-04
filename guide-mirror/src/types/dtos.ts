/**
 * The DTOs SBR-Guide needs, and only those.
 *
 * This is a *reduction* of the contract layer the parsers were written against,
 * not a copy of it. The guild platform's contract layer also describes rosters,
 * moderation cases, XP ledgers and stored progression readings; none of that has
 * any business being in a repository submitted for API review, and a reviewer
 * should be able to read every shape this bot can hold in one short file.
 *
 * Kept honest by the build rather than by care: the parsers are copied in from
 * upstream unchanged, so a field added to one of these shapes there and not here
 * fails `tsc` in this repository. See COMPLIANCE.md §1.
 */

/**
 * One skill's standing. `level` is null when the profile hides its skill API —
 * a hidden skill is unknown, not level 0.
 */
export interface SkillDTO {
  readonly name: string;
  readonly level: number | null;
  readonly maxLevel: number;
  readonly experience: number | null;
  /** XP still needed for the next level; null at cap or when unknown. */
  readonly xpToNext: number | null;
  /** 0–1 through the current level, for progress bars. Null when unknown. */
  readonly progress: number | null;
}

export interface SkillsDTO {
  readonly skills: readonly SkillDTO[];
  /**
   * Mean level across the skills that count toward it — cosmetic skills
   * (Runecrafting, Social, Carpentry) are excluded, as the game does.
   */
  readonly average: number | null;
  /** True when the profile's skill API is off, so everything above is unknown. */
  readonly apiDisabled: boolean;
}

export interface SlayerBossDTO {
  readonly boss: string;
  readonly experience: number;
  readonly tier: number;
  readonly maxTier: number;
  /** Kill counts keyed by tier ("1".."5"), as the profile reports them. */
  readonly kills: Readonly<Record<string, number>>;
}

export interface SlayersDTO {
  readonly bosses: readonly SlayerBossDTO[];
  readonly totalExperience: number;
}

export interface DungeonClassDTO {
  readonly name: string;
  readonly level: number;
  readonly experience: number;
}

export interface DungeonFloorDTO {
  readonly floor: string;
  readonly completions: number;
  /** Fastest S+ clear in ms, or null if never cleared S+. */
  readonly fastestSPlusMs: number | null;
}

export interface DungeonsDTO {
  readonly catacombsLevel: number | null;
  readonly catacombsExperience: number | null;
  /** XP still needed for the next Catacombs level; null at cap or unknown. */
  readonly catacombsXpToNext: number | null;
  /** 0–1 through the current Catacombs level. Null when the level is unknown. */
  readonly catacombsProgress: number | null;
  readonly selectedClass: string | null;
  readonly classAverage: number | null;
  readonly classes: readonly DungeonClassDTO[];
  readonly floors: readonly DungeonFloorDTO[];
  readonly masterFloors: readonly DungeonFloorDTO[];
  /** True when the profile has no dungeon data at all. */
  readonly played: boolean;
}

export interface HealthAggregator {
  register(check: HealthCheck): void;
  run(): Promise<HealthReportDTO>;
}

/** A single health probe, composed by the health registry. */
export interface HealthCheck {
  readonly name: string;
  check(): Promise<{ status: "ok" | "degraded" | "down"; latencyMs: number | null; detail?: string }>;
}

export interface ComponentHealthDTO {
  readonly name: string;
  readonly status: "ok" | "degraded" | "down";
  readonly latencyMs: number | null;
  readonly detail?: string;
}

export interface HealthReportDTO {
  readonly status: "ok" | "degraded" | "down";
  readonly checkedAt: string;
  readonly components: readonly ComponentHealthDTO[];
}

/**
 * Port: read the Hypixel in-game social Discord field for an IGN.
 *
 * The only identity path this bot has. There is deliberately no IGN-to-uuid
 * route except Mojang, and no fallback that walks a roster or searches auctions
 * to turn a partial name into a player: an inconclusive lookup stays
 * inconclusive (COMPLIANCE.md §3).
 */
export interface HypixelSocialLookup {
  getLinkedDiscord(ign: string): Promise<HypixelSocialResult>;
}

export type HypixelSocialResult =
  | { readonly kind: "FOUND"; readonly uuid: string; readonly ign: string; readonly discordId: string | null }
  | { readonly kind: "IGN_NOT_FOUND" };
