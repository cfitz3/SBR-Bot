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
  type AttendanceEdit,
  type CommunityService,
  type EventDTO,
  type EventEdit,
  type EventError,
  type LFGActivity,
  type LFGPostDTO,
  type LFGStatus,
  type LfgEdit,
  type LfgError,
  type MemberRole,
  type MemberSummaryDTO,
  type NewEvent,
  type NewLfgPost,
  type NewTicket,
  type RSVPState,
  type Result,
  type RsvpOutcome,
  type TicketActor,
  type TicketCategoryDTO,
  type TicketDTO,
  type TicketError,
  type RoleDirtyMarker,
} from "@sbr/shared-types";
import {
  canAct,
  categoryById,
  claim,
  close,
  release,
  requestClose,
  transfer,
  type LifecycleResult,
} from "@sbr/tickets";
import type { Logger } from "@sbr/observability";
import type {
  CommunityRepository,
  EventPatch,
  LfgPatch,
  PermRoster,
  PermRosterLookup,
  TicketPatch,
} from "./ports.js";

/** Retained for the pre-Stage-5 call sites; `EventError` is the current union. */
export type RsvpError = EventError;

/**
 * How often the tracker may poll, in minutes.
 *
 * The floor is the Hypixel budget talking: every poll is one profile fetch per
 * participant, and a five-minute cadence on a forty-person event is already the
 * busiest thing the fleet does. The ceiling is a day, past which "tracked" and
 * "not tracked" stop being different.
 */
const MIN_POLL_MINUTES = 5;
const MAX_POLL_MINUTES = 1440;

/** More columns than this and the board stops fitting in an embed. */
const MAX_TRACKED_METRICS = 5;

/** A post can be joined by at most this many people regardless of what was asked for. */
const MAX_LFG_SLOTS = 20;

export interface CommunityServiceDeps {
  readonly repo: CommunityRepository;
  readonly logger: Logger;
  /**
   * Told when an event completes, because attendance is an auto-role trigger.
   * Optional: without it the reconciler's daily sweep still catches up.
   */
  readonly rolesDirty?: RoleDirtyMarker;
  /** Injected so tests can pin "now" when validating event start times. */
  readonly now?: () => Date;
  /**
   * Resolves `/lfg perm:`. Optional: without it every post starts as just the
   * author, which is the pre-Phase-4 behaviour and not a failure.
   */
  readonly perms?: PermRosterLookup;
}

export class CommunityServiceImpl implements CommunityService {
  private readonly repo: CommunityRepository;
  private readonly log: Logger;
  private readonly now: () => Date;
  private readonly perms: PermRosterLookup | undefined;
  private readonly rolesDirty: RoleDirtyMarker | undefined;

