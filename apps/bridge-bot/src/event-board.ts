/**
 * The event message: one post per event in the guild's events channel, made
 * when the event is created and edited in place for the rest of its life.
 *
 * It starts as the signup sheet — the roster, and the buttons that put a member
 * on it. It becomes the leaderboard when the event goes live, in the same
 * message, so the people who signed up are looking at the standings in the
 * place they signed up. It is edited once more when the event finishes and left
 * in the channel as the result.
 *
 * One message rather than three, because an event is one thing that happens
 * over time. A bot that posts a fresh message per stage leaves two dead ones
 * above the live one and no way to tell which is current; a bot that deletes
 * the old ones throws away the channel's history of what the guild has run.
 *
 * The message is also mirrored into a native Discord scheduled event, so the
 * server's event list and the reminder Discord sends on the day both point at
 * the same thing the channel is showing. The message is the source of truth;
 * the calendar entry is a convenience, and every failure to make one costs a
 * link on the card and nothing else.
 *
 * There is no discord.js in this file. The gateway takes a port with `post` and
 * `edit` on it, which is what lets the whole decision — which channel, edit or
 * post, buttons or none, final or not — be tested without a gateway connection.
 */
import { BOARD_STANDINGS, renderEventCard, rsvpButtons, type EventCardView } from "@sbr/commands-bridge";
import { copy } from "@sbr/brand";
import { isEventMetric } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import type { ActionRowView, EmbedView } from "@sbr/shared-types";

const E = copy.error;

/** The event row the message renders, as this side describes it. */
export interface EventBoardRow {
  readonly id: string;
  readonly guildId: string;
  readonly title: string;
  readonly status: "SCHEDULED" | "LIVE" | "COMPLETED" | "CANCELLED";
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly channelId: string | null;
  readonly messageId: string | null;
  readonly trackedMetrics: readonly string[];
  readonly participantCount: number;
  readonly prize: string | null;
  /** The organiser's own words, and who they are. */
  readonly description?: string | null;
  readonly hostDiscordId?: string | null;
  readonly capacity?: number | null;
  /**
   * The roster, which is what the message shows until the event starts.
   *
   * Both lists, kept apart: an organiser deciding whether tonight is worth
   * running needs the yeses and the maybes as two numbers, not one.
   */
  readonly going?: readonly { readonly discordId: string }[];
  readonly maybe?: readonly { readonly discordId: string }[];
  /** The native Discord scheduled event mirroring this one, once made. */
  readonly discordEventId?: string | null;
}

export interface EventStanding {
  readonly discordId: string;
  readonly uuid: string;
  readonly delta: number;
}

export interface EventBoardPort {
  boardEvent(eventId: string): Promise<EventBoardRow | null>;
  standings(eventId: string, metric: string, limit: number): Promise<readonly EventStanding[]>;
  /**
   * Members who RSVP'd GOING and have no linked Minecraft account.
   *
   * The board names them rather than dropping them, which is the same choice
   * the panel already makes about the same people: being absent from a
   * leaderboard with no explanation looks like a bug, and the fix -- link your
   * account -- is one they can act on themselves.
   */
  unlinkedParticipants(eventId: string): Promise<readonly { readonly discordId: string }[]>;
  bindBoardMessage(eventId: string, channelId: string, messageId: string | null, final: boolean): Promise<void>;
  /**
   * Remember the native scheduled event, so the next pass edits it rather than
   * making a second one. Optional: a deployment whose Discord port cannot make
   * scheduled events never has one to record.
   */
  bindDiscordEvent?(eventId: string, discordEventId: string): Promise<void>;
}

/**
 * One event as Discord's own scheduled-event API wants it described.
 *
 * Deliberately not `EventBoardRow`. The two disagree about things this file is
 * the right place to reconcile: Discord requires an end time on an external
 * event and this platform does not, and Discord's status vocabulary has ACTIVE
 * where ours has LIVE. Doing that translation here keeps the transport a
 * mapping onto discord.js and nothing else.
 */
