/**
 * Staff-facing rendering: the log embeds, paginated histories, and the honest
 * phrasing for each way a Discord effect can refuse.
 */
import type {
  ApplicationDTO,
  EmbedFieldView,
  EmbedView,
  FilterTestDTO,
  GuildEffectError,
  InfractionDTO,
  ModerationActionDTO,
  SafetyError,
  SafetyStatusDTO,
  WordlistRuleDTO,
} from "@sbr/shared-types";
import { padInlineRow } from "@sbr/shared-types";
import { describeState, punishmentState } from "@sbr/moderation";
import {
  formatRemaining,
  reasonSentence,
  remainingWindowMs,
  type AdmitResult,
  type JoinActionResult,
  type ScreeningRecord,
} from "@sbr/screening";

/** Discord renders `<t:…:R>` as a live relative timestamp in the reader's locale. */
export function relativeTs(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : `<t:${Math.floor(ms / 1000)}:R>`;
}

export function renderEffectError(error: GuildEffectError): string {
  switch (error.kind) {
    case "MISSING_PERMISSION":
      return "I don't have the Discord permission that needs.";
    case "NOT_FOUND":
      return "That user or channel no longer exists here.";
    case "FAILED":
      return `Discord refused: ${error.detail}`;
  }
}

export function renderSafetyError(error: SafetyError): string {
  switch (error.kind) {
    case "ALREADY_ACTIVE":
      return error.until
        ? `Already active until ${relativeTs(error.until)}.`
        : "Already active, with no expiry set.";
    case "NOT_ACTIVE":
      return "Nothing is active right now.";
    case "CHANNEL_REQUIRED":
      return "Pick a channel, or use scope:server to lock the whole server.";
    case "DISCORD_FAILED":
      return `Couldn't apply it: ${error.detail}`;
  }
}

/**
 * Break a list into embed pages. The dispatcher hands `pages` to the transport,
 * which shows page 1 with navigation — a member with 80 warnings must not
 * silently lose 70 of them to Discord's 25-field cap.
 */
export function paginate<T>(
  items: readonly T[],
  perPage: number,
  page: (slice: readonly T[], index: number, total: number) => EmbedView,
): readonly EmbedView[] {
  if (items.length === 0) return [];
  const total = Math.ceil(items.length / perPage);
  const out: EmbedView[] = [];
  for (let i = 0; i < total; i += 1) {
    out.push(page(items.slice(i * perPage, (i + 1) * perPage), i, total));
  }
  return out;
}

function pageFooter(index: number, total: number): string {
  return `Page ${index + 1} of ${total}`;
}

export function renderInfractionPages(
  targetId: string,
  rows: readonly InfractionDTO[],
): readonly EmbedView[] {
  return paginate(rows, 10, (slice, i, total) => ({
    title: `Infractions — ${rows.length} on record`,
    description: `<@${targetId}>`,
    fields: slice.map((r) => ({
      name: `${r.type} · ${r.severity}`,
      value: `${r.reason} — ${relativeTs(r.createdAt)}`,
      inline: false,
    })),
    footer: pageFooter(i, total),
    color: "WARNING",
  }));
}

/**
 * `/audit`.
 *
 * The state comes from `punishmentState` rather than the `active` column, so a
 * mute that ran its time out reads "expired" instead of "lifted" — the column
 * cannot tell those apart, and a staffer reading the log to see whether
 * somebody was let off early needs to.
 */
export function renderAuditPages(
  rows: readonly ModerationActionDTO[],
  options: { readonly truncated?: boolean; readonly now?: Date } = {},
): readonly EmbedView[] {
  const now = options.now ?? new Date();
  const heading = options.truncated
    ? `Audit log — newest ${rows.length}, and there are more`
    : `Audit log — ${rows.length} action${rows.length === 1 ? "" : "s"}`;
  return paginate(rows, 10, (slice, i, total) => ({
    title: heading,
    // Silence would read as "that is all there was", which is the one thing a
    // truncated log must not imply.
    ...(options.truncated ? { description: "Narrow the filters to see further back." } : {}),
    fields: slice.map((r) => {
      const target = r.targetDiscordId ? `<@${r.targetDiscordId}>` : "—";
      const state = punishmentState(r, now);
      const label = state === "MOMENTARY" || state === "ACTIVE" ? "" : ` (${describeState(state)})`;
      const expiry =
        r.expiresAt === null
          ? ""
          : state === "ACTIVE"
            ? ` · until ${relativeTs(r.expiresAt)}`
            : ` · ended ${relativeTs(r.expiresAt)}`;
      return {
        name: `${r.type}${label} · ${relativeTs(r.createdAt)}`,
        value: `${target} by <@${r.actorDiscordId}> — ${r.reason}${expiry}`,
        inline: false,
      };
    }),
    footer: pageFooter(i, total),
    color: "INFO",
  }));
}

