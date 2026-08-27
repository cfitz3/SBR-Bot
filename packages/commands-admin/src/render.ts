/**
 * Staff-facing rendering: the log embeds, paginated histories, and the honest
 * phrasing for each way a Discord effect can refuse.
 */
import type {
  ActionRowView,
  ApplicationDTO,
  EmbedFieldView,
  EmbedView,
  FilterTestDTO,
  GuildEffectError,
  InfractionDTO,
  ModerationActionDTO,
  SafetyError,
  SafetyStatusDTO,
  TicketDTO,
  WordlistRuleDTO,
} from "@sbr/shared-types";
import { padInlineRow } from "@sbr/shared-types";
import { card, facts, field } from "@sbr/embed-kit";
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

/**
 * What to append to a punishment's confirmation, given how enforcement went.
 *
 * Empty when it worked, because a staffer who typed `/ban` does not need to be
 * told the ban banned. Loud when it did not: the case is on the books, the
 * member is not, and the person who typed the command is the one standing there
 * able to do something about it. Silence here is exactly the bug this whole
 * change is about — the old reply said "Banned" whether or not anybody was.
 */
export function renderEnforcement(action: ModerationActionDTO): string {
  if (action.enforcement !== "FAILED") return "";
  const detail = action.enforcementDetail ?? "no reason recorded";
  return `\n\n⚠️ **It did not take effect.** ${detail}\nThe case is logged as \`enforcement_failed\` — this needs doing by hand.`;
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
 * `/audit` — the moderation log, as an answer rather than a scroll.
 *
 * What it replaced: ten fields per page, each field *name* built out of data —
 * `BAN (expired) · 3 days ago` — with the member, the actor and the reason
 * crushed into the value. Field names are labels; putting the record in them
 * means Discord renders the whole log in bold and the reader's eye has nothing
 * to anchor on. It also meant the only way to find a case was to read every
 * page until it went past.
 *
 * So the shape is now overview first, detail on click. The overview answers the
 * questions staff actually open `/audit` with — how much happened, how much of
 * it is still being enforced, what kind, and who has been busy — and the select
 * menu underneath it takes any one of the matching cases straight to its card.
 * A case id stops being a prerequisite for looking a case up.
 *
 * The state comes from `punishmentState` rather than the `active` column, so a
 * mute that ran its time out reads "expired" instead of "lifted" — the column
 * cannot tell those apart, and a staffer reading the log to see whether somebody
 * was let off early needs to.
 */

/** Discord's own cap on a select menu. Not a taste decision. */
export const CASE_SELECT_LIMIT = 25;

/** How many actors the overview names before it stops being an overview. */
const TOP_ACTORS = 3;

/** The component namespace `/audit`'s case menu routes on. */
export const CASE_SELECT_NAMESPACE = "case";

function countBy<T>(rows: readonly T[], key: (row: T) => string | null): readonly (readonly [string, number])[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const k = key(row);
    if (k === null) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * The first card `/audit` returns: what the filters matched, in aggregate.
 *
 * `rows` is the page of results, which may be a truncated view of a longer log —
 * every number here is therefore explicitly about the matched window rather than
 * about all of history, because a total that quietly means "the first hundred"
 * is worse than no total.
 */
export function renderAuditOverviewEmbed(
  rows: readonly ModerationActionDTO[],
  options: {
    readonly truncated?: boolean;
    readonly now?: Date;
    readonly rangeLabel?: string;
    /** A caveat about the query itself — an unreadable date option, today. */
    readonly notice?: string;
  } = {},
): EmbedView {
  const now = options.now ?? new Date();
  const inForce = rows.filter((r) => {
    const state = punishmentState(r, now);
    return state === "ACTIVE";
  }).length;

  const byType = countBy(rows, (r) => r.type);
  const byActor = countBy(rows, (r) => r.actorDiscordId);
  const newest = rows[0];
  const oldest = rows[rows.length - 1];

  return card({
    tone: "INFO",
    title: "Audit log",
    // The headline carries the count, because the count is the answer to the
    // question that was asked. "and there are more" is not a footnote: a
    // truncated log that says nothing reads as a complete one.
    // The notice rides in the headline rather than in the reply text above the
    // card, because `replyOptions` drops the text when an embed is present — a
    // warning put there would be silently discarded, which is the exact failure
    // it exists to prevent.
    headline: [
      options.truncated
        ? `Newest ${rows.length} of more than that. Narrow the filters to see further back.`
        : `${rows.length} action${rows.length === 1 ? "" : "s"} match.`,
      options.notice,
    ]
      .filter((line): line is string => !!line)
      .join("\n"),
    fields: [
      field(
        "Scope",
        facts([
          { label: "Range", value: options.rangeLabel ?? "All time" },
          { label: "Still in force", value: inForce === 0 ? "None" : String(inForce) },
          ...(newest && oldest
            ? [
                { label: "Newest", value: relativeTs(newest.createdAt) },
                { label: "Oldest", value: relativeTs(oldest.createdAt) },
              ]
            : []),
        ]),
      ),
      field(
        "By type",
        byType.map(([type, n]) => `**${type}** ${n}`).join("\n"),
        true,
      ),
      field(
        "Busiest staff",
        byActor
          .slice(0, TOP_ACTORS)
          .map(([id, n]) => `${actorMention(id)} — ${n}`)
          .join("\n"),
        true,
      ),
    ],
    // Not the send time: the newest matched action is what dates this view, and
    // it is the same instant whether the reply comes back now or is scrolled
    // back to tomorrow.
    ...(newest ? { timestamp: newest.createdAt } : {}),
  });
}

/**
 * A mention, unless the actor is one of the platform's own sentinels.
 *
 * `automod`, `expiry` and `discord` are not snowflakes, and rendering them as
 * `<@expiry>` produces the literal broken text rather than a name.
 */
function actorMention(actorDiscordId: string): string {
  return /^\d+$/.test(actorDiscordId) ? `<@${actorDiscordId}>` : actorDiscordId;
}

/**
 * The menu that turns the overview into a lookup.
 *
 * All the state is in the option values — a case id, which is exactly the thing
 * the handler needs — so the menu keeps working after a restart, like every
 * other persistent control on the platform. Twenty-five is Discord's cap; a
 * result set longer than that is a sign the filters want narrowing, which the
 * placeholder says.
 */
export function renderCaseSelectRow(
  rows: readonly ModerationActionDTO[],
  options: { readonly now?: Date } = {},
): readonly ActionRowView[] {
  const now = options.now ?? new Date();
  const shown = rows.slice(0, CASE_SELECT_LIMIT);
  if (shown.length === 0) return [];
  return [
    {
      buttons: [],
      select: {
        customId: CASE_SELECT_NAMESPACE,
        placeholder:
          rows.length > CASE_SELECT_LIMIT
            ? `Open a case — newest ${CASE_SELECT_LIMIT} of ${rows.length}`
            : "Open a case",
        options: shown.map((r) => {
          const state = punishmentState(r, now);
          const suffix = state === "MOMENTARY" || state === "ACTIVE" ? "" : ` (${describeState(state)})`;
          const target = r.targetDiscordId ?? "unlinked";
          return {
            label: `${r.type}${suffix} · ${r.id}`.slice(0, 100),
            value: r.id,
            // The description is where the reader recognises the case: who it
            // was about and why. Truncated hard, because Discord rejects the
            // whole menu over one long reason rather than trimming it.
            description: `${target} — ${r.reason ?? "no reason recorded"}`.slice(0, 100),
          };
        }),
      },
    },
  ];
}

/**
 * The full listing, for the reader who wants to read rather than search.
 *
 * Five rows a page rather than ten, and each row is one field whose *name* is a
 * label — the case id — with the record in the value where Discord will render
 * it as prose. That is the whole difference from the version this replaces: the
 * data is no longer the label.
 */
export function renderAuditPages(
  rows: readonly ModerationActionDTO[],
  options: { readonly truncated?: boolean; readonly now?: Date } = {},
): readonly EmbedView[] {
  const now = options.now ?? new Date();
  return paginate(rows, 5, (slice, i, total) =>
    card({
      tone: "INFO",
      title: "Audit log",
      headline: options.truncated
        ? `Newest ${rows.length} of more than that. Narrow the filters to see further back.`
        : `${rows.length} action${rows.length === 1 ? "" : "s"} match.`,
      fields: slice.map((r) => {
        const target = r.targetDiscordId ? `<@${r.targetDiscordId}>` : "an unlinked member";
        const state = punishmentState(r, now);
        return field(
          `Case ${r.id}`,
          facts([
            {
              label: r.type,
              value:
                state === "MOMENTARY" || state === "ACTIVE"
                  ? relativeTs(r.createdAt)
                  : `${relativeTs(r.createdAt)} — ${describeState(state)}`,
            },
            { label: "Member", value: target },
            { label: "Staff", value: actorMention(r.actorDiscordId) },
            { label: "Reason", value: r.reason },
            ...(r.expiresAt !== null
              ? [{ label: state === "ACTIVE" ? "Expires" : "Ended", value: relativeTs(r.expiresAt) }]
              : []),
          ]),
        );
      }),
      footer: pageFooter(i, total),
      ...(slice[0] ? { timestamp: slice[0].createdAt } : {}),
    }),
  );
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

// ───────────────────────────── Tickets (/tickets) ─────────────────────────────

/**
 * The open queue.
 *
 * Number first and in the name position, because "#12" is what staff say to
 * each other and what they will type back into `/tickets view`. Claimed rows
 * name their owner: the question this list actually answers is "which of these
 * is nobody looking at".
 */
export function renderTicketListEmbed(tickets: readonly TicketDTO[]): EmbedView {
  if (tickets.length === 0) {
    return { title: "Open tickets", description: "Nothing open.", color: "NEUTRAL" };
  }
  return {
    title: `Open tickets (${tickets.length})`,
    fields: tickets.slice(0, 10).map((t) => ({
      name: `#${String(t.number)} — ${t.categoryName ?? "uncategorised"}`,
      value: [
        `<@${t.openerDiscordId}>`,
        t.claimedByDiscordId === null ? "unclaimed" : `claimed by <@${t.claimedByDiscordId}>`,
        t.channelId === null ? "no channel" : `<#${t.channelId}>`,
        relativeTs(t.createdAt),
      ].join(" • "),
      inline: false,
    })),
    footer: "Open one with /tickets action:view id:<number>.",
    color: "INFO",
  };
}

/**
 * One ticket.
 *
 * "Answered" is shown rather than a response-time figure: the number matters in
 * aggregate on the panel, but a staffer reading a single ticket wants to know
 * whether anybody has replied yet, and an em dash says that more plainly than
 * "0 ms" ever could.
 */
export function renderTicketEmbed(ticket: TicketDTO): EmbedView {
  return {
    title: `Ticket #${String(ticket.number)} — ${ticket.categoryName ?? "uncategorised"}`,
    ...(ticket.topic === null ? {} : { description: ticket.topic }),
    fields: padInlineRow([
      { name: "Opened by", value: `<@${ticket.openerDiscordId}>`, inline: true },
      { name: "Status", value: ticket.status.toLowerCase(), inline: true },
      { name: "Opened", value: relativeTs(ticket.createdAt), inline: true },
      {
        name: "Claimed by",
        value: ticket.claimedByDiscordId === null ? "—" : `<@${ticket.claimedByDiscordId}>`,
        inline: true,
      },
      {
        name: "Answered",
        value: ticket.firstStaffReplyAt === null ? "—" : relativeTs(ticket.firstStaffReplyAt),
        inline: true,
      },
      {
        name: "Channel",
        value: ticket.channelId === null ? "—" : `<#${ticket.channelId}>`,
        inline: true,
      },
      ...(ticket.closedAt === null
        ? []
        : [{ name: "Closed", value: relativeTs(ticket.closedAt), inline: true }]),
      ...(ticket.closeReason === null
        ? []
        : [{ name: "Close reason", value: ticket.closeReason, inline: false }]),
    ]),
    footer: `id ${ticket.id}`,
    color: ticket.status === "CLOSED" ? "NEUTRAL" : "INFO",
  };
}
