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
  ViewColor,
} from "@sbr/shared-types";
import { copy } from "@sbr/brand";
import { card, facts, field, type Fact } from "@sbr/embed-kit";
import { eventMetricFormat, isEventMetric, padInlineRow } from "@sbr/shared-types";

/**
 * The event card's own words, read once. Same split as `render.ts` uses: `C`
 * is per-card copy, `F` is the field names shared across cards.
 */
const C = copy.embed.card;
const F = copy.embed.field;

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

/**
 * One event, from the DTO a command holds.
 *
 * An adapter rather than a second renderer: a member who sees the event message
 * in the events channel and then runs a command about the same event should be
 * looking at the same card, not at a smaller relative of it. Everything the DTO
 * cannot say — who is on the roster, what the standings are — is simply absent,
 * and the card is built to render without it.
 */
export function renderEventEmbed(event: EventDTO): EmbedView {
  return renderEventCard({
    eventId: event.id,
    title: event.title,
    status: event.status === "CANCELLED" ? "CANCELLED" : "SCHEDULED",
    startsAt: event.startsAt,
    description: event.description ?? null,
    hostDiscordId: event.hostDiscordId ?? null,
    capacity: event.capacity,
    participantCount: event.rsvpCount,
    updatedAt: new Date().toISOString(),
  });
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

/**
 * One event, at whatever stage of its life it is in.
 *
 * There is one message per event and this renders all of it: the signup roster
 * before it starts, the live table while it runs, the result card afterwards.
 * That is why almost every field is optional — the same view is assembled from
 * a full board read, from an events-page row, and from a command's DTO, and a
 * caller that cannot answer a question leaves it out rather than inventing an
 * answer for it.
 */
export interface EventCardView {
  readonly eventId: string;
  readonly title: string;
  readonly status: "SCHEDULED" | "LIVE" | "COMPLETED" | "CANCELLED";
  readonly startsAt: string;
  readonly endsAt?: string | null;
  /** The organiser's own words about the event. */
  readonly description?: string | null;
  readonly hostDiscordId?: string | null;
  readonly capacity?: number | null;
  /**
   * The one metric this event scores, or null for an event that scores nothing.
   *
   * One rather than a list, because an event is one activity now (`E-01`): the
   * activity picked at creation fixes both what the event is called and what it
   * measures. Rows created before that could carry several, and the caller
   * passes the first — the one their board already sorted by — so an old
   * contest keeps the ranking it has been running with.
   */
  readonly metric?: string | null;
  readonly standings?: readonly EventBoardStandingView[];
  /** Who said yes, and who said maybe — the roster the signup message shows. */
  readonly going?: readonly { readonly discordId: string }[];
  readonly maybe?: readonly { readonly discordId: string }[];
  readonly participantCount: number;
  /**
   * People who said they were coming and have no linked Minecraft account.
   *
   * Named on the card rather than dropped, matching what the panel does with
   * the same fact: somebody absent from the standings because nothing can read
   * their stats should find that out here, while there is still time to link.
   */
  readonly unlinked?: readonly { readonly discordId: string }[];
  /** Free text, informational. Nothing on this platform pays it out. */
  readonly prize?: string | null;
  /**
   * The native Discord scheduled event this card mirrors, when there is one.
   *
   * A link rather than a replacement. Discord's own event carries the things
   * Discord is better at than an embed — a reminder when it starts, a place in
   * the server's event list, an "Interested" count visible from the sidebar —
   * and this card carries everything else. Absent when the mirror could not be
   * made, in which case the line simply is not printed.
   */
  readonly discordEventUrl?: string | null;
  /** When this render was made. Becomes the card's native timestamp. */
  readonly updatedAt: string;
}

/**
 * Metric keys read as camelCase in the database and as English on the board.
 *
 * Sentence-cased, and deliberately not the same table as the title-cased field
 * names on the lookup cards: these land mid-sentence. Both live in the brand
 * layer so the difference is a stated decision rather than something that looks
 * like one of the two having drifted.
 */
const METRIC_LABELS: Readonly<Record<string, string>> = copy.embed.metricPhrase;

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

/**
 * The same gain, formatted the way its family is actually read.
 *
 * `formatDelta`'s abbreviation is right for the numbers it was written for --
 * slayer XP and networth arrive in the millions, and a column of eleven digits
 * is unreadable. It is wrong for everything else the widened catalog allows:
 * "+12.5k" is a correct rendering of a networth delta and a nonsensical one of
 * a skill average, and a bestiary milestone counts brackets crossed, which
 * cannot be fractional at all. So the family decides, and the family comes from
 * `eventMetricFormat` in shared-types -- the same function the panel reads, so
 * a board and its preview cannot disagree about what a number looks like.
 */
export function formatMetricDelta(metric: string, value: number): string {
  if (!Number.isFinite(value)) return "—";
  const format = isEventMetric(metric) ? eventMetricFormat(metric) : "XP";
  const sign = value < 0 ? "-" : "+";
  const abs = Math.abs(value);

  // XP and coins are the large families, and the only ones worth abbreviating.
  if (format === "XP" || format === "COINS") return formatDelta(value);
  // Brackets crossed. Rounded rather than trimmed: half a milestone is not a
  // thing that happened.
  if (format === "COUNT") return `${sign}${Math.round(abs)}`;
  // Levels and weight: small, fractional, and read literally. Grouped above a
  // thousand so a four-figure weight gain is still scannable.
  return `${sign}${group(trim(abs))}`;
}

/** Thousands separators on the integer part only, leaving any decimals alone. */
function group(text: string): string {
  const dot = text.indexOf(".");
  const whole = dot === -1 ? text : text.slice(0, dot);
  const rest = dot === -1 ? "" : text.slice(dot);
  let out = "";
  for (let i = 0; i < whole.length; i += 1) {
    if (i > 0 && (whole.length - i) % 3 === 0) out += ",";
    out += whole[i];
  }
  return out + rest;
}

function trim(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

/** The sentence the card opens with, which is the whole of what changed. */
const HEADLINES: Readonly<Record<EventCardView["status"], string>> = {
  SCHEDULED: C.eventOpen,
  LIVE: C.eventLive,
  COMPLETED: C.eventDone,
  CANCELLED: C.eventOff,
};

const TONES: Readonly<Record<EventCardView["status"], ViewColor>> = {
  SCHEDULED: "INFO",
  LIVE: "SUCCESS",
  COMPLETED: "NEUTRAL",
  CANCELLED: "DANGER",
};

/**
 * The event card: one message per event, posted once and edited in place.
 *
 * It is deliberately the same card at every stage rather than three cards that
 * replace each other. An event is one thing that happens over time — signups,
 * then a contest, then a result — and a channel that posts a fresh message at
 * each stage leaves two dead ones above the live one, each of them wrong. So
 * the sections come and go and the message does not: the roster is there until
 * the event starts, the standings appear when there is something to rank, and
 * the last edit leaves the result in the channel as the event's own record.
 *
 * Nothing here puts data in a field name. The counts that used to be in them —
 * "Top 4 · catacombs level", "Not scored — no linked account (1)" — read as
 * headings that change under you while the numbers move; they are inside the
 * values now, where a number belongs.
 */
export function renderEventCard(view: EventCardView): EmbedView {
  const final = view.status === "COMPLETED" || view.status === "CANCELLED";
  const described = (view.description ?? "").trim();
  const ends = view.endsAt == null || final ? null : timestampTag(view.endsAt, "R");
  const ended = final && view.endsAt != null ? timestampTag(view.endsAt) : null;

  const detail: Fact[] = [
    {
      label: view.status === "SCHEDULED" ? F.starts : F.started,
      value: `${timestampTag(view.startsAt)} (${timestampTag(view.startsAt, "R")})`,
    },
  ];
  // Only one of the two: a finished event says when it ended, a running one
  // says how long is left, and neither wants the other's line.
  if (ends !== null) detail.push({ label: F.ends, value: ends });
  if (ended !== null) detail.push({ label: F.ended, value: ended });
  detail.push({ label: F.host, value: view.hostDiscordId == null ? null : `<@${view.hostDiscordId}>` });
  detail.push({ label: F.signedUp, value: signupCount(view) });
  if ((view.prize ?? "").trim() !== "") detail.push({ label: F.prize, value: (view.prize ?? "").trim() });
  // Last, because it is the one line that leaves the message. A reader scanning
  // the details wants the facts first and the button out of them after.
  if ((view.discordEventUrl ?? "").trim() !== "") {
    detail.push({ label: F.reminder, value: `[${C.eventNotify}](${(view.discordEventUrl ?? "").trim()})` });
  }

  return card({
    tone: TONES[view.status],
    title: view.title,
    // The status sentence leads, and the organiser's own words follow it: the
    // reader wants "is this open" answered before they read the pitch.
    headline: described === "" ? HEADLINES[view.status] : `${HEADLINES[view.status]}\n\n${described}`,
    fields: [
      field(F.details, facts(detail)),
      field(F.scoring, view.metric == null ? C.eventUnscored : metricLabel(view.metric)),
      // The roster is what the message is *for* until the event starts. After
      // that the standings are, and printing both would push the table under
      // a list of names that has stopped changing.
      view.status === "SCHEDULED" ? field(F.roster, rosterBlock(view)) : null,
      view.status === "SCHEDULED" || view.metric == null
        ? null
        : field(F.standings, standingsBlock(view.metric, view.standings ?? [])),
      field(F.notScored, unlinkedBlock(view.unlinked ?? [])),
    ],
    // Static: the id is how `findBoard` recognises this message as this
    // event's after a crash, and it never changes. The freshness that used to
    // sit beside it is the native timestamp now.
    footer: C.eventId.replace("{id}", view.eventId),
    timestamp: view.updatedAt,
  });
}

/** `12` or `12/20` — a cap is only worth printing when there is one. */
function signupCount(view: EventCardView): string {
  const going = view.participantCount;
  return view.capacity == null ? `${going}` : `${going}/${view.capacity}`;
}

/**
 * Who is coming, before the event starts.
 *
 * Maybes are listed under the yeses rather than mixed in with them: an
 * organiser deciding whether to run a carry night needs the two counts apart,
 * and a roster that reads them as one number is the reason they ask in chat.
 */
function rosterBlock(view: EventCardView): string {
  const going = view.going ?? [];
  const maybe = view.maybe ?? [];
  if (going.length === 0 && maybe.length === 0) return C.eventNobody;
  const lines: string[] = [];
  if (going.length > 0) lines.push(`${C.eventGoing.replace("{n}", String(going.length))} ${mentionList(going)}`);
  if (maybe.length > 0) lines.push(`${C.eventMaybe.replace("{n}", String(maybe.length))} ${mentionList(maybe)}`);
  return lines.join("\n");
}

/** The unlinked, named with their count in the value rather than in a heading. */
function unlinkedBlock(entries: readonly { readonly discordId: string }[]): string {
  if (entries.length === 0) return "";
  return `${C.eventUnlinked.replace("{n}", String(entries.length))} ${mentionList(entries)}`;
}

/** How many rows the card shows. Ten fits a field without scrolling past it. */
export const BOARD_STANDINGS = 10;

/**
 * The rank column. Medals for the podium, because that is the shape a reader
 * scans for; numerals below it, because eleven medals is no ranking at all.
 */
const RANKS: readonly string[] = ["🥇", "🥈", "🥉"];

function standingsBlock(metric: string, standings: readonly EventBoardStandingView[]): string {
  if (standings.length === 0) {
    // Not an error: the first poll of a live event has captured baselines and
    // nothing else, so everyone is legitimately on zero.
    return C.eventNoScores;
  }
  // Everyone on zero is a different fact from nobody being ranked, and saying so
  // beats printing a column of "+0" that reads as a broken tracker.
  if (standings.every((s) => s.delta === 0)) {
    return C.eventLevel.replace("{metric}", metricLabel(metric));
  }
  return standings
    .slice(0, BOARD_STANDINGS)
    .map((s, i) => `${RANKS[i] ?? `**${i + 1}.**`} <@${s.discordId}> — ${formatMetricDelta(metric, s.delta)}`)
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
