/**
 * Port: provides a member's selected Skyblock profile in a normalized shape,
 * already carrying everything progression needs (summary fields + networth
 * engine input + which sections were readable). Implemented at wiring time over
 * the Hypixel client; faked in tests. Returns the typed HypixelResult so
 * MISSING_PROFILE / RATE_LIMITED / API_DISABLED propagate cleanly.
 */
import type { HypixelResult, SkyblockGameMode } from "@sbr/shared-types";
import type { NetworthEngineInput } from "@sbr/pricing";

export interface SkyblockProfileData {
  readonly profileId: string;
  readonly cuteName: string | null;
  readonly gameMode: SkyblockGameMode;
  /**
   * The member blob exactly as Hypixel returned it. Skills, slayers, dungeons
   * and weight are *derived* from this by the service rather than passed in —
   * that keeps every caller's numbers consistent and means a wiring adapter
   * cannot accidentally supply nulls for stats the profile actually contains.
   */
  readonly rawMember: unknown;
  readonly networthEngineInput: NetworthEngineInput;
  readonly readableSections: readonly string[];
  readonly requiredSections: readonly string[];
}

/**
 * Port: what an upgrade suggestion costs. Optional at wiring time — advice is
 * still worth giving when the auction sweep is cold, it just arrives without
 * price tags rather than not at all.
 */
export interface UpgradePriceSource {
  /** Lowest BIN in coins, or null when the item is unpriced or unknown. */
  lowestBin(itemId: string): Promise<number | null>;
}

export interface ProfileProvider {
  getSelectedProfile(uuid: string, profileId?: string): Promise<HypixelResult<SkyblockProfileData>>;
  /** Every profile on the account, for `/profile` and `/setprofile`. */
  listProfiles(uuid: string): Promise<HypixelResult<readonly SkyblockProfileData[]>>;
}
