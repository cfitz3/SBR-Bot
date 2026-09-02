/**
 * Port: provides a member's selected Skyblock profile in a normalized shape,
 * already carrying everything progression needs (summary fields + networth
 * engine input + which sections were readable). Implemented at wiring time over
 * the Hypixel client; faked in tests. Returns the typed HypixelResult so
 * MISSING_PROFILE / RATE_LIMITED / API_DISABLED propagate cleanly.
 */
import type { CommunityMetricsDTO, HypixelResult, SkyblockGameMode } from "@sbr/shared-types";
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

/**
 * Port: what this platform counts about a member of a guild, for the metrics
 * Hypixel knows nothing about — events attended, podiums, tenure, guild XP.
 *
 * Keyed by Minecraft UUID because that is what the progression service has in
 * hand; resolving it to a Discord id is the adapter's problem, and an account
 * with no verified link in this guild has no community reading at all, which is
 * `null` rather than a row of zeroes.
 *
 * Optional at wiring time. Without it, community definitions read as unmeasured
 * — the same rule every other optional port here follows.
 */
export interface CommunityMetricsSource {
  forAccount(guildId: string, minecraftUuid: string): Promise<CommunityMetricsDTO | null>;
}

/**
 * Port: a profile's museum contents, for the donation count.
 *
 * Separate from `ProfileProvider` because it is a separate upstream endpoint
 * with its own per-player claim and its own 12-hour cache — reading a member's
 * profile does not read their museum, and pretending otherwise in the port
 * would hide a second request behind a method that looks like one.
 *
 * Optional at wiring time. Without it the museum reading is simply absent,
 * which is the honest state: nobody looked. That also makes spending the extra
 * call an explicit wiring decision rather than something a metric list turns on
 * by accident.
 */
export interface MuseumProvider {
  /** Null when the museum is unreadable — an outage, or the member hid it. */
  museum(profileId: string): Promise<MuseumRead | null>;
}

/** Just enough of a museum response to count what has been donated. */
export interface MuseumRead {
  readonly members: Readonly<Record<string, unknown>>;
}
