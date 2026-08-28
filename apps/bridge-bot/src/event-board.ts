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
 * There is no discord.js in this file. The gateway takes a port with `post` and
 * `edit` on it, which is what lets the whole decision — which channel, edit or
 * post, buttons or none, final or not — be tested without a gateway connection.
 */
import { BOARD_STANDINGS, renderEventCard, rsvpButtons, type EventCardView } from "@sbr/commands-bridge";
import { isEventMetric } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import type { ActionRowView, EmbedView } from "@sbr/shared-types";

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

    const view = await this.view(event);
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
      return { ok: false, problem: "NOT_POSTED", detail: "I couldn't post in the events channel — check my permissions there" };
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
  private async view(event: EventBoardRow): Promise<EventCardView> {
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
      updatedAt: this.now().toISOString(),
    };
  }
}
