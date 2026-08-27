/**
 * Staff-facing rendering: the log embeds, paginated histories, and the honest
 * phrasing for each way a Discord effect can refuse.
 */
import type {
  ActionRowView,
  ApplicationDTO,
  ButtonView,
  EmbedFieldView,
  EmbedView,
  FilterTestDTO,
  GuildEffectError,
  InfractionDTO,
  LockdownStateDTO,
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

// ─────────────────── Lockdown (ADMIN_BOT.md §6) ───────────────────

/**
 * `/lockdown` is one command with a card, not two commands and a `confirm:true`.
 *
 * `confirm:true` is typed on the same line as the mistake, by the same person,
 * in the same second — it confirms nothing. A card that names what is about to
 * shut, and a button that says so, is a second look with the facts in it. And
 * one command means a staffer under pressure never has to remember which of two
 * names ends a lockdown: whatever is in force, `/lockdown` shows the way out.
 */
export const LOCKDOWN_NAMESPACE = "lockdown";

/**
 * How much of a reason survives into the button.
 *
 * The reason has to reach the confirm click, and a button carries its state in
 * a customId Discord caps at 100 characters. The widest id this builds is
 * `lockdown:channel:<19-digit id>:<duration>:` at ~40, so 60 always fits. The
 * card shows the reason already trimmed to this, so what the reader approves is
 * exactly what gets recorded — a silent truncation after the click would not be.
 */
export const LOCKDOWN_REASON_MAX = 60;

export interface LockdownPrompt {
  /** Where the command was typed — the channel the "here" button locks. */
  readonly channelId: string | null;
  readonly reason: string;
  /** As typed (`30m`), not parsed: the button carries the same token onward. */
  readonly duration: string | null;
  /** Set when a click found the world had changed under it. */
  readonly notice?: string;
  readonly now?: Date;
}

export function trimLockdownReason(raw: string | null): string {
  const reason = (raw ?? "").trim();
  return reason.length > LOCKDOWN_REASON_MAX ? `${reason.slice(0, LOCKDOWN_REASON_MAX - 1).trimEnd()}…` : reason;
}

/** `lockdown:<action>:<channel|->:<duration|->:<reason>` — all the click needs. */
export function lockdownId(action: LockdownAction, prompt: LockdownArgs): string {
  return [LOCKDOWN_NAMESPACE, action, prompt.channelId ?? "-", prompt.duration ?? "-", prompt.reason].join(":");
}

export type LockdownAction = "channel" | "server" | "lift";

export interface LockdownArgs {
  readonly channelId: string | null;
  readonly duration: string | null;
  readonly reason: string;
}

const LOCKDOWN_ACTIONS: readonly string[] = ["channel", "server", "lift"];

/**
 * Parse a lockdown button back into arguments.
 *
 * The reason is the remainder rather than one more segment, because a reason
 * may contain a colon and losing half of it at the click is exactly the kind of
 * silent edit this command must not make.
 */
export function parseLockdownId(
  segments: readonly string[],
): ({ readonly action: LockdownAction } & LockdownArgs) | null {
  const [action, channelId, duration, ...rest] = segments;
  if (action === undefined || !LOCKDOWN_ACTIONS.includes(action)) return null;
  const dash = (raw: string | undefined): string | null => (raw === undefined || raw === "-" ? null : raw);
  return {
    action: action as LockdownAction,
    channelId: dash(channelId),
    duration: dash(duration),
    reason: rest.join(":"),
  };
}

function lockScope(lock: LockdownStateDTO): string {
  return lock.scope === "SERVER" ? "the whole server" : lock.channelId ? `<#${lock.channelId}>` : "one channel";
}

function startedAt(lock: LockdownStateDTO | null): Date | null {
  if (!lock) return null;
  const at = Date.parse(lock.startedAt);
  return Number.isFinite(at) ? new Date(at) : null;
}

/**
 * The card `/lockdown` answers with — either "here is what will shut" or "here
 * is what is already shut and how to end it".
 *
 * Public, not ephemeral: the buttons are gated by role, so the only thing an
 * onlooker gains is knowing the server is locked, which they were about to find
 * out by trying to type. In exchange, confirming updates this same message into
 * the record of what happened, so the warning and the announcement are one
 * message rather than two that can disagree.
 */
export function renderLockdownEmbed(status: SafetyStatusDTO, prompt: LockdownPrompt): EmbedView {
  const lock = status.lockdown;
  const target = prompt.channelId ? `<#${prompt.channelId}>` : "this channel";
  const headline = lock
    ? `${lockScope(lock)} is locked.`
    : `Nothing is locked. Choose what to shut — ${target}, or the whole server.`;

  const detail = lock
    ? facts([
        { label: "Locked", value: lockScope(lock) },
        { label: "By", value: `<@${lock.actorDiscordId}>` },
        { label: "Reason", value: lock.reason },
        { label: "Lifts", value: lock.expiresAt ? relativeTs(lock.expiresAt) : "only when a staffer ends it" },
        ...(lock.absorbedChannelId
          ? [{ label: "Absorbed", value: `<#${lock.absorbedChannelId}>` }]
          : []),
      ])
    : facts([
        { label: "Reason", value: prompt.reason === "" ? "none given" : prompt.reason },
        { label: "Duration", value: prompt.duration ?? "none — it stays until lifted" },
        { label: "Effect", value: "@everyone loses Send Messages. Channels already shut stay shut." },
      ]);

  return card({
    tone: lock ? "DANGER" : "WARNING",
    title: "Lockdown",
    headline: prompt.notice ? `${prompt.notice}\n\n${headline}` : headline,
    fields: [field(lock ? "In force" : "About to happen", detail)],
    // A lock is dated from when it started; a fresh prompt from now. An
    // unparseable stored date falls back rather than throwing: a card without an
    // age still tells staff the server is shut, and a thrown render tells them
    // nothing at all.
    timestamp: (startedAt(lock) ?? prompt.now ?? new Date()).toISOString(),
  });
}

/**
 * The buttons under the card.
 *
 * With a channel lock in force this always offers *both* ways forward: end it,
 * or widen it to the server. A staffer who types `/lockdown` in the wrong
 * channel during a raid is not asking a question about that channel — they are
 * trying to stop something, and the answer they need is on the card in front of
 * them rather than in a second command they have to remember the name of.
 */
export function renderLockdownControls(
  status: SafetyStatusDTO,
  prompt: LockdownArgs,
): readonly ActionRowView[] {
  const lock = status.lockdown;
  const buttons: ButtonView[] = [];

  if (lock) {
    buttons.push({ label: "Lift the lockdown", style: "SUCCESS", customId: lockdownId("lift", prompt) });
    if (lock.scope === "CHANNEL") {
      buttons.push({
        label: "Lock the whole server",
        style: "DANGER",
        customId: lockdownId("server", prompt),
      });
    }
  } else {
    buttons.push({ label: "Lock this channel", style: "DANGER", customId: lockdownId("channel", prompt) });
    buttons.push({ label: "Lock the whole server", style: "DANGER", customId: lockdownId("server", prompt) });
  }

  return [{ buttons }];
}
