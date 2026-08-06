/**
 * Prisma-backed CommunityRepository (satisfies the @sbr/community port).
 * `guildId` is the internal Guild.id.
 */
import type {
  ApplicationDTO,
  EventDTO,
  EventStatus,
  MemberSummaryDTO,
  RSVPState,
} from "@sbr/shared-types";
import { prisma } from "../client.js";

interface EventRsvpInfo {
  status: EventStatus;
  capacity: number | null;
  goingCount: number;
}

export const communityRepository = {
  async listUpcomingEvents(guildId: string): Promise<readonly EventDTO[]> {
    const rows = await prisma.event.findMany({
      where: { guildId, status: { in: ["SCHEDULED", "LIVE"] }, startsAt: { gte: new Date() } },
      orderBy: { startsAt: "asc" },
      include: { _count: { select: { rsvps: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      guildId: r.guildId,
      title: r.title,
      status: r.status as EventDTO["status"],
      startsAt: r.startsAt.toISOString(),
      capacity: r.capacity,
      rsvpCount: r._count.rsvps,
    }));
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
    return rows.map((r) => ({
      id: r.id,
      guildId: r.guildId,
      applicantDiscordId: r.applicantDiscordId,
      status: r.status as ApplicationDTO["status"],
      submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
    }));
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
};
