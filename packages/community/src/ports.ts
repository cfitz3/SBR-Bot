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
  NewTicket,
  RSVPState,
  TicketCategoryDTO,
  TicketDTO,
  TicketStatus,
} from "@sbr/shared-types";

/**
 * The mutable half of a ticket.
 *
 * Every field is optional and absent means "leave it alone", so a claim writes
 * two columns rather than a whole row — which matters because two staff members
 * acting at once should not silently undo each other's unrelated edits.
 */
export interface TicketPatch {
  readonly status?: TicketStatus;
  readonly assigneeDiscordId?: string | null;
  readonly claimedByDiscordId?: string | null;
  readonly claimedAt?: Date | null;
  readonly closeRequestedByDiscordId?: string | null;
  readonly closeRequestedAt?: Date | null;
  readonly topic?: string | null;
  readonly closeReason?: string | null;
  readonly closedAt?: Date | null;
  readonly lastMessageAt?: Date;
  readonly firstStaffReplyAt?: Date;
  readonly transcriptReady?: boolean;
}

export interface EventRsvpInfo {
  readonly status: EventStatus;
  readonly capacity: number | null;
  readonly goingCount: number;
}

/**
 * What actually gets written for a new post.
 *
 * Distinct from `NewLfgPost` on purpose: the command asks for `perm: true`, and
 * turning that into a concrete roster and a perm id is the service's job. By the
 * time the repository sees it there are no wishes left, only rows.
 */
export interface LfgInsert {
  readonly guildId: string;
  readonly authorDiscordId: string;
  readonly activity: LFGActivity;
  readonly title: string | null;
  readonly details: string | null;
  readonly slotsTotal: number;
  readonly expiresInMinutes?: number;
  /** The perm the roster was autofilled from, when it was. */
  readonly permGroupId: string | null;
  /** The starting roster, author first. Never empty. */
  readonly members: readonly string[];
}

/**
 * A change to an event. Absent means "leave it alone"; `null` on a nullable
 * field clears it.
 */
export interface EventPatch {
  readonly title?: string;
  readonly description?: string | null;
  readonly startsAt?: Date;
  readonly endsAt?: Date | null;
  readonly capacity?: number | null;
  readonly status?: EventStatus;
  readonly trackedMetrics?: readonly string[];
  readonly pollIntervalMinutes?: number;
  readonly tracksProgression?: boolean;
}

/** A post edit. Absent means "leave it alone"; `null` on a nullable field clears it. */
export interface LfgPatch {
  readonly title?: string | null;
  readonly details?: string | null;
  readonly slotsTotal?: number;
  readonly status?: LFGStatus;
}

/**
 * The roster the service autofills an LFG post from.
 *
 * Narrower than `PermGroupDTO` so that `@sbr/community` does not depend on
 * `@sbr/perms` — the only thing LFG wants from a perm is who is in it and what
 * to call it. Perm members are tracked by IGN and may have no linked Discord
 * account; those seats simply cannot be autofilled, and the adapter drops them.
 */
export interface PermRoster {
  readonly id: string;
  readonly name: string;
  readonly discordIds: readonly string[];
}

/**
 * Resolves `perm:` on `/lfg`. Optional on the service: a deployment without
 * perms wired in still posts perfectly good solo LFGs.
 */
export interface PermRosterLookup {
  /** The author's default perm for this activity, or null when they have none. */
  defaultRoster(guildId: string, ownerDiscordId: string, activity: LFGActivity): Promise<PermRoster | null>;
  /** A perm the author named, or null when there is no such perm they may use. */
  namedRoster(guildId: string, ownerDiscordId: string, name: string): Promise<PermRoster | null>;
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
  /**
   * Applies only the fields present, like `updateLfg`. Whether an edit is
   * *allowed* is the service's decision, never this one's.
   */
  updateEvent(eventId: string, patch: EventPatch): Promise<EventDTO | null>;
  getAttendance(eventId: string): Promise<AttendanceDTO | null>;

  // ── LFG ──
  createLfg(input: LfgInsert): Promise<LFGPostDTO>;
  getLfg(postId: string): Promise<LFGPostDTO | null>;
  listLfg(guildId: string, activity?: LFGActivity): Promise<readonly LFGPostDTO[]>;
  /**
   * Replaces the roster wholesale. The service computes it, so slot arithmetic
   * and the OPEN/FULL transition live in one place rather than in every driver.
   */
  setLfgMembers(postId: string, members: readonly string[], status: LFGStatus): Promise<LFGPostDTO | null>;
  /** Applies only the fields present; absent fields are left as they are. */
  updateLfg(postId: string, patch: LfgPatch): Promise<LFGPostDTO | null>;
  /** Stamps CLOSED with who and when, so an early close reads differently from an expiry. */
  closeLfg(postId: string, closedByDiscordId: string, closedAt: Date): Promise<LFGPostDTO | null>;
  /** Records where the embed was published so it can be edited in place later. */
  bindLfgMessage(postId: string, channelId: string, messageId: string): Promise<LFGPostDTO | null>;

  // ── Tickets ──
  /** Allocates the per-guild `number` as part of the insert; see `TicketDTO.number`. */
  createTicket(input: NewTicket): Promise<TicketDTO>;
  getTicket(ticketId: string): Promise<TicketDTO | null>;
  /** The ticket a channel belongs to, which is how every in-channel command finds its subject. */
  getTicketByChannel(channelId: string): Promise<TicketDTO | null>;
  /**
   * Applies only the fields present.
   *
   * Deliberately dumb: every decision about *whether* a transition is allowed
   * belongs to `@sbr/tickets`, so the repository never has to be trusted with
   * one. That separation is what makes the permission rules testable.
   */
  patchTicket(ticketId: string, patch: TicketPatch): Promise<TicketDTO | null>;
  listTickets(guildId: string, openerDiscordId?: string): Promise<readonly TicketDTO[]>;
  /**
   * Every category in menu order, disabled ones included — the caller decides
   * whether it is drawing a member's menu or an admin's editor.
   */
  listTicketCategories(guildId: string): Promise<readonly TicketCategoryDTO[]>;

  // ── Applications ──
  getApplication(applicationId: string): Promise<ApplicationDTO | null>;
  decideApplication(
    applicationId: string,
    status: ApplicationStatus,
    reviewerDiscordId: string,
    reason: string | null,
  ): Promise<ApplicationDTO | null>;
}