export function renderWordlistEmbed(rules: readonly WordlistRuleDTO[]): EmbedView {
  if (rules.length === 0) {
    return { title: "Wordlist", description: "No rules configured.", color: "NEUTRAL" };
  }
  return {
    title: `Wordlist — ${rules.length} rule${rules.length === 1 ? "" : "s"}`,
    fields: rules.slice(0, 25).map((r) => ({
      name: `${r.pattern}${r.enabled ? "" : " (disabled)"}`,
      value: `${r.matchType} → ${r.action} · severity ${r.severity} · id \`${r.id}\``,
      inline: false,
    })),
    color: "INFO",
  };
}

export function renderFilterTestEmbed(result: FilterTestDTO): EmbedView {
  if (result.matched.length === 0) {
    return {
      title: "Filter test",
      description: "No rule matches that text — it would be relayed as written.",
      color: "SUCCESS",
    };
  }
  const fields: EmbedFieldView[] = [{ name: "Verdict", value: result.action, inline: true }];
  if (result.replacement !== null) {
    fields.push({ name: "Relayed as", value: result.replacement, inline: true });
  }
  // Name every rule that fired, not just the one that won: a staffer debugging
  // an over-eager filter needs to see the rule they didn't expect.
  fields.push({
    name: `Matched ${result.matched.length} rule${result.matched.length === 1 ? "" : "s"}`,
    value: result.matched.map((r) => `\`${r.pattern}\` (${r.matchType} → ${r.action})`).join("\n"),
    inline: false,
  });
  return {
    title: "Filter test",
    description: `That text **would be caught**.`,
    fields,
    color: result.action === "FLAG" ? "WARNING" : "DANGER",
  };
}

export function renderSafetyStatusEmbed(status: SafetyStatusDTO): EmbedView {
  const lock = status.lockdown;
  const raid = status.antiRaid;
  return {
    title: "Safety status",
    fields: [
      {
        name: "Lockdown",
        value: lock
          ? `${lock.scope}${lock.channelId ? ` <#${lock.channelId}>` : ""} — ${lock.reason}` +
            (lock.expiresAt ? ` · lifts ${relativeTs(lock.expiresAt)}` : " · no expiry")
          : "Not active",
        inline: false,
      },
      {
        name: "Anti-raid",
        value: raid
          ? `${raid.sensitivity}` + (raid.expiresAt ? ` · ends ${relativeTs(raid.expiresAt)}` : " · no expiry")
          : "Not active",
        inline: false,
      },
    ],
    color: lock || raid ? "WARNING" : "SUCCESS",
  };
}

// ─────────────────── Applications (COMMANDS.md /application-review) ───────────────────

export function renderApplicationEmbed(app: ApplicationDTO): EmbedView {
  return {
    title: `Application ${app.id}`,
    // Padded: a reviewed application carries a fourth inline field and an
    // unreviewed one does not, so the row ends short exactly when somebody has
    // acted on it — the card most likely to be read.
    fields: padInlineRow([
      { name: "Applicant", value: `<@${app.applicantDiscordId}>`, inline: true },
      { name: "Status", value: app.status.toLowerCase(), inline: true },
      { name: "Submitted", value: app.submittedAt === null ? "—" : relativeTs(app.submittedAt), inline: true },
      ...(app.reviewerDiscordId == null
        ? []
        : [{ name: "Reviewer", value: `<@${app.reviewerDiscordId}>`, inline: true }]),
      ...(app.decisionReason == null ? [] : [{ name: "Reason", value: app.decisionReason, inline: false }]),
    ]),
    color: app.status === "ACCEPTED" ? "SUCCESS" : app.status === "REJECTED" ? "DANGER" : "INFO",
  };
}

export function renderApplicationListEmbed(apps: readonly ApplicationDTO[]): EmbedView {
  if (apps.length === 0) {
    return { title: "Pending applications", description: "Nothing waiting for review.", color: "NEUTRAL" };
  }
  return {
    title: `Pending applications (${apps.length})`,
    fields: apps.slice(0, 10).map((a) => ({
      name: a.status.toLowerCase(),
      value: `<@${a.applicantDiscordId}> — id ${a.id}`,
      inline: false,
    })),
    footer: "Decide with /accept-member id:<id> or /deny-member id:<id>.",
    color: "INFO",
  };
}

