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
  readonly skillAverage: number | null;
  readonly catacombsLevel: number | null;
  readonly senitherWeight: number | null;
  readonly networthEngineInput: NetworthEngineInput;
  readonly readableSections: readonly string[];
  readonly requiredSections: readonly string[];
}

export interface ProfileProvider {
  getSelectedProfile(uuid: string, profileId?: string): Promise<HypixelResult<SkyblockProfileData>>;
}
