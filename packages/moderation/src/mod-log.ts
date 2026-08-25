/**
 * The moderation log card.
 *
 * The `modlog` channel slot has been configurable in the panel since the config
 * surface was written, and until now nothing on the platform ever posted to it.
 * A guild could bind the slot, see it listed as bound, and never receive a
 * single line — which is worse than not offering the slot, because the operator
 * reasonably concludes moderation *is* being logged somewhere.
 *
 * This is the renderer, and it is pure: an `EmbedView`, the same view model
 * every other card in the platform returns, so the house style checker in
 * `@sbr/discord-kit` applies to it exactly as it does to `/audit`. No embed is
 * built here and no channel is known here; posting is the sink's job.
 *
 * What it deliberately shows and does not show:
 *
 * - **Enforcement is a field, not a footnote.** The whole point of the audit
 *   this module came out of is that "logged" and "carried out" are two different
 *   facts, and a mod log that prints only the first is the same silence the
 *   command replies used to have.
 * - **The reason is shown verbatim.** Staff write reasons for other staff.
 * - **No mentions are rendered as pings** by the sink; the ids are here so a
 *   reader can click through, and `allowedMentions` is what stops the channel
 *   from notifying a member every time they are warned.
 */
import type { EmbedView, ModerationActionDTO, ViewColor } from "@sbr/shared-types";
import { AUTOMOD_ACTOR } from "./automod-runner.js";
import { EXPIRY_ACTOR } from "./expiry.js";
import { describeState, punishmentState } from "./expiry.js";

/** Port: somewhere the guild's moderation log is kept. */
export interface ModLogSink {
  post(guildId: string, embed: EmbedView): Promise<void>;
}

/**
 * Colour by severity, not by success.
 *
 * A ban is DANGER because a ban is severe; a ban that did not take is DANGER for
 * a different reason. Both are red, and the enforcement field is what tells them
 * apart — colour alone cannot carry two independent facts.
 */
function colorFor(action: ModerationActionDTO): ViewColor {
  if (action.enforcement === "FAILED") return "DANGER";
  switch (action.type) {
    case "BAN":
    case "KICK":
      return "DANGER";
    case "MUTE":
    case "WARN":
      return "WARNING";
    case "UNBAN":
    case "UNMUTE":
      return "SUCCESS";
    default:
      return "NEUTRAL";
  }
}

/** Who did it, in the words a reader needs rather than a raw snowflake. */
function actorName(actorDiscordId: string): string {
  if (actorDiscordId === AUTOMOD_ACTOR) return "Automod";
  if (actorDiscordId === EXPIRY_ACTOR) return "Expired (automatic)";
  return `<@${actorDiscordId}>`;
}

const TITLES: Readonly<Record<string, string>> = {
  WARN: "Warned",
  MUTE: "Muted",
  UNMUTE: "Unmuted",
  KICK: "Kicked",
  BAN: "Banned",
  UNBAN: "Unbanned",
  NOTE: "Note added",
};

/** Seconds → the shortest honest phrase. Mirrors the relay's duration format. */
function duration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/**
 * What the enforcement field says.
 *
 * `NOT_REQUIRED` prints nothing at all rather than "not required": a warning has
 * no Discord counterpart, and a field explaining that on every warning is noise
 * in the one channel that should be readable at a glance.
 */
function enforcementField(action: ModerationActionDTO): readonly { name: string; value: string }[] {
  switch (action.enforcement) {
    case "FAILED":
      return [
        {
          name: "⚠️ Not enforced",
          value: `${action.enforcementDetail ?? "No reason recorded"}\nThis needs doing by hand.`,
        },
      ];
    case "PENDING":
      // The detail is the whole point here: "still in progress" beside a kick
      // nobody can see the state of is the same non-answer this card used to
      // give, and the reader's next question is always which surface is
      // waiting. Named, it is either "the guild has not answered yet" or a
      // reason to go and look.
      return [
        {
          name: "Enforcement",
          value:
            action.enforcementDetail === null
              ? "Still in progress."
              : `Still in progress — ${action.enforcementDetail}`,
        },
      ];
    case "CONFIRMED":
      // Only a `CONFIRMED_INGAME` ack settles the guild-chat leg as confirmed,
      // so a CONFIRMED row that lists GUILD_CHAT means Hypixel itself echoed
      // the command back. Worth saying out loud, because "Enforced: GUILD_CHAT"
      // previously meant no more than "we typed something".
      return [
        {
          name: "Enforced",
          value: action.surfaces.includes("GUILD_CHAT")
            ? `${action.surfaces.join(" + ")}\nConfirmed in game by the guild.`
            : action.surfaces.join(" + "),
        },
      ];
    default:
      return [];
  }
}

/**
 * One moderation action, as the card the mod-log channel receives.
 *
 * `now` is a parameter so the "expires in" line is testable; it defaults to the
 * wall clock because every real caller is posting the moment the action lands.
 */
export function modLogEmbed(action: ModerationActionDTO, now: Date = new Date()): EmbedView {
  const title = TITLES[action.type] ?? action.type;
  const target = action.targetDiscordId === null ? "an unlinked member" : `<@${action.targetDiscordId}>`;

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: "Member", value: target, inline: true },
    { name: "Staff", value: actorName(action.actorDiscordId), inline: true },
  ];

  if (action.durationSeconds !== null && action.durationSeconds > 0) {
    fields.push({ name: "Duration", value: duration(action.durationSeconds), inline: true });
  }
  if (action.expiresAt !== null) {
    // A Discord relative timestamp rather than an ISO string: the reader's
    // question is "how much longer", and every reader is in a different zone.
    const unix = Math.floor(new Date(action.expiresAt).getTime() / 1000);
    const state = punishmentState(action, now);
    fields.push({
      name: state === "EXPIRED" ? "Expired" : "Expires",
      value: `<t:${unix}:R>`,
      inline: true,
    });
  }
  if (action.reason !== null && action.reason.trim().length > 0) {
    fields.push({ name: "Reason", value: action.reason });
  }
  fields.push(...enforcementField(action));

  const state = punishmentState(action, now);
  const footer =
    state === "LIFTED" || state === "EXPIRED"
      ? `Case ${action.id} · ${describeState(state)}`
      : `Case ${action.id}`;

  return { title, fields, footer, color: colorFor(action) };
}
