import type {
  ApplicationDTO,
  ApplicationStatus,
  AttendanceDTO,
  EventDTO,
  EventStatus,
  LFGActivity,
  LFGPostDTO,
  LFGStatus,
  MemberRole,
  MemberSummaryDTO,
  NewEvent,
  NewLfgPost,
  NewTicket,
  RSVPState,
  TicketDTO,
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
  /** Null when the guild has no member row for that Discord id. */
  setMemberRole(guildId: string, discordId: string, role: MemberRole): Promise<MemberSummaryDTO | null>;
  getEventForRsvp(eventId: string): Promise<EventRsvpInfo | null>;
  upsertRsvp(eventId: string, discordId: string, state: RSVPState): Promise<void>;

  // ── Events ──
  createEvent(input: NewEvent): Promise<EventDTO>;
  getEvent(eventId: string): Promise<EventDTO | null>;
  setEventStatus(eventId: string, status: EventStatus): Promise<EventDTO | null>;
  getAttendance(eventId: string): Promise<AttendanceDTO | null>;

  // ── LFG ──
  createLfg(input: NewLfgPost): Promise<LFGPostDTO>;
  getLfg(postId: string): Promise<LFGPostDTO | null>;
  listLfg(guildId: string, activity?: LFGActivity): Promise<readonly LFGPostDTO[]>;
  /**
   * Replaces the roster wholesale. The service computes it, so slot arithmetic
   * and the OPEN/FULL transition live in one place rather than in every driver.
   */
  setLfgMembers(postId: string, members: readonly string[], status: LFGStatus): Promise<LFGPostDTO | null>;

  // ── Tickets ──
  createTicket(input: NewTicket): Promise<TicketDTO>;
  getTicket(ticketId: string): Promise<TicketDTO | null>;
  closeTicket(ticketId: string, actorDiscordId: string, reason: string | null): Promise<TicketDTO | null>;
  listTickets(guildId: string, openerDiscordId?: string): Promise<readonly TicketDTO[]>;

  // ── Applications ──
  getApplication(applicationId: string): Promise<ApplicationDTO | null>;
  decideApplication(
    applicationId: string,
    status: ApplicationStatus,
    reviewerDiscordId: string,
    reason: string | null,
  ): Promise<ApplicationDTO | null>;
}
