/**
 * ProgressionServiceImpl — composes the Skyblock profile read with networth
 * valuation. Fallback states from the profile provider propagate unchanged, and
 * the served freshness (LIVE/STALE) is preserved through to the DTO envelope.
 */
import {
  err,
  ok,
  type DataEnvelope,
  type HypixelResult,
  type NetworthDTO,
  type ProfileSummaryDTO,
  type ProgressionService,
} from "@sbr/shared-types";
import type { NetworthService } from "@sbr/pricing";
import type { Logger } from "@sbr/observability";
import type { ProfileProvider, SkyblockProfileData } from "./ports.js";

export interface ProgressionServiceDeps {
  readonly profiles: ProfileProvider;
  readonly networth: NetworthService;
  readonly logger: Logger;
}

function reEnvelope<A, B>(source: DataEnvelope<A>, data: B): DataEnvelope<B> {
  return { data, freshness: source.freshness, source: source.source, fetchedAt: source.fetchedAt };
}

export class ProgressionServiceImpl implements ProgressionService {
  private readonly profiles: ProfileProvider;
  private readonly networth: NetworthService;
  private readonly log: Logger;

  constructor(deps: ProgressionServiceDeps) {
    this.profiles = deps.profiles;
    this.networth = deps.networth;
    this.log = deps.logger.child({ service: "progression" });
  }

  async getProfileSummary(uuid: string, profileId?: string): Promise<HypixelResult<ProfileSummaryDTO>> {
    const result = await this.profiles.getSelectedProfile(uuid, profileId);
    if (!result.ok) return err(result.error);
    return ok(reEnvelope(result.value, toSummary(result.value.data)));
  }

  async getNetworth(uuid: string, profileId?: string): Promise<HypixelResult<NetworthDTO>> {
    const result = await this.profiles.getSelectedProfile(uuid, profileId);
    if (!result.ok) return err(result.error);

    const profile = result.value.data;
    const nw = await this.networth.getNetworth({
      engineInput: profile.networthEngineInput,
      readableSections: profile.readableSections,
      requiredSections: profile.requiredSections,
    });

    // NetworthService returns an honest DTO even on internal failure (total null).
    const dto = nw.ok ? nw.value : { total: null, exact: false, missing: profile.requiredSections, breakdown: {} };
    if (!dto.exact) {
      this.log.debug("networth served as estimate", { uuid, missing: dto.missing });
    }
    return ok(reEnvelope(result.value, dto));
  }
}

function toSummary(p: SkyblockProfileData): ProfileSummaryDTO {
  return {
    profileId: p.profileId,
    cuteName: p.cuteName,
    gameMode: p.gameMode,
    skillAverage: p.skillAverage,
    catacombsLevel: p.catacombsLevel,
    senitherWeight: p.senitherWeight,
  };
}
