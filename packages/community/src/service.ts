/**
 * CommunityServiceImpl — events, RSVP, looking-for-group, tickets, applications.
 *
 * All the rules that a user could argue with live here rather than in the
 * repository or the handlers: capacity→waitlist on RSVP, slot arithmetic and the
 * OPEN/FULL transition on LFG, who is allowed to cancel an event or close a
 * ticket, and the one-way SUBMITTED→ACCEPTED/REJECTED application transition.
 */
import {
  err,
  ok,
  type ApplicationDTO,
  type ApplicationDecision,
  type ApplicationError,
  type AttendanceDTO,
  type CommunityService,
  type EventDTO,
  type EventError,
  type LFGActivity,
  type LFGPostDTO,
  type LFGStatus,
  type LfgError,
  type MemberRole,
  type MemberSummaryDTO,
  type NewEvent,
  type NewLfgPost,
  type NewTicket,
  type RSVPState,
  type Result,
  type RsvpOutcome,
  type TicketDTO,
  type TicketError,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import type { CommunityRepository } from "./ports.js";

/** Retained for the pre-Stage-5 call sites; `EventError` is the current union. */
export type RsvpError = EventError;

/** A post can be joined by at most this many people regardless of what was asked for. */
const MAX_LFG_SLOTS = 20;

export interface CommunityServiceDeps {
  readonly repo: CommunityRepository;
  readonly logger: Logger;
  /** Injected so tests can pin "now" when validating event start times. */
  readonly now?: () => Date;
}

export class CommunityServiceImpl implements CommunityService {
  private readonly repo: CommunityRepository;
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(deps: CommunityServiceDeps) {
    this.repo = deps.repo;
    this.log = deps.logger.child({ service: "community" });
    this.now = deps.now ?? ((): Date => new Date());
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

  async setMemberRole(guildId: string, discordId: string, role: MemberRole): Promise<Result<MemberSummaryDTO>> {
    const updated = await this.repo.setMemberRole(guildId, discordId, role);
    if (!updated) return err(new Error("that member isn't on this server's roster"));
    this.log.info("member role changed", { guildId, discordId, role });
    return ok(updated);
  }

  // ─────────────────────────────── Events ───────────────────────────────

  async createEvent(input: NewEvent): Promise<Result<EventDTO, EventError>> {
    const startsAt = new Date(input.startsAt);
    if (Number.isNaN(startsAt.getTime())) {
      return err({ kind: "INVALID_TIME", detail: "I couldn't read that start time." });
    }
    if (startsAt.getTime() <= this.now().getTime()) {
      return err({ kind: "INVALID_TIME", detail: "that start time is in the past." });
    }
    if (input.capacity !== undefined && input.capacity !== null && input.capacity < 1) {
      return err({ kind: "INVALID_TIME", detail: "capacity has to be at least 1." });
    }

    const event = await this.repo.createEvent({ ...input, startsAt: startsAt.toISOString() });
    this.log.info("event created", { eventId: event.id, guildId: input.guildId, type: input.type });
    return ok(event);
  }

  async getEvent(eventId: string): Promise<Result<EventDTO | null>> {
    return ok(await this.repo.getEvent(eventId));
  }

  async cancelEvent(eventId: string, actorDiscordId: string): Promise<Result<EventDTO, EventError>> {
    const event = await this.repo.getEvent(eventId);
    if (!event) return err({ kind: "NOT_FOUND" });
    if (event.status === "CANCELLED" || event.status === "COMPLETED") return err({ kind: "CLOSED" });
    // A null host means the event predates host tracking; anyone with the
    // command's capability may cancel it rather than it being uncancellable.
    if (event.hostDiscordId != null && event.hostDiscordId !== actorDiscordId) {
      return err({ kind: "NOT_HOST" });
    }

    const cancelled = await this.repo.setEventStatus(eventId, "CANCELLED");
    if (!cancelled) return err({ kind: "NOT_FOUND" });
    this.log.info("event cancelled", { eventId, actorDiscordId });
    return ok(cancelled);
  }

  /** RSVP to an event, applying capacity→waitlist. Returns the recorded state. */
  async rsvp(eventId: string, discordId: string, requested: RSVPState): Promise<Result<RsvpOutcome, EventError>> {
    const info = await this.repo.getEventForRsvp(eventId);
    if (!info) return err({ kind: "NOT_FOUND" });
    if (info.status === "COMPLETED" || info.status === "CANCELLED") return err({ kind: "CLOSED" });

    const atCapacity = info.capacity !== null && info.goingCount >= info.capacity;
    const state: RSVPState = requested === "GOING" && atCapacity ? "WAITLIST" : requested;

    await this.repo.upsertRsvp(eventId, discordId, state);
    this.log.info("rsvp recorded", { eventId, discordId, requested, state });

    const event = await this.repo.getEvent(eventId);
    if (!event) return err({ kind: "NOT_FOUND" });
    return ok({ state, waitlisted: state === "WAITLIST" && requested === "GOING", event });
  }

  async getAttendance(eventId: string): Promise<Result<AttendanceDTO, EventError>> {
    const attendance = await this.repo.getAttendance(eventId);
    if (!attendance) return err({ kind: "NOT_FOUND" });
    return ok(attendance);
  }

  // ──────────────────────────────── LFG ────────────────────────────────

  async createLfg(input: NewLfgPost): Promise<Result<LFGPostDTO, LfgError>> {
    if (!Number.isInteger(input.slotsTotal) || input.slotsTotal < 2 || input.slotsTotal > MAX_LFG_SLOTS) {
      return err({ kind: "INVALID_SLOTS", detail: `slots has to be a whole number from 2 to ${MAX_LFG_SLOTS}.` });
    }
    const post = await this.repo.createLfg(input);
    this.log.info("lfg created", { postId: post.id, activity: input.activity, slots: input.slotsTotal });
    return ok(post);
  }

  async listLfg(guildId: string, activity?: LFGActivity): Promise<Result<readonly LFGPostDTO[]>> {
    return ok(await this.repo.listLfg(guildId, activity));
  }

  async joinLfg(postId: string, discordId: string): Promise<Result<LFGPostDTO, LfgError>> {
    const post = await this.repo.getLfg(postId);
    if (!post) return err({ kind: "NOT_FOUND" });
    if (post.status === "EXPIRED" || post.status === "CLOSED") return err({ kind: "CLOSED" });
    if (post.members.includes(discordId)) return err({ kind: "ALREADY_JOINED" });
    if (post.members.length >= post.slotsTotal) return err({ kind: "FULL" });

    const members = [...post.members, discordId];
    const updated = await this.repo.setLfgMembers(postId, members, lfgStatusFor(members.length, post.slotsTotal));
    if (!updated) return err({ kind: "NOT_FOUND" });
    this.log.info("lfg joined", { postId, discordId, filled: members.length });
    return ok(updated);
  }

  async leaveLfg(postId: string, discordId: string): Promise<Result<LFGPostDTO, LfgError>> {
    const post = await this.repo.getLfg(postId);
    if (!post) return err({ kind: "NOT_FOUND" });
    // The author leaving would orphan the post, so they close it instead —
    // otherwise a party could sit open with nobody able to answer questions.
    if (post.authorDiscordId === discordId) return err({ kind: "AUTHOR_CANNOT_LEAVE" });
    if (!post.members.includes(discordId)) return err({ kind: "NOT_A_MEMBER" });

    const members = post.members.filter((id) => id !== discordId);
    const updated = await this.repo.setLfgMembers(postId, members, lfgStatusFor(members.length, post.slotsTotal));
    if (!updated) return err({ kind: "NOT_FOUND" });
    this.log.info("lfg left", { postId, discordId, filled: members.length });
    return ok(updated);
  }

  // ─────────────────────────────── Tickets ───────────────────────────────

  async openTicket(input: NewTicket): Promise<Result<TicketDTO>> {
    const ticket = await this.repo.createTicket(input);
    this.log.info("ticket opened", { ticketId: ticket.id, category: input.category });
    return ok(ticket);
  }

  async closeTicket(ticketId: string, actorDiscordId: string, reason: string | null): Promise<Result<TicketDTO, TicketError>> {
    const ticket = await this.repo.getTicket(ticketId);
    if (!ticket) return err({ kind: "NOT_FOUND" });
    if (ticket.status === "CLOSED" || ticket.status === "RESOLVED") return err({ kind: "ALREADY_CLOSED" });

    const closed = await this.repo.closeTicket(ticketId, actorDiscordId, reason);
    if (!closed) return err({ kind: "NOT_FOUND" });
    this.log.info("ticket closed", { ticketId, actorDiscordId });
    return ok(closed);
  }

  async listTickets(guildId: string, openerDiscordId?: string): Promise<Result<readonly TicketDTO[]>> {
    return ok(await this.repo.listTickets(guildId, openerDiscordId));
  }

  // ───────────────────────────── Applications ─────────────────────────────

  async getApplication(applicationId: string): Promise<Result<ApplicationDTO | null>> {
    return ok(await this.repo.getApplication(applicationId));
  }

  async decideApplication(input: ApplicationDecision): Promise<Result<ApplicationDTO, ApplicationError>> {
    const application = await this.repo.getApplication(input.applicationId);
    if (!application) return err({ kind: "NOT_FOUND" });
    if (application.status !== "SUBMITTED" && application.status !== "UNDER_REVIEW") {
      return err({ kind: "ALREADY_DECIDED", status: application.status });
    }

    const decided = await this.repo.decideApplication(
      input.applicationId,
      input.accept ? "ACCEPTED" : "REJECTED",
      input.reviewerDiscordId,
      input.reason ?? null,
    );
    if (!decided) return err({ kind: "NOT_FOUND" });
    this.log.info("application decided", {
      applicationId: input.applicationId,
      reviewerDiscordId: input.reviewerDiscordId,
      status: decided.status,
    });
    return ok(decided);
  }
}

/** FULL is a derived state, so it is recomputed on every roster change. */
function lfgStatusFor(filled: number, total: number): LFGStatus {
  return filled >= total ? "FULL" : "OPEN";
}
