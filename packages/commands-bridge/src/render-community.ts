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
  PendingLevelUpDTO,
  PendingMilestoneDTO,
  RsvpEntryDTO,
  TicketDTO,
} from "@sbr/shared-types";
import { padInlineRow } from "@sbr/shared-types";

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

export interface EventReminderView {
  readonly eventId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly offsetMinutes: number;
}

/**
 * The "starting soon" notice. The heading says how long is left in words
 * because the reminder is defined by its offset — the relative timestamp beside
 * it will disagree by a few seconds and that is fine, but a reader skimming a
 * channel should not have to hover to learn whether this is the hour warning or
 * the five-minute one.
 */
export function renderEventReminderEmbed(view: EventReminderView): EmbedView {
  return {
    title: `${view.title} — starts ${offsetLabel(view.offsetMinutes)}`,
    description: `${timestampTag(view.startsAt)} (${timestampTag(view.startsAt, "R")})`,
    footer: `id ${view.eventId}`,
    color: "WARNING",
  };
}

function offsetLabel(minutes: number): string {
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `in ${hours} hour${hours === 1 ? "" : "s"}`;
}

export interface EventBoardStandingView {
  readonly discordId: string;
  readonly delta: number;
}

export interface EventBoardView {
  readonly eventId: string;
  readonly title: string;
  readonly status: "SCHEDULED" | "LIVE" | "COMPLETED" | "CANCELLED";
  readonly startsAt: string;
  readonly endsAt?: string | null;
  /** The metric the standings are ordered by, or null when nothing is tracked. */
  readonly metric: string | null;
  readonly participantCount: number;
  readonly standings: readonly EventBoardStandingView[];
  /** When this render was made, for the "last updated" stamp. */
  readonly updatedAt: string;
}

/** Metric keys read as camelCase in the database and as English on the board. */
const METRIC_LABELS: Readonly<Record<string, string>> = {
  skyblockLevel: "SkyBlock level",
  networth: "networth",
  skillAverage: "skill average",
  catacombsLevel: "catacombs level",
  slayerXp: "slayer XP",
  senitherWeight: "weight",
};

export function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? metric;
}

/**
 * Gains, not readings — a board that showed networth would be a rich list, and
 * the event is about what somebody did during it. Large figures are abbreviated
 * because a networth delta is eleven digits and ten of those in a column is
 * unreadable.
 */
