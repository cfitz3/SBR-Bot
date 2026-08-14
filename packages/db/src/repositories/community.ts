/**
 * Prisma-backed CommunityRepository (satisfies the @sbr/community port).
 * `guildId` is the internal Guild.id.
 */
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
  RsvpEntryDTO,
} from "@sbr/shared-types";
import type { LfgInsert, LfgPatch, TicketPatch } from "@sbr/community";
import { prisma } from "../client.js";
import { ticketConfigRepository } from "./ticket-config.js";
import { ticketRepository } from "./tickets.js";

interface EventRsvpInfo {
  status: EventStatus;
  capacity: number | null;
  goingCount: number;
}

/** Row shapes are structural, so a local alias keeps the mappers readable. */
type EventRow = {
  id: string;
  guildId: string;
  title: string;
  description: string | null;
  type: string;
  status: string;
  startsAt: Date;
  endsAt: Date | null;
  capacity: number | null;
  hostDiscordId: string | null;
};

function toEventDTO(r: EventRow, rsvpCount: number): EventDTO {
  return {
    id: r.id,
    guildId: r.guildId,
    title: r.title,
    status: r.status as EventDTO["status"],
    startsAt: r.startsAt.toISOString(),
    capacity: r.capacity,
    rsvpCount,
    description: r.description,
    type: r.type as NonNullable<EventDTO["type"]>,
    endsAt: r.endsAt ? r.endsAt.toISOString() : null,
    hostDiscordId: r.hostDiscordId,
  };
}

function toLfgDTO(r: {
  id: string;
  guildId: string;
  authorDiscordId: string;
  activity: string;
  title: string | null;
  details: string | null;
  slotsTotal: number;
  slotsFilled: number;
  status: string;
  expiresAt: Date | null;
  createdAt: Date;
  members: string[];
  channelId: string | null;
  messageId: string | null;
  permGroupId: string | null;
  closedAt: Date | null;
  closedByDiscordId: string | null;
}): LFGPostDTO {
  return {
    id: r.id,
    guildId: r.guildId,
    authorDiscordId: r.authorDiscordId,
    activity: r.activity as LFGActivity,
    title: r.title,
    details: r.details,
    slotsTotal: r.slotsTotal,
    slotsFilled: r.slotsFilled,
    status: r.status as LFGStatus,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    members: r.members,
    channelId: r.channelId,
    messageId: r.messageId,
    permGroupId: r.permGroupId,
    closedAt: r.closedAt ? r.closedAt.toISOString() : null,
    closedByDiscordId: r.closedByDiscordId,
  };
}

function toApplicationDTO(r: {
  id: string;
  guildId: string;
  applicantDiscordId: string;
  status: string;
  submittedAt: Date | null;
  reviewerDiscordId: string | null;
  decisionReason: string | null;
  decidedAt: Date | null;
}): ApplicationDTO {
  return {
    id: r.id,
    guildId: r.guildId,
    applicantDiscordId: r.applicantDiscordId,
    status: r.status as ApplicationDTO["status"],
    submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
    reviewerDiscordId: r.reviewerDiscordId,
    decisionReason: r.decisionReason,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
  };
}

