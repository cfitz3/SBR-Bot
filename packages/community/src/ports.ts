import type {
  ApplicationDTO,
  EventDTO,
  EventStatus,
  MemberSummaryDTO,
  RSVPState,
} from "@sbr/shared-types";

export interface EventRsvpInfo {
  readonly status: EventStatus;
  readonly capacity: number | null;
  readonly goingCount: number;
}

export interface CommunityRepository {
  listUpcomingEvents(guildId: string): Promise<readonly EventDTO[]>;
  listMembers(guildId: string): Promise<readonly MemberSummaryDTO[]>;
  listApplications(guildId: string): Promise<readonly ApplicationDTO[]>;
  getEventForRsvp(eventId: string): Promise<EventRsvpInfo | null>;
  upsertRsvp(eventId: string, discordId: string, state: RSVPState): Promise<void>;
}