export function formatDelta(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "+";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${sign}${trim(abs / 1_000_000_000)}b`;
  if (abs >= 1_000_000) return `${sign}${trim(abs / 1_000_000)}m`;
  if (abs >= 10_000) return `${sign}${trim(abs / 1_000)}k`;
  return `${sign}${trim(abs)}`;
}

function trim(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

const STATUS_LABELS: Readonly<Record<EventBoardView["status"], string>> = {
  SCHEDULED: "starting soon",
  LIVE: "live now",
  COMPLETED: "final results",
  CANCELLED: "cancelled",
};

/**
 * The tracker board: one message per event, posted once and edited in place.
 *
 * It is written to be readable at every stage of an event's life, because it is
 * the same message throughout — a scheduled event shows a countdown and no
 * standings, a live one shows the top of the table, and a completed one is left
 * in the channel as the result card rather than deleted.
 */
export function renderEventBoardEmbed(view: EventBoardView): EmbedView {
  const final = view.status === "COMPLETED" || view.status === "CANCELLED";
  const when = final
    ? `Ended ${timestampTag(view.endsAt == null ? view.updatedAt : view.endsAt, "R")}`
    : `${timestampTag(view.startsAt)} (${timestampTag(view.startsAt, "R")})`;

  const fields: EmbedFieldView[] = [
    { name: view.status === "LIVE" ? "Started" : "Starts", value: when, inline: true },
    { name: "Participants", value: `${view.participantCount}`, inline: true },
  ];

  if (view.metric !== null) {
    const shown = Math.min(view.standings.length, BOARD_STANDINGS);
    fields.push({
      name: shown === 0 ? `Standings · ${metricLabel(view.metric)}` : `Top ${shown} · ${metricLabel(view.metric)}`,
      value: standingsBlock(view.standings),
      inline: false,
    });
  }

  return {
    title: `${view.title} — ${STATUS_LABELS[view.status]}`,
    fields,
    footer: `id ${view.eventId} • updated ${timestampTag(view.updatedAt, "R")}`,
    color: view.status === "CANCELLED" ? "DANGER" : view.status === "LIVE" ? "SUCCESS" : "INFO",
  };
}

/** How many rows the board shows. Ten fits a field without scrolling past it. */
export const BOARD_STANDINGS = 10;

function standingsBlock(standings: readonly EventBoardStandingView[]): string {
  if (standings.length === 0) {
    // Not an error: the first poll of a live event has captured baselines and
    // nothing else, so everyone is legitimately on zero.
    return "No scores yet — the first poll sets everyone's baseline.";
  }
  return standings
    .slice(0, BOARD_STANDINGS)
    .map((s, i) => `**${i + 1}.** <@${s.discordId}> — ${formatDelta(s.delta)}`)
    .join("\n");
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
function mentionList(entries: readonly { readonly discordId: string }[]): string {
  if (entries.length === 0) return "—";
  const shown = entries
    .slice(0, 20)
    .map((e) => `<@${e.discordId}>`)
    .join(", ");
  return entries.length > 20 ? `${shown} +${entries.length - 20} more` : shown;
}

export function renderAttendanceEmbed(attendance: AttendanceDTO): EmbedView {
  const { event } = attendance;
  // Who turned up leads once there is an answer, because after the event that is
  // the question being asked; before it there is no row and the field is absent
  // rather than an empty promise.
  const turnout =
    attendance.attended.length === 0
      ? []
      : [
          {
            name: `Turned up (${attendance.attended.length})`,
            value: mentionList(attendance.attended),
            inline: false,
          },
        ];

  return {
    title: `${event.title} — attendance`,
    description: `${timestampTag(event.startsAt)} • ${capacityLabel(event)}`,
    fields: [
      ...turnout,
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
  const count = `${post.slotsFilled}/${post.slotsTotal}`;
  const embed: EmbedView = {
    // The author's own headline leads when they wrote one; the activity is still
    // legible from the Status row, and a title someone chose is what people scan.
    title: post.title === null ? `${post.activity.toLowerCase()} — ${count}` : `${post.title} — ${count}`,
    fields: [
      { name: "Host", value: `<@${post.authorDiscordId}>`, inline: true },
      { name: "Status", value: statusLine(post), inline: true },
      { name: "Party", value: post.members.map((id) => `<@${id}>`).join(", ") || "—", inline: false },
    ],
    footer: lfgFooter(post),
    color: post.status === "OPEN" ? "SUCCESS" : "NEUTRAL",
  };
  return post.details === null ? embed : { ...embed, description: post.details };
}

/**
 * "closed" and "expired" both end a run, but only one of them was a decision —
 * so a post someone closed says who, and a post that timed out says nothing.
 */
function statusLine(post: LFGPostDTO): string {
  if (post.status === "CLOSED" && post.closedByDiscordId !== null) {
    return `closed by <@${post.closedByDiscordId}>`;
  }
  return `${post.activity.toLowerCase()} • ${post.status.toLowerCase()}`;
}

function lfgFooter(post: LFGPostDTO): string {
  if (post.status !== "OPEN" && post.status !== "FULL") return `id ${post.id}`;
  return post.expiresAt === null ? `id ${post.id}` : `id ${post.id} • expires ${timestampTag(post.expiresAt, "R")}`;
}

/**
 * Join/leave/close. Join is disabled rather than hidden once the post is full,
 * and a finished post keeps its buttons disabled rather than losing them, so the
 * message still reads as the run it was.
 */
export function lfgButtons(post: LFGPostDTO): readonly ActionRowView[] {
  const open = post.status === "OPEN";
  const live = open || post.status === "FULL";
  return [
    {
      buttons: [
        { label: "Join", style: "SUCCESS", customId: `run:${post.id}:join`, disabled: !open },
        { label: "Leave", style: "SECONDARY", customId: `run:${post.id}:leave`, disabled: !live },
        { label: "Close", style: "DANGER", customId: `run:${post.id}:close`, disabled: !live },
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
  const topic = ticket.topic ?? ticket.subject;
  // The inline run is padded on its own rather than at the end of the list: a
  // claimed ticket has four of them, and the full-width fields below mean
  // `padInlineRow` would otherwise see no trailing run to complete.
  const summary = padInlineRow([
    // Null when the guild has deleted the category since. "—" rather than a
    // guess: the ticket really has no category any more.
    { name: "Category", value: ticket.categoryName ?? "—", inline: true },
    { name: "Status", value: ticket.status.toLowerCase(), inline: true },
    { name: "Opened by", value: `<@${ticket.openerDiscordId}>`, inline: true },
    ...(ticket.claimedByDiscordId === null
      ? []
      : [{ name: "Claimed by", value: `<@${ticket.claimedByDiscordId}>`, inline: true }]),
  ]);
  return {
    title: `Ticket #${ticket.number}`,
    fields: [
      ...summary,
      ...(topic === null ? [] : [{ name: "Topic", value: topic, inline: false }]),
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
      name: `#${t.number} ${t.categoryName ?? "—"} — ${t.status.toLowerCase()}`,
      value: `<@${t.openerDiscordId}>${(t.topic ?? t.subject) === null ? "" : ` — ${t.topic ?? t.subject}`} • \`${t.id}\``,
      inline: false,
    })),
    color: "INFO",
  };
}


