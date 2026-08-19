/**
 * Event reminders, arriving from the workers over the bridge bus.
 *
 * The workers know *when* to remind — they hold the schedule, the RSVP list and
 * the per-offset sent flags — but they have no gateway, so the send lands here.
 * Nothing in this file touches discord.js: the post is a callback, exactly as it
 * is for the milestone announcer, so the routing can be tested without a client.
 *
 * Delivery is one-shot by design. The bus is fire-and-forget, so a reminder that
 * arrives while the bot is down is lost rather than queued — a "starts in 15
 * minutes" notice delivered an hour late is worse than one that never arrives,
 * and the event itself is durable in Postgres either way.
 */
import { renderEventReminderEmbed } from "@sbr/commands-bridge";
import type { Logger } from "@sbr/observability";
import type { EventReminderMessage } from "@sbr/redis";
import type { EmbedView } from "@sbr/shared-types";

/**
 * Discord accepts at most 100 ids in `allowed_mentions.users`, and a wall of
 * pings is its own kind of failure. Past this many the notice goes out without
 * mentions rather than pinging an arbitrary hundred of the people who RSVP'd.
 */
export const REMINDER_MENTION_LIMIT = 50;

export interface EventReminderDeps {
  /** The guild's `events` channel binding, or null when none is set. */
  getChannel(guildId: string): Promise<string | null>;
  /** Post one reminder. `false` means it did not land. */
  post(channelId: string, embed: EmbedView, mentionDiscordIds: readonly string[]): Promise<boolean>;
  readonly log: Logger;
}

/**
 * Deliver one reminder. Returns whether it was posted.
 *
 * A guild with no `events` channel is an information line rather than a
 * warning: binding one is optional, and a server that schedules events without
 * a channel to announce them in has made a choice, not a mistake.
 */
export async function deliverEventReminder(
  deps: EventReminderDeps,
  message: EventReminderMessage,
): Promise<boolean> {
  const channelId = await deps.getChannel(message.guildId).catch(() => null);
  if (channelId === null) {
    deps.log.info("event reminder dropped — no events channel bound", {
      guildId: message.guildId,
      eventId: message.eventId,
    });
    return false;
  }

  const mentions = message.discordIds.length > REMINDER_MENTION_LIMIT ? [] : message.discordIds;
  if (mentions.length === 0 && message.discordIds.length > 0) {
    deps.log.info("event reminder posted without mentions — too many attendees", {
      eventId: message.eventId,
      attendees: message.discordIds.length,
    });
  }

  const embed = renderEventReminderEmbed({
    eventId: message.eventId,
    title: message.title,
    startsAt: message.startsAt,
    offsetMinutes: message.offsetMinutes,
  });

  const posted = await deps.post(channelId, embed, mentions).catch(() => false);
  if (!posted) {
    deps.log.warn("event reminder did not land", {
      guildId: message.guildId,
      eventId: message.eventId,
      channelId,
    });
  }
  return posted;
}
