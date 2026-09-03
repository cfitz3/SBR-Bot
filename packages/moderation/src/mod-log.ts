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
import { card, facts, field } from "@sbr/embed-kit";
import type { EmbedFieldView, EmbedView, ModerationActionDTO, ViewColor } from "@sbr/shared-types";
import { AUTOMOD_ACTOR } from "./automod-runner.js";

/**
 * The stand-in actor for a punishment taken in Discord's own interface whose
 * audit-log entry named no executor. Beside the renderer rather than in the
 * service, so nothing has to import the service to know it.
 */
export const DISCORD_ACTOR = "discord";
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
  // A withdrawn case is not a punishment any more, whatever it was issued as.
  // Leaving a voided ban red would keep it reading as one at a glance, which is
  // the same class of mistake as a card that says "banned" about someone who is
  // still here.
  if (action.voidedAt !== null) return "NEUTRAL";
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
  // Discord's audit log named nobody — which happens, and is worth saying
  // rather than rendering as a mention of a user id that is not one.
  if (actorDiscordId === DISCORD_ACTOR) return "Taken in Discord (actor unknown)";
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
 * What the enforcement line says, or nothing at all.
 *
 * `NOT_REQUIRED` prints nothing rather than "not required": a warning has no
 * Discord counterpart, and a field explaining that on every warning is noise in
 * the one channel that should be readable at a glance.
 */
function enforcementFields(action: ModerationActionDTO): readonly (EmbedFieldView | null)[] {
  switch (action.enforcement) {
    case "FAILED":
      return [
        field(
          "⚠️ Not enforced",
          `${action.enforcementDetail ?? "No reason recorded"}\nThis needs doing by hand.`,
        ),
      ];
    case "PENDING":
      // The detail is the whole point here: "still in progress" beside a kick
      // nobody can see the state of is the same non-answer this card used to
      // give, and the reader's next question is always which surface is
      // waiting. Named, it is either "the guild has not answered yet" or a
      // reason to go and look.
      //
      // The attempt count rides along because "still in progress" on try one
      // and on try three are different situations: the first is a queue, the
      // third is about to become a failure, and staff who can see which is
      // which stop asking.
      return [
        field(
          "Enforcement",
          [
            action.enforcementDetail === null
              ? "Still in progress."
              : `Still in progress — ${action.enforcementDetail}`,
            action.enforcementAttempts > 1 ? `Attempt ${action.enforcementAttempts}.` : null,
          ]
            .filter((line): line is string => line !== null)
            .join(" "),
        ),
      ];
    case "CONFIRMED":
      // Only a `CONFIRMED_INGAME` ack settles the guild-chat leg as confirmed,
      // so a CONFIRMED row that lists GUILD_CHAT means Hypixel itself echoed
      // the command back. Worth saying out loud, because "Enforced: GUILD_CHAT"
      // previously meant no more than "we typed something".
      return [
        field(
          "Enforced",
          action.surfaces.includes("GUILD_CHAT")
            ? `${action.surfaces.join(" + ")}\nConfirmed in game by the guild.`
            : action.surfaces.join(" + "),
        ),
      ];
    default:
      return [];
  }
}

/**
 * One moderation action, as the card the mod-log channel receives.
 *
 * `now` is a parameter so the state reading is testable; it defaults to the wall
 * clock because every real caller is posting the moment the action lands.
 *
 * Built through `card()`, which is what supplies the parts this renderer used to
 * do by hand and got subtly wrong. The action's own `createdAt` is the native
 * `timestamp`, so the card is dated by *when the punishment happened* rather
 * than by when the message was sent — the two are the same for a live post and
 * are months apart when `/case` renders the same card for a case somebody is
 * appealing. The old version had no timestamp at all, which meant a case pulled
 * up later carried no date whatsoever.
 *
 * The identity, the actor, the duration and the expiry are one consolidated
 * field rather than four inline ones. They are four short facts, they are always
 * read together, and as separate fields they took the card past its budget
 * before the reason was even added.
 */
export function modLogEmbed(action: ModerationActionDTO, now: Date = new Date()): EmbedView {
  const title = TITLES[action.type] ?? action.type;
  const target = action.targetDiscordId === null ? "an unlinked member" : `<@${action.targetDiscordId}>`;
  const state = punishmentState(action, now);

  // A relative timestamp rather than an ISO string: the reader's question is
  // "how much longer", and every reader is in a different zone. It is Discord's
  // own rendering, not text we typed — the rule is against hand-written "2
  // hours ago", not against asking the client to say it.
  const expiry =
    action.expiresAt === null
      ? null
      : `<t:${Math.floor(new Date(action.expiresAt).getTime() / 1000)}:R>`;

  return card({
    tone: colorFor(action),
    title,
    // The state goes in the headline because it is the first thing a reader
    // scanning the channel needs and the last thing they should have to hunt a
    // field for. A punishment still running says nothing extra; anything else —
    // lifted early, expired, withdrawn — is news.
    ...(state === "MOMENTARY" || state === "ACTIVE" ? {} : { headline: describeState(state) }),
    fields: [
      field(
        "Case",
        facts([
          { label: "Member", value: target },
          { label: "Staff", value: actorName(action.actorDiscordId) },
          ...(action.durationSeconds !== null && action.durationSeconds > 0
            ? [{ label: "Duration", value: duration(action.durationSeconds) }]
            : []),
          ...(expiry ? [{ label: state === "EXPIRED" ? "Expired" : "Expires", value: expiry }] : []),
        ]),
      ),
      field("Reason", action.reason?.trim() ?? ""),
      ...enforcementFields(action),
      action.voidedAt !== null ? field("Voided", action.voidReason ?? "") : null,
    ],
    // Static, and the only genuinely static thing on the card: the id a reply,
    // an appeal and `/case` all quote.
    footer: `Case ${action.caseCode}`,
    timestamp: action.createdAt,
  });
}