/**
 * A milestone announcement, as the guild sees it.
 *
 * The IGN leads and the mention follows, because the achievement happened
 * in-game to a name people recognise there — a bare ping would read as a
 * notification rather than as recognition. An unlinked account still gets an
 * announcement, just without the mention.
 */
/**
 * A level-up announcement.
 *
 * The mention leads here, unlike a milestone: levels are earned in this Discord
 * by being present in it, so the person being congratulated is a Discord member
 * first and the notification is the point rather than a side effect.
 *
 * `fromLevel` is carried rather than assumed to be one below: a rebuild after a
 * backfill can move somebody several levels at once, and "12 → 15" is the true
 * story where "reached 15" would quietly hide two of them.
 */
export function renderLevelUpEmbed(levelUp: PendingLevelUpDTO): EmbedView {
  const jumped = levelUp.toLevel - levelUp.fromLevel > 1;
  return {
    title: "Level up",
    description: `<@${levelUp.discordId}> reached **level ${String(levelUp.toLevel)}**.`,
    fields: [
      {
        name: jumped ? "Levels" : "Level",
        value: `${String(levelUp.fromLevel)} → ${String(levelUp.toLevel)}`,
        inline: true,
      },
      { name: "Total XP", value: levelUp.totalXp.toLocaleString("en-US"), inline: true },
      { name: "When", value: timestampTag(levelUp.achievedAt, "R"), inline: true },
    ],
    color: "SUCCESS",
  };
}

export function renderMilestoneEmbed(milestone: PendingMilestoneDTO): EmbedView {
  const who = milestone.ign ?? "A guild member";
  const mention = milestone.discordId === null ? "" : ` (<@${milestone.discordId}>)`;
  return {
    title: "Milestone reached",
    description: `**${who}**${mention} hit **${milestone.label}**.`,
    fields: [{ name: "When", value: timestampTag(milestone.achievedAt, "R"), inline: true }],
    color: "SUCCESS",
  };
}