// ─────────────────── In-game join queue (/join-queue) ────────────────────────

/**
 * The queue of in-game join requests still awaiting a decision.
 *
 * Different from the applications list above and deliberately not merged with
 * it: an application is a Discord form somebody filled in, a join request is a
 * player standing at the guild door in-game. They arrive by different routes,
 * they are resolved by different commands, and a staffer looking at one queue
 * should not have to work out which rows belong to the other.
 *
 * The verdict is shown rather than the risk score. The score orders the queue;
 * the verdict is the thing staff are being asked to agree or disagree with.
 */
export function renderJoinQueueEmbed(rows: readonly ScreeningRecord[]): EmbedView {
  if (rows.length === 0) {
    return {
      title: "Live join requests",
      description: "Nobody is at the door. Requests appear here as they are screened, and last five minutes.",
      color: "NEUTRAL",
    };
  }
  return {
    title: `Live join requests (${rows.length})`,
    fields: rows.slice(0, 10).map((r) => ({
      name: `${r.ign} — ${r.verdict.toLowerCase()} (risk ${r.riskScore})`,
      // The first reason is the one that decided it; the rest are in the staff
      // report already posted, and a ten-row list is not the place to repeat them.
      //
      // The remainder leads, because it is the only field that changes what a
      // staffer can do about the row: past zero, `/join-accept` stops being an
      // admission and becomes an invitation the applicant has to accept.
      value: `**${formatRemaining(remainingWindowMs(r.requestedAt))}** · ${reasonSentence(r.reasons[0] ?? "MEETS_REQUIREMENTS")} · ${relativeTs(r.requestedAt.toISOString())}`,
      inline: false,
    })),
    footer: "Answer with /join-accept ign:<name> or /join-deny ign:<name>. Hypixel drops a request five minutes after it is made.",
    color: "INFO",
  };
}

/** Why an action never reached the chat box. Shared by every roster command. */
function renderActionFailure(reason: Exclude<JoinActionResult, { ok: true }>["reason"]): string {
  switch (reason) {
    case "BAD_NAME":
      return "That isn't a Minecraft username — letters, numbers and underscores, up to 16 characters.";
    case "BAD_DURATION":
      return "That isn't a duration Hypixel takes — a number and a unit, like `30m`, `12h` or `7d`.";
    case "BAD_REASON":
      return "That reason has characters I won't type into guild chat. Letters, numbers and basic punctuation only.";
    case "NOT_SENT":
      return "The bridge couldn't take that command. It isn't connected to the guild right now, so nothing was sent.";
  }
}

/** One roster action, phrased so "sent" and "recorded" stay distinguishable. */
export function renderJoinAction(verb: string, result: JoinActionResult, extra = ""): string {
  if (!result.ok) return renderActionFailure(result.reason);
  // Only the two actions that answer a join request touch a screening row, so
  // only they have anything to say about one. Reporting "no pending screening
  // matched" after a promotion would invite the reader to wonder what a
  // promotion was supposed to match.
  const recorded =
    verb === "accept" || verb === "deny"
      ? result.recorded
        ? " Their screening row is marked."
        : " No pending screening matched them, so only the in-game command was sent."
      : "";
  const suffix = extra === "" ? "" : ` ${extra}`;
  return `Sent \`/guild ${verb} ${result.ign}${suffix}\`.${recorded}`;
}

/**
 * The outcome of `/join-accept`, which is two different acts wearing one name.
 *
 * Inside the window it admits somebody. Outside it, the request no longer
 * exists upstream and the best we can do is invite them — which needs the
 * applicant to act, so saying "accepted" would be a straightforwardly false
 * report of where that person now is.
 */
export function renderAdmit(result: AdmitResult): string {
  if (!result.ok) return renderActionFailure(result.reason);
  if (result.via === "INVITE") {
    return [
      `**${result.ign}'s request had already expired** — Hypixel drops one five minutes after it is made.`,
      `Sent \`/guild invite ${result.ign}\` instead. They are not in the guild until they accept the invite themselves.`,
    ].join("\n");
  }
  const left = result.remainingMs > 0 ? ` ${formatRemaining(result.remainingMs)} of their request window to spare.` : "";
  const recorded = result.recorded
    ? " Their screening row is marked."
    : " No pending screening matched them, so only the in-game command was sent.";
  return `Sent \`/guild accept ${result.ign}\`.${recorded}${left}`;
}
