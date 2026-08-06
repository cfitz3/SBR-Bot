/**
 * CommunityServiceImpl — events, membership, applications, and RSVP.
 * RSVP applies capacity→waitlist logic: a GOING response to a full event is
 * recorded as WAITLIST instead (EventDTO capacity honored).
 */
import {
  err,
  ok,
  type ApplicationDTO,
  type CommunityService,
  type EventDTO,
  type MemberSummaryDTO,
  type RSVPState,
  type Result,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import type { CommunityRepository } from "./ports.js";

export type RsvpError = { readonly kind: "EVENT_NOT_FOUND" } | { readonly kind: "EVENT_CLOSED" };

export interface CommunityServiceDeps {
  readonly repo: CommunityRepository;
  readonly logger: Logger;
}

export class CommunityServiceImpl implements CommunityService {
  private readonly repo: CommunityRepository;
  private readonly log: Logger;

  constructor(deps: CommunityServiceDeps) {
    this.repo = deps.repo;
    this.log = deps.logger.child({ service: "community" });
  }

  async listUpcomingEvents(guildId: string): Promise<Result<readonly EventDTO[]>> {
    return ok(await this.repo.listUpcomingEvents(guildId));
  }

  async listMembers(guildId: string): Promise<Result<readonly MemberSummaryDTO[]>> {
    return ok(await this.repo.listMembers(guildId));
  }

  async listApplications(guildId: string): Promise<Result<readonly ApplicationDTO[]>> {
    return ok(await this.repo.listApplications(guildId));
  }

  /** RSVP to an event, applying capacity→waitlist. Returns the recorded state. */
  async rsvp(
    eventId: string,
    discordId: string,
    requested: RSVPState,
  ): Promise<Result<{ state: RSVPState }, RsvpError>> {
    const event = await this.repo.getEventForRsvp(eventId);
    if (!event) return err({ kind: "EVENT_NOT_FOUND" });
    if (event.status === "COMPLETED" || event.status === "CANCELLED") {
      return err({ kind: "EVENT_CLOSED" });
    }

    const atCapacity = event.capacity !== null && event.goingCount >= event.capacity;
    const state: RSVPState = requested === "GOING" && atCapacity ? "WAITLIST" : requested;

    await this.repo.upsertRsvp(eventId, discordId, state);
    this.log.info("rsvp recorded", { eventId, discordId, requested, state });
    return ok({ state });
  }
}