export const communityRepository = {
  async listUpcomingEvents(guildId: string): Promise<readonly EventDTO[]> {
    const rows = await prisma.event.findMany({
      where: { guildId, status: { in: ["SCHEDULED", "LIVE"] }, startsAt: { gte: new Date() } },
      orderBy: { startsAt: "asc" },
      include: { _count: { select: { rsvps: true } } },
    });
    return rows.map((r) => toEventDTO(r, r._count.rsvps));
  },

  async listMembers(guildId: string): Promise<readonly MemberSummaryDTO[]> {
    const rows = await prisma.guildMember.findMany({
      where: { guildId },
      include: {
        discordUser: {
          include: {
            linkedAccounts: {
              where: { status: "VERIFIED", isPrimary: true },
              include: { minecraftAccount: true },
              take: 1,
            },
          },
        },
      },
    });
    return rows.map((r) => ({
      guildId: r.guildId,
      discordId: r.discordUser.discordId,
      ign: r.discordUser.linkedAccounts[0]?.minecraftAccount.currentIgn ?? null,
      role: r.role as MemberSummaryDTO["role"],
      status: r.status as MemberSummaryDTO["status"],
      guildRank: r.guildRank,
      joinedAt: r.joinedAt ? r.joinedAt.toISOString() : null,
    }));
  },

  async listApplications(guildId: string): Promise<readonly ApplicationDTO[]> {
    const rows = await prisma.application.findMany({
      where: { guildId, status: { in: ["SUBMITTED", "UNDER_REVIEW"] } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toApplicationDTO);
  },

  /**
   * `/set-role type:member`. Scoped by the Discord id rather than the internal
   * DiscordUser row id, since that is what the command carries.
   */
  async setMemberRole(guildId: string, discordId: string, role: MemberRole): Promise<MemberSummaryDTO | null> {
    const user = await prisma.discordUser.findUnique({ where: { discordId }, select: { id: true } });
    if (!user) return null;
    const updated = await prisma.guildMember.updateMany({
      where: { guildId, discordUserId: user.id },
      data: { role },
    });
    if (updated.count === 0) return null;
    const members = await this.listMembers(guildId);
    return members.find((m) => m.discordId === discordId) ?? null;
  },

  async getEventForRsvp(eventId: string): Promise<EventRsvpInfo | null> {
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { status: true, capacity: true } });
    if (!event) return null;
    const goingCount = await prisma.eventRSVP.count({ where: { eventId, state: "GOING" } });
    return { status: event.status as EventStatus, capacity: event.capacity, goingCount };
  },

  async upsertRsvp(eventId: string, discordId: string, state: RSVPState): Promise<void> {
    await prisma.eventRSVP.upsert({
      where: { eventId_discordId: { eventId, discordId } },
      create: { eventId, discordId, state },
      update: { state },
    });
  },

  // ─────────────────────────────── Events ───────────────────────────────

  async createEvent(input: NewEvent): Promise<EventDTO> {
    const row = await prisma.event.create({
      data: {
        guildId: input.guildId,
        title: input.title,
        description: input.description ?? null,
        type: input.type,
        startsAt: new Date(input.startsAt),
        capacity: input.capacity ?? null,
        hostDiscordId: input.hostDiscordId,
        tracksProgression: input.tracksProgression ?? false,
      },
    });
    return toEventDTO(row, 0);
  },

  async getEvent(eventId: string): Promise<EventDTO | null> {
    const row = await prisma.event.findUnique({
      where: { id: eventId },
      include: { _count: { select: { rsvps: true } } },
    });
    return row ? toEventDTO(row, row._count.rsvps) : null;
  },

  async setEventStatus(eventId: string, status: EventStatus): Promise<EventDTO | null> {
    const row = await prisma.event
      .update({ where: { id: eventId }, data: { status }, include: { _count: { select: { rsvps: true } } } })
      .catch(() => null);
    return row ? toEventDTO(row, row._count.rsvps) : null;
  },

  async getAttendance(eventId: string): Promise<AttendanceDTO | null> {
    const event = await this.getEvent(eventId);
    if (!event) return null;
    const rows = await prisma.eventRSVP.findMany({ where: { eventId }, orderBy: { respondedAt: "asc" } });
    const entries: RsvpEntryDTO[] = rows.map((r) => ({
      discordId: r.discordId,
      state: r.state as RSVPState,
      respondedAt: r.respondedAt.toISOString(),
    }));
    const of = (state: RSVPState): RsvpEntryDTO[] => entries.filter((e) => e.state === state);
    return {
      event,
      going: of("GOING"),
      maybe: of("MAYBE"),
      declined: of("NOT_GOING"),
      waitlist: of("WAITLIST"),
    };
  },

  // ──────────────────────────────── LFG ────────────────────────────────

  async createLfg(input: LfgInsert): Promise<LFGPostDTO> {
    const expiresAt =
      input.expiresInMinutes === undefined ? null : new Date(Date.now() + input.expiresInMinutes * 60_000);
    const members = [...input.members];
    const row = await prisma.lFGPost.create({
      data: {
        guildId: input.guildId,
        authorDiscordId: input.authorDiscordId,
        activity: input.activity,
        title: input.title,
        details: input.details,
        slotsTotal: input.slotsTotal,
        // The author holds the first slot, so a fresh post reads 1/5 not 0/5;
        // an autofilled roster starts higher still.
        slotsFilled: members.length,
        members,
        permGroupId: input.permGroupId,
        status: members.length >= input.slotsTotal ? "FULL" : "OPEN",
        expiresAt,
      },
    });
    return toLfgDTO(row);
  },

  async getLfg(postId: string): Promise<LFGPostDTO | null> {
    const row = await prisma.lFGPost.findUnique({ where: { id: postId } });
    return row ? toLfgDTO(row) : null;
  },

  async listLfg(guildId: string, activity?: LFGActivity): Promise<readonly LFGPostDTO[]> {
    const rows = await prisma.lFGPost.findMany({
      where: {
        guildId,
        status: { in: ["OPEN", "FULL"] },
        ...(activity === undefined ? {} : { activity }),
        // Expiry is lazy: rather than a sweeper job, posts past their time are
        // simply filtered out of every read.
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: "desc" },
      take: 25,
    });
    return rows.map(toLfgDTO);
  },

  async setLfgMembers(postId: string, members: readonly string[], status: LFGStatus): Promise<LFGPostDTO | null> {
    const row = await prisma.lFGPost
      .update({ where: { id: postId }, data: { members: [...members], slotsFilled: members.length, status } })
      .catch(() => null);
    return row ? toLfgDTO(row) : null;
  },

  async updateLfg(postId: string, patch: LfgPatch): Promise<LFGPostDTO | null> {
    // Spread-with-undefined would write nulls over the fields nobody touched,
    // so each key is only added when the caller actually supplied it.
    const data: Record<string, unknown> = {};
    if (patch.title !== undefined) data["title"] = patch.title;
    if (patch.details !== undefined) data["details"] = patch.details;
    if (patch.slotsTotal !== undefined) data["slotsTotal"] = patch.slotsTotal;
    if (patch.status !== undefined) data["status"] = patch.status;
    const row = await prisma.lFGPost.update({ where: { id: postId }, data }).catch(() => null);
    return row ? toLfgDTO(row) : null;
  },

  async closeLfg(postId: string, closedByDiscordId: string, closedAt: Date): Promise<LFGPostDTO | null> {
    const row = await prisma.lFGPost
      .update({ where: { id: postId }, data: { status: "CLOSED", closedAt, closedByDiscordId } })
      .catch(() => null);
    return row ? toLfgDTO(row) : null;
  },

  async bindLfgMessage(postId: string, channelId: string, messageId: string): Promise<LFGPostDTO | null> {
    const row = await prisma.lFGPost
      .update({ where: { id: postId }, data: { channelId, messageId } })
      .catch(() => null);
    return row ? toLfgDTO(row) : null;
  },

  // Tickets are delegated wholesale to `ticketRepository`, which owns the
  // per-guild number allocation and the transcript store. Two mappers for one
  // table would let the panel and the bots disagree about what a ticket is.

  createTicket: (input: NewTicket) =>
    ticketRepository.create({
      guildId: input.guildId,
      openerDiscordId: input.openerDiscordId,
      categoryId: input.categoryId,
      topic: input.topic ?? null,
      answers: input.answers ?? {},
      channelId: input.channelId ?? null,
    }),

  getTicket: (ticketId: string) => ticketRepository.byId(ticketId),

  getTicketByChannel: (channelId: string) => ticketRepository.byChannel(channelId),

  patchTicket: (ticketId: string, patch: TicketPatch) => ticketRepository.patch(ticketId, patch),

  listTickets: (guildId: string, openerDiscordId?: string) =>
    ticketRepository.listOpen(guildId, openerDiscordId),

  // Delegated rather than inlined: the same list backs the panel editor and the
  // member's menu, and two queries that ordered or filtered differently would
  // let a member open a category the editor says is switched off.
  listTicketCategories: (guildId: string) => ticketConfigRepository.listCategories(guildId),

  // ───────────────────────────── Applications ─────────────────────────────

  async getApplication(applicationId: string): Promise<ApplicationDTO | null> {
    const row = await prisma.application.findUnique({ where: { id: applicationId } });
    return row ? toApplicationDTO(row) : null;
  },

  async decideApplication(
    applicationId: string,
    status: ApplicationStatus,
    reviewerDiscordId: string,
    reason: string | null,
  ): Promise<ApplicationDTO | null> {
    const row = await prisma.application
      .update({
        where: { id: applicationId },
        data: { status, reviewerDiscordId, decisionReason: reason, decidedAt: new Date() },
      })
      .catch(() => null);
    return row ? toApplicationDTO(row) : null;
  },
};
