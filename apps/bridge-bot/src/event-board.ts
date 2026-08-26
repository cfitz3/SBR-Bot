/**
 * The event tracker board: one message per event in the guild's events channel,
 * posted once and edited in place while the event runs.
 *
 * Edited rather than re-posted for the same reason ticket panels are — a
 * half-hourly re-post is a channel full of dead leaderboards, each of them
 * wrong. When the event finishes the board is edited one last time into a
 * result card and left there, so the channel keeps a history instead of the
 * event disappearing at the moment it becomes interesting.
 *
 * There is no discord.js in this file. The gateway takes a port with `post` and
 * `edit` on it, which is what lets the whole decision — which channel, edit or
 * post, final or not — be tested without a gateway connection.
 */
import { BOARD_STANDINGS, renderEventBoardEmbed, type EventBoardView } from "@sbr/commands-bridge";
import { isEventMetric } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import type { EmbedView } from "@sbr/shared-types";

/** The event row the board renders, as this side describes it. */
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
  /** Post, returning the message id, or null when it did not land. */
  post(channelId: string, embed: EmbedView): Promise<string | null>;
  edit(channelId: string, messageId: string, embed: EmbedView): Promise<boolean>;
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

export type BoardProblem = "NO_EVENT" | "NOT_TRACKED" | "NO_CHANNEL" | "NOT_POSTED";

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
   * Publish or refresh one event's board.
   *
   * `guildId` is the caller's claim and the event's own guild is the truth: a
   * board request naming another server's event is refused rather than posted
   * into whichever channel the caller happens to own.
   */
  async publish(guildId: string, eventId: string): Promise<BoardResult> {
    const event = await this.d.events.boardEvent(eventId);
    if (event === null || event.guildId !== guildId) {
      return { ok: false, problem: "NO_EVENT", detail: "no such event in this server" };
    }
    if (event.status === "SCHEDULED" && event.messageId === null) {
      // Boards belong to events that are happening. A scheduled one already has
      // its own post with the RSVP buttons on it.
      return { ok: false, problem: "NOT_TRACKED", detail: "the board opens when the event goes live" };
    }

    // The stored channel wins: a board follows the message it was posted as,
    // and an `events` slot rebound mid-event would otherwise orphan it.
    const channelId = event.channelId ?? (await this.d.getChannel(guildId));
    if (channelId === null) {
      return { ok: false, problem: "NO_CHANNEL", detail: "no events channel is bound in this server" };
    }

    const view = await this.view(event);
    const embed = renderEventBoardEmbed(view);
    const final = isFinal(event.status);

    if (event.messageId !== null) {
      const edited = await this.d.discord.edit(channelId, event.messageId, embed);
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
      const edited = await this.d.discord.edit(channelId, orphan, embed);
      await this.d.events.bindBoardMessage(eventId, channelId, edited ? orphan : null, edited && final);
      if (edited) return { ok: true, channelId, messageId: orphan, edited: true, final };
    }

    const messageId = await this.d.discord.post(channelId, embed);
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
   * Every configured metric gets its own table, in the organiser's order --
   * re-ranking here would mean the board disagreed with the form they filled
   * in, and showing only the first would hide most of a multi-metric contest.
   *
   * Metrics the tracker does not recognise are dropped rather than rendered
   * empty. They cannot have scores, because the tracker filters by the same
   * predicate before it polls; an empty table for one would read as "nobody has
   * gained any weight yet" about a metric that was never being measured. The
   * service layer refuses unknown metrics at write time now, so this only
   * covers rows stored before it did.
   */
  private async view(event: EventBoardRow): Promise<EventBoardView> {
    const metrics = event.trackedMetrics.filter(isEventMetric);
    const tables = await Promise.all(
      metrics.map(async (metric) => ({
        metric,
        // One metric's read failing costs that table and not the board: a
        // partial board is still worth posting, and the next pass retries.
        standings: (await this.d.events.standings(event.id, metric, BOARD_STANDINGS).catch(() => []))
          .map((s) => ({ discordId: s.discordId, delta: s.delta })),
      })),
    );
    const unlinked = await this.d.events.unlinkedParticipants(event.id).catch(() => []);

    return {
      eventId: event.id,
      title: event.title,
      status: event.status,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      metrics: tables,
      participantCount: event.participantCount,
      unlinked,
      prize: event.prize,
      updatedAt: this.now().toISOString(),
    };
  }
}
