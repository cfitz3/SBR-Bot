/**
 * Hypixel-facing DTOs and raw upstream response shapes. Domain packages consume
 * the normalized DTOs; the raw shapes never leak past normalization.
 */

/** Normalized player projection (minimal for this slice). Unknown fields are null. */
export interface HypixelPlayerDTO {
  readonly uuid: string;
  readonly ign: string | null;
  /** The Discord identifier set in the in-game social field, or null if unset. */
  readonly discordSocial: string | null;
}

// ── Raw upstream shapes (loosely typed; validated during normalization) ──

export interface RawMojangProfile {
  readonly id?: string;
  readonly name?: string;
}

export interface RawHypixelPlayerResponse {
  readonly success?: boolean;
  readonly player?: RawHypixelPlayer | null;
  readonly cause?: string;
}

export interface RawHypixelPlayer {
  readonly uuid?: string;
  readonly displayname?: string;
  readonly socialMedia?: {
    readonly links?: {
      readonly DISCORD?: string;
    };
  };
}

/** Normalized Skyblock profile projection with the member blob for networth. */
export interface SkyblockProfileDTO {
  readonly profileId: string;
  readonly cuteName: string | null;
  readonly gameMode: "NORMAL" | "IRONMAN" | "STRANDED" | "BINGO";
  /** Raw member object for this uuid (fed to the networth engine). */
  readonly member: unknown;
  readonly bankBalance: number | null;
  /** Which value-bearing sections we could read (drives networth honesty). */
  readonly readableSections: readonly string[];
}

export interface RawSkyblockProfilesResponse {
  readonly success?: boolean;
  readonly profiles?: readonly RawSkyblockProfile[] | null;
}

export interface RawSkyblockProfile {
  readonly profile_id?: string;
  readonly cute_name?: string;
  readonly game_mode?: string;
  readonly selected?: boolean;
  readonly banking?: { readonly balance?: number };
  readonly members?: Record<string, Record<string, unknown>>;
}
