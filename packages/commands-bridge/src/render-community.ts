/**
 * View models for the community surface — events, RSVP, LFG, tickets and
 * applications (COMMANDS.md §6–§8). Split from `render.ts`, which is about
 * Hypixel-backed stats: nothing here is an envelope, so none of it carries a
 * staleness footer, and keeping the two apart stops that distinction blurring.
 */
import type {
  ActionRowView,
  AttendanceDTO,
  EmbedFieldView,
  EmbedView,
  EventDTO,
  LFGPostDTO,
  RsvpEntryDTO,
  TicketDTO,
} from "@sbr/shared-types";

/**
 * Discord renders `<t:unix:R>` as a live relative timestamp in the viewer's own
 * locale, which beats baking a formatted date into the string. Falls back to the
 * raw ISO value when it can't be parsed rather than printing "NaN".
 */
export function timestampTag(iso: string, style: "R" | "f" = "f"): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:${style}>` : iso;
}

function capacityLabel(event: EventDTO): string {
  return event.capacity === null ? `${event.rsvpCount} going` : `${event.rsvpCount}/${event.capacity}`;
}

export function renderEventsEmbed(events: readonly EventDTO[]): EmbedView {
  if (events.length === 0) {
    return { title: "Upcoming events", description: "Nothing scheduled right now.", color: "NEUTRAL" };
  }
  return {
    title: "Upcoming events",
    fields: events.slice(0, 10).map((e) => ({
      name: `${e.title}${e.type === undefined ? "" : ` · ${e.type.toLowerCase()}`}`,
      value: `${timestampTag(e.startsAt)} (${timestampTag(e.startsAt, "R")}) • ${capacityLabel(e)} • \`${e.id}\``,
      inline: false,
    })),
    footer: "RSVP with /rsvp event:<id> or the buttons on the event post.",
    color: "INFO",
  };
}

export function renderEventEmbed(event: EventDTO): EmbedView {
  const fields: EmbedFieldView[] = [
    { name: "Starts", value: `${timestampTag(event.startsAt)} (${timestampTag(event.startsAt, "R")})`, inline: true },
    { name: "Capacity", value: event.capacity === null ? "unlimited" : `${event.capacity}`, inline: true },
    { name: "Host", value: event.hostDiscordId == null ? "—" : `<@${event.hostDiscordId}>`, inline: true },
  ];
  const embed: EmbedView = {
    title: event.title,
    fields,
    footer: `id ${event.id}`,
    color: event.status === "CANCELLED" ? "DANGER" : "INFO",
  };
  return event.description == null ? embed : { ...embed, description: event.description };
}

/** RSVP buttons carry the event id, so they keep working across restarts. */
export function rsvpButtons(eventId: string): readonly ActionRowView[] {
  return [
    {
      buttons: [
        { label: "Going", style: "SUCCESS", customId: `rsvp:${eventId}:GOING` },
        { label: "Maybe", style: "SECONDARY", customId: `rsvp:${eventId}:MAYBE` },
        { label: "Can't make it", style: "DANGER", customId: `rsvp:${eventId}:NOT_GOING` },
      ],
    },
  ];
}

/** Caps the mention list: 40 pings in one field is a wall, and Discord's field limit is 1024 chars. */
function mentionList(entries: readonly RsvpEntryDTO[]): string {
  if (entries.length === 0) return "—";
  const shown = entries
    .slice(0, 20)
    .map((e) => `<@${e.discordId}>`)
    .join(", ");
  return entries.length > 20 ? `${shown} +${entries.length - 20} more` : shown;
}

export function renderAttendanceEmbed(attendance: AttendanceDTO): EmbedView {
  const { event } = attendance;
  return {
    title: `${event.title} — attendance`,
    description: `${timestampTag(event.startsAt)} • ${capacityLabel(event)}`,
    fields: [
      { name: `Going (${attendance.going.length})`, value: mentionList(attendance.going), inline: false },
      { name: `Maybe (${attendance.maybe.length})`, value: mentionList(attendance.maybe), inline: false },
      { name: `Waitlist (${attendance.waitlist.length})`, value: mentionList(attendance.waitlist), inline: false },
      { name: `Declined (${attendance.declined.length})`, value: mentionList(attendance.declined), inline: false },
    ],
    footer: `id ${event.id}`,
    color: "INFO",
  };
}

export function renderLfgEmbed(post: LFGPostDTO): EmbedView {
  const embed: EmbedView = {
    title: `${post.activity.toLowerCase()} — ${post.slotsFilled}/${post.slotsTotal}`,
    fields: [
      { name: "Host", value: `<@${post.authorDiscordId}>`, inline: true },
      { name: "Status", value: post.status.toLowerCase(), inline: true },
      { name: "Party", value: post.members.map((id) => `<@${id}>`).join(", ") || "—", inline: false },
    ],
    footer: post.expiresAt === null ? `id ${post.id}` : `id ${post.id} • expires ${timestampTag(post.expiresAt, "R")}`,
    color: post.status === "OPEN" ? "SUCCESS" : "NEUTRAL",
  };
  return post.details === null ? embed : { ...embed, description: post.details };
}

/** Join/leave buttons. Join is disabled rather than hidden once the post is full. */
export function lfgButtons(post: LFGPostDTO): readonly ActionRowView[] {
  const open = post.status === "OPEN";
  return [
    {
      buttons: [
        { label: "Join", style: "SUCCESS", customId: `run:${post.id}:join`, disabled: !open },
        { label: "Leave", style: "SECONDARY", customId: `run:${post.id}:leave` },
      ],
    },
  ];
}

export function renderLfgListEmbed(posts: readonly LFGPostDTO[]): EmbedView {
  if (posts.length === 0) {
    return { title: "Open runs", description: "No open runs right now. Start one with /lfg.", color: "NEUTRAL" };
  }
  return {
    title: "Open runs",
    fields: posts.slice(0, 10).map((p) => ({
      name: `${p.activity.toLowerCase()} — ${p.slotsFilled}/${p.slotsTotal}`,
      value: `<@${p.authorDiscordId}>${p.details === null ? "" : ` — ${p.details}`} • \`${p.id}\``,
      inline: false,
    })),
    footer: "Join with /joinrun id:<id>.",
    color: "INFO",
  };
}

export function renderTicketEmbed(ticket: TicketDTO): EmbedView {
  return {
    title: `Ticket ${ticket.id}`,
    fields: [
      { name: "Category", value: ticket.category.toLowerCase(), inline: true },
      { name: "Status", value: ticket.status.toLowerCase(), inline: true },
      { name: "Opened by", value: `<@${ticket.openerDiscordId}>`, inline: true },
      ...(ticket.subject === null ? [] : [{ name: "Subject", value: ticket.subject, inline: false }]),
      ...(ticket.closeReason === null ? [] : [{ name: "Closed because", value: ticket.closeReason, inline: false }]),
    ],
    color: ticket.status === "OPEN" || ticket.status === "PENDING" ? "INFO" : "NEUTRAL",
  };
}

export function renderTicketListEmbed(tickets: readonly TicketDTO[]): EmbedView {
  if (tickets.length === 0) {
    return { title: "Open tickets", description: "No open tickets.", color: "NEUTRAL" };
  }
  return {
    title: "Open tickets",
    fields: tickets.slice(0, 10).map((t) => ({
      name: `${t.category.toLowerCase()} — ${t.status.toLowerCase()}`,
      value: `<@${t.openerDiscordId}>${t.subject === null ? "" : ` — ${t.subject}`} • \`${t.id}\``,
      inline: false,
    })),
    color: "INFO",
  };
}