  constructor(deps: CommunityServiceDeps) {
    this.repo = deps.repo;
    this.log = deps.logger.child({ service: "community" });
    this.now = deps.now ?? ((): Date => new Date());
    this.perms = deps.perms;
    this.rolesDirty = deps.rolesDirty;
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

  /**
   * Change an event that has not finished.
   *
   * The host rule is `cancelEvent`'s, for the same reason: an event belongs to
   * whoever is running it, and staff pass `isStaff` to act above that rather
   * than the panel quietly editing on someone else's behalf. Only the fields
   * present are written, so two people editing different halves of the same
   * event do not overwrite each other.
   */
  async updateEvent(input: EventEdit): Promise<Result<EventDTO, EventError>> {
    const event = await this.repo.getEvent(input.eventId);
    if (!event) return err({ kind: "NOT_FOUND" });
    if (event.status === "CANCELLED" || event.status === "COMPLETED") return err({ kind: "CLOSED" });
    if (!this.mayAct(event, input.actorDiscordId, input.isStaff)) return err({ kind: "NOT_HOST" });

    const patch: EventPatch = {};
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (title.length === 0) return err({ kind: "INVALID_TIME", detail: "an event needs a title." });
      Object.assign(patch, { title });
    }
    if (input.description !== undefined) Object.assign(patch, { description: input.description });

    if (input.startsAt !== undefined) {
      const startsAt = new Date(input.startsAt);
      if (Number.isNaN(startsAt.getTime())) {
        return err({ kind: "INVALID_TIME", detail: "I couldn't read that start time." });
      }
      // A LIVE event's start is in the past by definition, so the future rule
      // only applies while it is still scheduled.
      if (event.status === "SCHEDULED" && startsAt.getTime() <= this.now().getTime()) {
        return err({ kind: "INVALID_TIME", detail: "that start time is in the past." });
      }
      Object.assign(patch, { startsAt });
    }

    if (input.capacity !== undefined) {
      if (input.capacity !== null && (!Number.isInteger(input.capacity) || input.capacity < 1)) {
        return err({ kind: "INVALID_TIME", detail: "capacity has to be at least 1." });
      }
      Object.assign(patch, { capacity: input.capacity });
    }

    if (input.pollIntervalMinutes !== undefined) {
      const minutes = input.pollIntervalMinutes;
      if (!Number.isInteger(minutes) || minutes < MIN_POLL_MINUTES || minutes > MAX_POLL_MINUTES) {
        return err({
          kind: "INVALID_TIME",
          detail: `the tracker polls every ${MIN_POLL_MINUTES} to ${MAX_POLL_MINUTES} minutes.`,
        });
      }
      Object.assign(patch, { pollIntervalMinutes: minutes });
    }

    if (input.trackedMetrics !== undefined) {
      // Deduplicated in order: the first metric is the one the board sorts by,
      // and a list with a repeat would otherwise render the same column twice.
      const metrics = [...new Set(input.trackedMetrics.map((m) => m.trim()).filter((m) => m.length > 0))];
      if (metrics.length > MAX_TRACKED_METRICS) {
        return err({ kind: "INVALID_TIME", detail: `an event can score at most ${MAX_TRACKED_METRICS} metrics.` });
      }
      Object.assign(patch, { trackedMetrics: metrics });
    }

    if (input.tracksProgression !== undefined) Object.assign(patch, { tracksProgression: input.tracksProgression });

    const updated = await this.repo.updateEvent(input.eventId, patch);
    if (!updated) return err({ kind: "NOT_FOUND" });
    this.log.info("event updated", { eventId: input.eventId, actorDiscordId: input.actorDiscordId });
    return ok(updated);
  }

  /**
   * Mark an event as run.
   *
   * `endsAt` is stamped here rather than left to the scheduler because it is
   * what the tracker board reads to write its result card: an event with no end
   * time is one that is still going, and the board would keep redrawing.
   */
  async completeEvent(eventId: string, actorDiscordId: string, isStaff?: boolean): Promise<Result<EventDTO, EventError>> {
    const event = await this.repo.getEvent(eventId);
    if (!event) return err({ kind: "NOT_FOUND" });
    if (event.status === "CANCELLED" || event.status === "COMPLETED") return err({ kind: "CLOSED" });
    if (!this.mayAct(event, actorDiscordId, isStaff)) return err({ kind: "NOT_HOST" });

    const completed = await this.repo.updateEvent(eventId, { status: "COMPLETED", endsAt: this.now() });
    if (!completed) return err({ kind: "NOT_FOUND" });

    // Everyone the poller scored was demonstrably there, so the list starts
    // populated rather than empty. It happens here rather than in the tracker
    // because "the event is over" is the only moment the set stops growing —
    // and a host who then corrects it is correcting something, not typing a
    // roster from memory.
    const tracked = await this.repo.recordTrackedAttendance(eventId);
    // Completion is the moment an attendance count changes, so it is the moment
    // an "attended N events" rule can start qualifying. Best effort: a host does
    // not get an error because Redis was busy.
    if (this.rolesDirty !== undefined && tracked > 0) {
      const attendance = await this.repo.getAttendance(eventId).catch(() => null);
      const ids = attendance?.attended.map((a) => a.discordId) ?? [];
      if (ids.length > 0) await this.rolesDirty.mark(completed.guildId, ids).catch(() => undefined);
    }
    this.log.info("event completed", { eventId, actorDiscordId, tracked });
    return ok(completed);
  }