export interface ScheduledEventSpec {
  readonly name: string;
  readonly description: string | null;
  readonly startsAt: string;
  /** Always set: an external event without an end is rejected by Discord. */
  readonly endsAt: string;
  readonly location: string;
  readonly status: "SCHEDULED" | "ACTIVE" | "COMPLETED" | "CANCELLED";
}

/** What Discord gives back: the id to store, and the link to put on the card. */
export interface ScheduledEventRef {
  readonly id: string;
  readonly url: string;
}

export interface EventBoardDiscordPort {
  /**
   * Post, returning the message id, or null when it did not land.
   *
   * `components` is the RSVP row while the event can still be joined, and
   * absent once it cannot. Passing it on every write rather than only on the
   * first is what lets the final edit *remove* the buttons: a result card with
   * a live "Going" button on it invites presses that can no longer mean
   * anything.
   */
  post(channelId: string, embed: EmbedView, components?: readonly ActionRowView[]): Promise<string | null>;
  edit(
    channelId: string,
    messageId: string,
    embed: EmbedView,
    components?: readonly ActionRowView[],
  ): Promise<boolean>;
  /**
   * A board this bot already posted for this event, if one is in the channel.
   *
   * Closes the only window in which this job can duplicate a board. Two workers
   * cannot race — the pass holds `lock:job:event-board` — and a bridge restart
   * is harmless because `messageId` is in Postgres. What is not covered is a
   * crash *between* `post` returning an id and `bindBoardMessage` storing it:
   * the id is then only in the dead process, and the next pass takes the post
   * path again and publishes a second board. Asking Discord first makes the
   * post path idempotent, which is the honest fix for a window that a lock
   * cannot close because the two writes are to different systems.
   *
   * Optional: a caller that cannot search its channels posts unguarded, which
   * is the behaviour this had before.
   */
  findBoard?(channelId: string, eventId: string): Promise<string | null>;
  /**
   * Make the native Discord scheduled event mirroring this one.
   *
   * Addressed by guild rather than by channel, unlike `post` and `edit`: a
   * scheduled event belongs to the server's event list and not to any channel,
   * and the implementation is a call to the admin bot rather than a message
   * send. Returns null when it could not be made, which the caller treats as
   * "no link on the card this pass" and nothing worse.
   *
   * Optional throughout, so a deployment or a test without it publishes exactly
   * the message it published before.
   */
  scheduleEvent?(guildId: string, spec: ScheduledEventSpec): Promise<ScheduledEventRef | null>;
  /**
   * Bring an existing native event in line with the row, and hand back its link.
   *
   * Returns the ref even when the edit itself was refused — Discord will not
   * let a finished event be edited, and a link to a finished event is still the
   * right link to print. Null means the event is gone.
   */
  updateScheduledEvent?(
    guildId: string,
    discordEventId: string,
    spec: ScheduledEventSpec,
  ): Promise<ScheduledEventRef | null>;
}

export interface EventBoardGatewayDeps {
  readonly events: EventBoardPort;
  /** The guild's `events` channel, for a board that has not been placed yet. */
  readonly getChannel: (guildId: string) => Promise<string | null>;
  readonly discord: EventBoardDiscordPort;
  readonly log: Logger;
  readonly now?: () => Date;
}

export type BoardProblem = "NO_EVENT" | "NO_CHANNEL" | "NOT_POSTED";

export type BoardResult =
  | {
      readonly ok: true;
      readonly channelId: string;
      readonly messageId: string;
      readonly edited: boolean;
      /** True when this was the result card and the board is done. */
      readonly final: boolean;
    }
  | { readonly ok: false; readonly problem: BoardProblem; readonly detail: string };

/** How long an open-ended event is assumed to run, for Discord's benefit. */
const DEFAULT_EVENT_MS = 2 * 60 * 60 * 1000;

/** A finished event's board is written once more and then left alone. */
function isFinal(status: EventBoardRow["status"]): boolean {
  return status === "COMPLETED" || status === "CANCELLED";
}

