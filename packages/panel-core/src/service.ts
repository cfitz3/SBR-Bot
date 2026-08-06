/**
 * PanelService — authorizes a guild-scoped page request, then resolves its view
 * model from the shared services. Every load returns the AccessDecision so the
 * route can render the right allowed/denied state.
 */
import type { CommunityService, InfractionDTO, ModerationService } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { authorize, type AccessDecision, type PanelSession, type RoleResolver } from "./access.js";

export interface OverviewVM {
  readonly memberCount: number;
  readonly upcomingEventCount: number;
  readonly openApplicationCount: number;
}

export interface ModerationVM {
  readonly target: string;
  readonly infractionCount: number;
  readonly infractions: readonly InfractionDTO[];
}

export type PageResult<T> =
  | { readonly access: Extract<AccessDecision, { allowed: true }>; readonly data: T }
  | { readonly access: Extract<AccessDecision, { allowed: false }>; readonly data: null };

export interface PanelServiceDeps {
  readonly roles: RoleResolver;
  readonly community: CommunityService;
  readonly moderation: ModerationService;
  readonly logger: Logger;
}

export class PanelService {
  private readonly d: PanelServiceDeps;
  private readonly log: Logger;

  constructor(deps: PanelServiceDeps) {
    this.d = deps;
    this.log = deps.logger.child({ service: "panel" });
  }

  async loadOverview(session: PanelSession | null, guildId: string): Promise<PageResult<OverviewVM>> {
    const access = await authorize(session, guildId, "overview", this.d.roles);
    if (!access.allowed) return this.denied(access, "overview", guildId);

    const [members, events, applications] = await Promise.all([
      this.d.community.listMembers(guildId),
      this.d.community.listUpcomingEvents(guildId),
      this.d.community.listApplications(guildId),
    ]);

    const data: OverviewVM = {
      memberCount: members.ok ? members.value.length : 0,
      upcomingEventCount: events.ok ? events.value.length : 0,
      openApplicationCount: applications.ok ? applications.value.length : 0,
    };
    return { access, data };
  }

  async loadModeration(
    session: PanelSession | null,
    guildId: string,
    targetDiscordId: string,
  ): Promise<PageResult<ModerationVM>> {
    const access = await authorize(session, guildId, "moderation", this.d.roles);
    if (!access.allowed) return this.denied(access, "moderation", guildId);

    const infractions = await this.d.moderation.listInfractions(guildId, targetDiscordId);
    const list = infractions.ok ? infractions.value : [];
    const data: ModerationVM = { target: targetDiscordId, infractionCount: list.length, infractions: list };
    return { access, data };
  }

  private denied<T>(
    access: Extract<AccessDecision, { allowed: false }>,
    page: string,
    guildId: string,
  ): PageResult<T> {
    this.log.warn("panel access denied", { page, guildId, reason: access.reason });
    return { access, data: null };
  }
}