  /**
   * A null host means the event predates host tracking; anyone holding the
   * command's capability may act on it rather than it becoming unmanageable.
   */
  private mayAct(event: EventDTO, actorDiscordId: string, isStaff?: boolean): boolean {
    if (isStaff === true) return true;
    return event.hostDiscordId == null || event.hostDiscordId === actorDiscordId;
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

  async markAttendance(input: AttendanceEdit): Promise<Result<AttendanceDTO, EventError>> {
    const event = await this.repo.getEvent(input.eventId);
    if (!event) return err({ kind: "NOT_FOUND" });
    if (event.status === "CANCELLED") return err({ kind: "CLOSED" });
    if (!this.mayAct(event, input.actorDiscordId, input.isStaff)) return err({ kind: "NOT_HOST" });

    // Ids are deduplicated and blanks dropped for the same reason the metric
    // list is: the same person marked twice is one person who turned up, and a
    // blank is a form artefact rather than a member.
    const seen = new Set<string>();
    for (const raw of input.discordIds) {
      const id = raw.trim();
      if (id.length > 0) seen.add(id);
    }

    await this.repo.setAttendance(input.eventId, [...seen], input.actorDiscordId);
    this.log.info("attendance marked", {
      eventId: input.eventId,
      actorDiscordId: input.actorDiscordId,
      marked: seen.size,
    });

    const attendance = await this.repo.getAttendance(input.eventId);
    if (!attendance) return err({ kind: "NOT_FOUND" });
    return ok(attendance);
  }

  // ──────────────────────────────── LFG ────────────────────────────────

  async createLfg(input: NewLfgPost): Promise<Result<LFGPostDTO, LfgError>> {
    if (!Number.isInteger(input.slotsTotal) || input.slotsTotal < 2 || input.slotsTotal > MAX_LFG_SLOTS) {
      return err({ kind: "INVALID_SLOTS", detail: `slots has to be a whole number from 2 to ${MAX_LFG_SLOTS}.` });
    }

    const roster = await this.resolvePerm(input);
    if (roster !== null && "kind" in roster) return err(roster);

    // The author always holds the first seat, and the perm can only fill what is
    // left: asking for 4 slots and having a 5-person perm posts 4, not 5.
    const members = [input.authorDiscordId];
    for (const id of roster?.discordIds ?? []) {
      if (members.length >= input.slotsTotal) break;
      if (!members.includes(id)) members.push(id);
    }

    const post = await this.repo.createLfg({
      guildId: input.guildId,
      authorDiscordId: input.authorDiscordId,
      activity: input.activity,
      title: input.title ?? null,
      details: input.details ?? null,
      slotsTotal: input.slotsTotal,
      ...(input.expiresInMinutes === undefined ? {} : { expiresInMinutes: input.expiresInMinutes }),
      permGroupId: roster?.id ?? null,
      members,
    });
    this.log.info("lfg created", {
      postId: post.id,
      activity: input.activity,
      slots: input.slotsTotal,
      filled: members.length,
      permGroupId: post.permGroupId,
    });
    return ok(post);
  }

  /**
   * Turns `perm:` into a roster, or into the error to report.
   *
   * Returns the roster (or null for "no autofill") on success and an `LfgError`
   * on failure — a plain union rather than a Result because the caller only ever
   * unwraps it once, right here.
   */
  private async resolvePerm(input: NewLfgPost): Promise<PermRoster | null | LfgError> {
    if (input.perm === undefined || input.perm === false) return null;

    if (!this.perms) {
      // Only worth complaining about when a specific perm was named; `perm: true`
      // on a deployment without perms wired in is just an ordinary solo post.
      if (typeof input.perm === "string") {
        return { kind: "NO_SUCH_PERM", detail: "Perms are not available on this server." };
      }
      return null;
    }

    if (typeof input.perm === "string") {
      const named = await this.perms.namedRoster(input.guildId, input.authorDiscordId, input.perm);
      if (!named) return { kind: "NO_SUCH_PERM", detail: `You have no perm called "${input.perm}".` };
      return named;
    }
    // A missing default is not an error: "bring my usual party" from someone with
    // no usual party is a perfectly ordinary request for a post of one.
    return await this.perms.defaultRoster(input.guildId, input.authorDiscordId, input.activity);
  }

  async listLfg(guildId: string, activity?: LFGActivity): Promise<Result<readonly LFGPostDTO[]>> {
    return ok(await this.repo.listLfg(guildId, activity));
  }

  async getLfg(postId: string): Promise<Result<LFGPostDTO | null>> {
    return ok(await this.repo.getLfg(postId));
  }

  async editLfg(input: LfgEdit): Promise<Result<LFGPostDTO, LfgError>> {
    const post = await this.repo.getLfg(input.postId);
    if (!post) return err({ kind: "NOT_FOUND" });
    if (post.authorDiscordId !== input.actorDiscordId && input.isStaff !== true) {
      return err({ kind: "NOT_YOURS" });
    }
    if (post.status === "EXPIRED" || post.status === "CLOSED") return err({ kind: "CLOSED" });

    const patch: LfgPatch = {};
    if (input.title !== undefined) Object.assign(patch, { title: input.title });
    if (input.details !== undefined) Object.assign(patch, { details: input.details });

    if (input.slotsTotal !== undefined) {
      if (!Number.isInteger(input.slotsTotal) || input.slotsTotal < 2 || input.slotsTotal > MAX_LFG_SLOTS) {
        return err({ kind: "INVALID_SLOTS", detail: `slots has to be a whole number from 2 to ${MAX_LFG_SLOTS}.` });
      }
      // Shrinking below the roster would mean kicking somebody as a side effect
      // of an edit, which is not a thing an edit should quietly do.
      if (input.slotsTotal < post.members.length) {
        return err({
          kind: "SLOTS_BELOW_ROSTER",
          detail: `${post.members.length} people are already in — remove someone before shrinking to ${input.slotsTotal}.`,
        });
      }
      Object.assign(patch, {
        slotsTotal: input.slotsTotal,
        // Raising the cap on a full post has to reopen it, or nobody could join
        // the seat that was just created.
        status: lfgStatusFor(post.members.length, input.slotsTotal),
      });
    }

    const updated = await this.repo.updateLfg(input.postId, patch);
    if (!updated) return err({ kind: "NOT_FOUND" });
    this.log.info("lfg edited", { postId: input.postId, actorDiscordId: input.actorDiscordId, fields: Object.keys(patch) });
    return ok(updated);
  }

  async closeLfg(postId: string, actorDiscordId: string, isStaff?: boolean): Promise<Result<LFGPostDTO, LfgError>> {
    const post = await this.repo.getLfg(postId);
    if (!post) return err({ kind: "NOT_FOUND" });
    if (post.authorDiscordId !== actorDiscordId && isStaff !== true) return err({ kind: "NOT_YOURS" });
    if (post.status === "CLOSED" || post.status === "EXPIRED") return err({ kind: "CLOSED" });

    const closed = await this.repo.closeLfg(postId, actorDiscordId, this.now());
    if (!closed) return err({ kind: "NOT_FOUND" });
    this.log.info("lfg closed", { postId, actorDiscordId, staff: isStaff === true });
    return ok(closed);
  }

  async bindLfgMessage(postId: string, channelId: string, messageId: string): Promise<Result<LFGPostDTO, LfgError>> {
    const bound = await this.repo.bindLfgMessage(postId, channelId, messageId);
    if (!bound) return err({ kind: "NOT_FOUND" });
    return ok(bound);
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

  async openTicket(input: NewTicket): Promise<Result<TicketDTO, TicketError>> {
    const ticket = await this.repo.createTicket(input);
    this.log.info("ticket opened", { ticketId: ticket.id, number: ticket.number, categoryId: input.categoryId });
    return ok(ticket);
  }

  /**
   * Every mutating call funnels through here: load the ticket, ask
   * `@sbr/tickets` whether this actor may do this, and only then write.
   *
   * The old surface took a bare ticket id and asked nobody's permission, so any
   * member who could read an id could close anyone's ticket. Routing all six
   * transitions through one gate is what makes that unrepeatable — a new
   * transition cannot forget the check, because it cannot reach the repository
   * without passing one.
   */
  private async transition(
    ticketId: string,
    actor: TicketActor,
    decide: (ticket: TicketDTO, category: TicketCategoryDTO | null) => LifecycleResult<TicketPatch>,
  ): Promise<Result<TicketDTO, TicketError>> {
    const ticket = await this.repo.getTicket(ticketId);
    if (!ticket) return err({ kind: "NOT_FOUND" });

    const categories = await this.repo.listTicketCategories(ticket.guildId);
    const category = categoryById(categories, ticket.categoryId);

    const decision = decide(ticket, category);
    if (!decision.ok) {
      return err(decision.reason === "ALREADY_CLOSED" ? { kind: "ALREADY_CLOSED" } : { kind: "FORBIDDEN" });
    }

    const updated = await this.repo.patchTicket(ticketId, decision.value);
    if (!updated) return err({ kind: "NOT_FOUND" });
    return ok(updated);
  }

  async closeTicket(ticketId: string, actor: TicketActor, reason: string | null): Promise<Result<TicketDTO, TicketError>> {
    const result = await this.transition(ticketId, actor, (ticket) => {
      const decision = close(ticket, actor);
      if (!decision.ok) return decision;
      return {
        ok: true,
        value: { status: "CLOSED", closeReason: reason, closedAt: this.now(), assigneeDiscordId: actor.discordId },
      };
    });
    if (result.ok) this.log.info("ticket closed", { ticketId, actor: actor.discordId });
    return result;
  }

  async requestTicketClose(ticketId: string, actor: TicketActor): Promise<Result<TicketDTO, TicketError>> {
    return this.transition(ticketId, actor, (ticket) => {
      const decision = requestClose(ticket, actor, this.now());
      if (!decision.ok) return decision;
      return {
        ok: true,
        value: {
          closeRequestedByDiscordId: decision.value.closeRequestedByDiscordId,
          closeRequestedAt: decision.value.closeRequestedAt,
        },
      };
    });
  }

  async claimTicket(ticketId: string, actor: TicketActor): Promise<Result<TicketDTO, TicketError>> {
    return this.transition(ticketId, actor, (ticket, category) => {
      // A category that has since been deleted is treated as claimable: the
      // ticket still needs an owner, and refusing here would strand it.
      const decision = claim(ticket, actor, category?.claiming ?? true, this.now());
      if (!decision.ok) return decision;
      return {
        ok: true,
        value: { claimedByDiscordId: decision.value.claimedByDiscordId, claimedAt: decision.value.claimedAt },
      };
    });
  }

  async releaseTicket(ticketId: string, actor: TicketActor): Promise<Result<TicketDTO, TicketError>> {
    return this.transition(ticketId, actor, (ticket) => {
      const decision = release(ticket, actor);
      if (!decision.ok) return decision;
      return { ok: true, value: { claimedByDiscordId: null, claimedAt: null } };
    });
  }

  async transferTicket(ticketId: string, actor: TicketActor, toDiscordId: string): Promise<Result<TicketDTO, TicketError>> {
    return this.transition(ticketId, actor, (ticket) => {
      const decision = transfer(ticket, actor, toDiscordId, this.now());
      if (!decision.ok) return decision;
      return {
        ok: true,
        value: { claimedByDiscordId: decision.value.claimedByDiscordId, claimedAt: decision.value.claimedAt },
      };
    });
  }

  async setTicketTopic(ticketId: string, actor: TicketActor, topic: string): Promise<Result<TicketDTO, TicketError>> {
    return this.transition(ticketId, actor, (ticket) => {
      if (ticket.status === "CLOSED") return { ok: false, reason: "ALREADY_CLOSED" };
      if (!canAct(ticket, actor)) return { ok: false, reason: "FORBIDDEN" };
      return { ok: true, value: { topic } };
    });
  }

  async getTicket(ticketId: string): Promise<Result<TicketDTO | null>> {
    return ok(await this.repo.getTicket(ticketId));
  }

  async getTicketByChannel(channelId: string): Promise<Result<TicketDTO | null>> {
    return ok(await this.repo.getTicketByChannel(channelId));
  }

  async listTickets(guildId: string, openerDiscordId?: string): Promise<Result<readonly TicketDTO[]>> {
    return ok(await this.repo.listTickets(guildId, openerDiscordId));
  }

  /**
   * Every category in menu order. Disabled ones are kept and flagged;
   * `openableCategories` is what narrows the list to a member's menu.
   */
  async listTicketCategories(guildId: string): Promise<Result<readonly TicketCategoryDTO[]>> {
    return ok(await this.repo.listTicketCategories(guildId));
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