export class EventBoardGateway {
  private readonly d: EventBoardGatewayDeps;
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(deps: EventBoardGatewayDeps) {
    this.d = deps;
    this.log = deps.log.child({ component: "event-board" });
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Publish or refresh one event's message.
   *
   * A scheduled event is published exactly like a live one — that is the point
   * of the merge. Before this, the message was only made once the event went
   * live, and the signup post was a separate message from a separate command;
   * two messages about one event, and the one members had pressed buttons on
   * was the one that then stopped being updated.
   *
   * `guildId` is the caller's claim and the event's own guild is the truth: a
   * request naming another server's event is refused rather than posted into
   * whichever channel the caller happens to own.
   */
  async publish(guildId: string, eventId: string): Promise<BoardResult> {
    const event = await this.d.events.boardEvent(eventId);
    if (event === null || event.guildId !== guildId) {
      return { ok: false, problem: "NO_EVENT", detail: "no such event in this server" };
    }

    // The stored channel wins: a board follows the message it was posted as,
    // and an `events` slot rebound mid-event would otherwise orphan it.
    const channelId = event.channelId ?? (await this.d.getChannel(guildId));
    if (channelId === null) {
      return { ok: false, problem: "NO_CHANNEL", detail: "no events channel is bound in this server" };
    }

    // Before the render, so the first post already carries the link. A member
    // who sees the message when it appears is the member most likely to want
    // the reminder, and a link that only shows up on the second edit misses them.
    const discordEventUrl = await this.mirror(event);

    const view = await this.view(event, discordEventUrl);
    const embed = renderEventCard(view);
    const final = isFinal(event.status);
    // The buttons live as long as the answer does. A cancelled or finished
    // event keeps its card and loses its controls, in one edit.
    const components = final ? [] : rsvpButtons(event.id);

    if (event.messageId !== null) {
      const edited = await this.d.discord.edit(channelId, event.messageId, embed, components);
      if (edited) {
        await this.d.events.bindBoardMessage(eventId, channelId, event.messageId, final);
        return { ok: true, channelId, messageId: event.messageId, edited: true, final };
      }
      this.log.info("board message is gone; posting a fresh one", { eventId, channelId });
    }

    // Adopt an orphan before posting a twin. See `findBoard`.
    const orphan = this.d.discord.findBoard ? await this.d.discord.findBoard(channelId, eventId).catch(() => null) : null;
    if (orphan !== null) {
      this.log.info("adopting a board this event already has", { eventId, channelId, messageId: orphan });
      const edited = await this.d.discord.edit(channelId, orphan, embed, components);
      await this.d.events.bindBoardMessage(eventId, channelId, edited ? orphan : null, edited && final);
      if (edited) return { ok: true, channelId, messageId: orphan, edited: true, final };
    }

    const messageId = await this.d.discord.post(channelId, embed, components);
    if (messageId === null) {
      // Un-record first, exactly as a panel does: a stored id pointing at
      // nothing sends every future pass down the edit path to fail the same way.
      await this.d.events.bindBoardMessage(eventId, channelId, null, false).catch(() => undefined);
      return { ok: false, problem: "NOT_POSTED", detail: E.discord.cannotPost };
    }
    await this.d.events.bindBoardMessage(eventId, channelId, messageId, final);
    return { ok: true, channelId, messageId, edited: false, final };
  }

  /**
   * One event, as the card wants it.
   *
   * One metric, not a list. An event is one activity now (`E-01`): the activity
   * chosen at creation decides both what the event is called and the single
   * thing it measures, so a card with three tables under it is a shape the
   * platform can no longer produce. Rows created before that can still carry
   * several, and the first is what their board has been sorting by — so that is
   * the one kept, and the ranking members have been watching does not change
   * underneath them on the day this ships.
   *
   * A metric the tracker does not recognise is dropped rather than rendered
   * empty. It cannot have scores, because the tracker filters by the same
   * predicate before it polls; an empty table under "weight" would read as
   * "nobody has gained any weight yet" about a metric never being measured.
   */
  private async view(event: EventBoardRow, discordEventUrl: string | null): Promise<EventCardView> {
    const metric = event.trackedMetrics.find(isEventMetric) ?? null;
    const standings =
      metric === null
        ? []
        : // A failed read costs the table and not the message: a card with the
          // roster and the details on it is still worth posting, and the next
          // pass retries.
          (await this.d.events.standings(event.id, metric, BOARD_STANDINGS).catch(() => [])).map((s) => ({
            discordId: s.discordId,
            delta: s.delta,
          }));
    const unlinked = await this.d.events.unlinkedParticipants(event.id).catch(() => []);

    return {
      eventId: event.id,
      title: event.title,
      status: event.status,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      description: event.description ?? null,
      hostDiscordId: event.hostDiscordId ?? null,
      capacity: event.capacity ?? null,
      metric,
      standings,
      going: event.going ?? [],
      maybe: event.maybe ?? [],
      participantCount: event.participantCount,
      unlinked,
      prize: event.prize,
      discordEventUrl,
      updatedAt: this.now().toISOString(),
    };
  }

  /**
   * Keep Discord's own scheduled event in step with ours, and return its link.
   *
   * The message and the native event answer different questions. The message is
   * the event — the roster, the rules, the standings, the result — and it lives
   * in a channel somebody has to be looking at. The native event is the
   * reminder: it appears in the server's event list, it notifies the people who
   * marked themselves interested, and it is what a phone shows when the event
   * starts. Mirroring one from the other means the guild gets both without an
   * organiser maintaining two things that can disagree.
   *
   * Every failure here is swallowed and costs only the link. The message is the
   * source of truth and must publish whether or not Discord accepted a calendar
   * entry — a bot that refuses to post an event because it could not also
   * schedule it has turned a nicety into an outage.
   */
  private async mirror(event: EventBoardRow): Promise<string | null> {
    const spec = this.spec(event);

    if (event.discordEventId != null && event.discordEventId !== "") {
      const update = this.d.discord.updateScheduledEvent;
      if (update === undefined) return null;
      const ref = await update(event.guildId, event.discordEventId, spec).catch(() => null);
      // A native event a moderator deleted stays deleted. Recreating it would
      // undo a deliberate act every half hour, and the message is unaffected.
      return ref?.url ?? null;
    }

    const create = this.d.discord.scheduleEvent;
    if (create === undefined) return null;
    // Discord only accepts a scheduled event that has not happened yet, so an
    // event created while it is already running gets its message and no
    // calendar entry. Nothing to warn about: there is no reminder left to give.
    if (event.status !== "SCHEDULED") return null;
    if (Date.parse(event.startsAt) <= this.now().getTime()) return null;

    const ref = await create(event.guildId, spec).catch(() => null);
    if (ref === null) return null;
    // Recorded before it is used, so a crash after this point costs a stale
    // link and not a second event in the server's list.
    await this.d.events.bindDiscordEvent?.(event.id, ref.id).catch(() => undefined);
    return ref.url;
  }

  /**
   * The row as Discord wants it.
   *
   * An external event must end, and one of ours need not, so an open-ended
   * event is given two hours from its start. That is a guess and it is a stated
   * one: Discord uses the end time to drop the event out of the server's list,
   * and an event with no end at all would sit there forever.
   */
  private spec(event: EventBoardRow): ScheduledEventSpec {
    const starts = Date.parse(event.startsAt);
    const ends = event.endsAt == null ? null : Date.parse(event.endsAt);
    const end = ends !== null && Number.isFinite(ends) && ends > starts ? ends : starts + DEFAULT_EVENT_MS;
    return {
      name: event.title,
      description: event.description ?? null,
      startsAt: event.startsAt,
      endsAt: new Date(end).toISOString(),
      location: copy.embed.card.eventLocation,
      status: event.status === "LIVE" ? "ACTIVE" : event.status,
    };
  }
}
