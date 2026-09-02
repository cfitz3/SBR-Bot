/**
 * Staff command handlers. Thin by design: assemble the input, call the service
 * that owns the rule (ModerationService enforces rank and duration, SafetyService
 * owns posture expiry, GuildConfigService owns persistence), render the verdict.
 *
 * Anything that reaches Discord itself — kicking, purging, locking channels —
 * goes through the `effects` port, so this layer stays transport-agnostic and
 * testable without a gateway connection.
 */
import type {
  EmbedView,
  MemberRole,
  ModActionType,
  RaidSensitivity,
  TicketDTO,
  WordAction,
  WordMatchType,
} from "@sbr/shared-types";
import { copy, withCommandCopy } from "@sbr/brand";
import { isEscalation, modLogEmbed } from "@sbr/moderation";
import type {
  AdminCommandSpec,
  AdminContext,
  AdminHandler,
  AdminHandlerDeps,
  AdminReply,
} from "./types.js";
import { parseDurationSeconds, renderModError } from "./util.js";
import type { JoinActionResult, JoinQueueService } from "@sbr/screening";
import {
  relativeTs,
  renderAdmit,
  renderApplicationEmbed,
  renderApplicationListEmbed,
  renderAuditOverviewEmbed,
  renderAuditPages,
  renderCaseSelectRow,
  renderEffectError,
  renderEnforcement,
  renderFilterTestEmbed,
  renderInfractionPages,
  renderJoinAction,
  renderJoinQueueEmbed,
  renderSafetyError,
  renderSafetyStatusEmbed,
  renderTicketEmbed,
  renderTicketListEmbed,
  renderWordlistEmbed,
} from "./render.js";

const E = copy.error;

const NO_REASON = "No reason given";

/** Page 1 doubles as the single embed, so a transport with no pager still shows something. */
function paged(pages: readonly EmbedView[]): {
  readonly embed?: EmbedView;
  readonly pages?: readonly EmbedView[];
} {
  const first = pages[0];
  return first ? { embed: first, pages } : {};
}

// ── Moderation ──────────────────────────────────────────────────────────────

const warn: AdminHandler = async (ctx, deps) => {
  const target = ctx.args.getUser("target");
  if (!target) return { ephemeral: true, text: "Usage: /warn target:<user> reason:<text>" };
  const result = await deps.moderation.applyAction({
    guildId: ctx.guildId,
    type: "WARN",
    actorDiscordId: ctx.actorId,
    targetDiscordId: target,
    reason: ctx.args.getString("reason") ?? NO_REASON,
  });
  if (!result.ok) return { ephemeral: true, text: renderModError(result.error) };

  // A warning can trip the escalation ladder, and the staffer who typed /warn is
  // the one person who needs to know that it did — they are about to decide
  // whether to do anything further. Read it back rather than have the service
  // report it: what is being enforced *now* is the question, and that is a
  // different question from what this call happened to write.
  const enforced = await deps.moderation.listInForce(ctx.guildId, target);
  const live = enforced.ok ? enforced.value.filter((a) => isEscalation(a.reason)) : [];
  const escalated = live[0];
  const note = escalated
    ? ` Escalated automatically: ${escalated.type.toLowerCase()}${escalated.expiresAt ? ` until ${escalated.expiresAt}` : " (permanent)"}.`
    : "";
  return {
    ephemeral: false,
    text: `Warned <@${target}>. (case ${result.value.id})${note}${renderEnforcement(result.value)}`,
  };
};

const mute: AdminHandler = async (ctx, deps) => {
  const target = ctx.args.getUser("target");
  if (!target) return { ephemeral: true, text: "Usage: /mute target:<user> duration:<1h> reason:<text>" };
  const result = await deps.moderation.applyAction({
    guildId: ctx.guildId,
    type: "MUTE",
    actorDiscordId: ctx.actorId,
    targetDiscordId: target,
    reason: ctx.args.getString("reason") ?? NO_REASON,
    durationSeconds: parseDurationSeconds(ctx.args.getString("duration")) ?? null,
  });
  if (!result.ok) return { ephemeral: true, text: renderModError(result.error) };
  return {
    ephemeral: false,
    text:
      `Muted <@${target}> across ${result.value.surfaces.join(" + ")} until ${result.value.expiresAt}. ` +
      `(case ${result.value.id})${renderEnforcement(result.value)}`,
  };
};

const ban: AdminHandler = async (ctx, deps) => {
  const target = ctx.args.getUser("target");
  if (!target) return { ephemeral: true, text: "Usage: /ban target:<user> reason:<text>" };
  const result = await deps.moderation.applyAction({
    guildId: ctx.guildId,
    type: "BAN",
    actorDiscordId: ctx.actorId,
    targetDiscordId: target,
    reason: ctx.args.getString("reason") ?? NO_REASON,
    durationSeconds: parseDurationSeconds(ctx.args.getString("duration")) ?? null,
  });
  if (!result.ok) return { ephemeral: true, text: renderModError(result.error) };
  return {
    ephemeral: false,
    text: `Banned <@${target}>. (case ${result.value.id})${renderEnforcement(result.value)}`,
  };
};

/**
 * `/unmute` and `/unban` — the other half of `/mute` and `/ban`, which the bot
 * simply did not have.
 *
 * Lifting a punishment was panel-only: a staffer who muted somebody from Discord
 * could not un-mute them from Discord, and a ban was irreversible without a
 * server admin doing it by hand outside the platform. Both go through
 * `applyAction` like everything else, so the reversal is audited, mirrored,
 * relayed to guild chat as `/g unmute`, and confirmed on both surfaces.
 */
const unmute: AdminHandler = async (ctx, deps) => {
  const target = ctx.args.getUser("target");
  if (!target) return { ephemeral: true, text: "Usage: /unmute target:<user> [reason:<text>]" };
  const result = await deps.moderation.applyAction({
    guildId: ctx.guildId,
    type: "UNMUTE",
    actorDiscordId: ctx.actorId,
    targetDiscordId: target,
    reason: ctx.args.getString("reason") ?? NO_REASON,
  });
  if (!result.ok) return { ephemeral: true, text: renderModError(result.error) };
  return {
    ephemeral: false,
    text: `Unmuted <@${target}>. (case ${result.value.id})${renderEnforcement(result.value)}`,
  };
};

const unban: AdminHandler = async (ctx, deps) => {
  const target = ctx.args.getUser("target");
  if (!target) return { ephemeral: true, text: "Usage: /unban target:<user> [reason:<text>]" };
  const result = await deps.moderation.applyAction({
    guildId: ctx.guildId,
    type: "UNBAN",
    actorDiscordId: ctx.actorId,
    targetDiscordId: target,
    reason: ctx.args.getString("reason") ?? NO_REASON,
  });
  if (!result.ok) return { ephemeral: true, text: renderModError(result.error) };
  return {
    ephemeral: false,
    text: `Unbanned <@${target}>. (case ${result.value.id})${renderEnforcement(result.value)}`,
  };
};

/**
 * `/kick`. The audit entry is written first: a kick that Discord accepted but we
 * never logged is the worse of the two failures, since the member is gone either
 * way and only the record can explain why.
 *
 * The Discord call itself used to sit here, in the handler, which made `/kick`
 * the only punishment that actually reached Discord — and made it the only one
 * whose enforcement the automod path could not share. It now goes through the
 * service like the rest, so manual and automatic kicks take exactly one route.
 */
const kick: AdminHandler = async (ctx, deps) => {
  const target = ctx.args.getUser("target");
  if (!target) return { ephemeral: true, text: "Usage: /kick target:<user> reason:<text>" };
  const reason = ctx.args.getString("reason") ?? NO_REASON;

  const recorded = await deps.moderation.applyAction({
    guildId: ctx.guildId,
    type: "KICK",
    actorDiscordId: ctx.actorId,
    targetDiscordId: target,
    reason,
  });
  if (!recorded.ok) return { ephemeral: true, text: renderModError(recorded.error) };

  return {
    ephemeral: recorded.value.enforcement === "FAILED",
    text: `Kicked <@${target}>. (case ${recorded.value.id})${renderEnforcement(recorded.value)}`,
  };
};

/** `/purge`. Bounded at 100 by Discord's bulk-delete API; the spec caps it there too. */
const purge: AdminHandler = async (ctx, deps) => {
  const count = ctx.args.getNumber("count");
  if (count === null || count < 1 || count > 100) {
    return { ephemeral: true, text: "Usage: /purge count:<1-100> [user:<member>] [channel:<channel>]" };
  }
  const channelId = ctx.args.getChannel("channel") ?? ctx.channelId ?? null;
  if (!channelId) return { ephemeral: true, text: E.surface.nameChannel };

  const result = await deps.effects.purge({
    guildId: ctx.guildId,
    channelId,
    count: Math.floor(count),
    userId: ctx.args.getUser("user"),
  });
  if (!result.ok) return { ephemeral: true, text: renderEffectError(result.error) };

  await deps.moderation.applyAction({
    guildId: ctx.guildId,
    type: "NOTE",
    actorDiscordId: ctx.actorId,
    targetDiscordId: null,
    reason: `Purged ${result.value} message(s) in ${channelId}`,
  });
  // Discord silently skips messages older than 14 days, so report what was
  // actually deleted rather than what was asked for.
  return { ephemeral: true, text: `Deleted ${result.value} message(s) in <#${channelId}>.` };
};

/** `/member-note` — a private staff note, recorded but never enforced. */
const memberNote: AdminHandler = async (ctx, deps) => {
  const target = ctx.args.getUser("target");
  const note = ctx.args.getString("note");
  if (!target || !note) return { ephemeral: true, text: "Usage: /member-note target:<user> note:<text>" };

  const result = await deps.moderation.applyAction({
    guildId: ctx.guildId,
    type: "NOTE",
    actorDiscordId: ctx.actorId,
    targetDiscordId: target,
    reason: note,
  });
  if (!result.ok) return { ephemeral: true, text: renderModError(result.error) };
  return { ephemeral: true, text: `Noted against <@${target}>. (case ${result.value.id})` };
};

const infractions: AdminHandler = async (ctx, deps) => {
  const target = ctx.args.getUser("target");
  if (!target) return { ephemeral: true, text: "Usage: /infractions target:<user>" };
  const result = await deps.moderation.listInfractions(ctx.guildId, target);
  if (!result.ok) return { ephemeral: true, text: E.generic.loadFailed };
  if (result.value.length === 0) {
    return { ephemeral: true, text: `<@${target}> has a clean record.` };
  }
  return {
    ephemeral: true,
    text: `<@${target}> has ${result.value.length} infraction(s) on record.`,
    ...paged(renderInfractionPages(target, result.value)),
  };
};

/**
 * `/audit` — the moderation log. Every filter is optional and narrows the search.
 *
 * One more row is asked for than is shown, because a log that quietly stops at
 * a hundred looks exactly like a log with a hundred entries in it. The extra row
 * is the difference between the two, and is dropped before rendering.
 */
const AUDIT_PAGE_LIMIT = 100;

/**
 * A date option, as a day rather than an instant.
 *
 * Staff type `2026-03-14`, and they mean the whole of that day. So `from` is
 * read as its first moment and `to` as its last — `to:2026-03-14` including
 * everything that happened on the 14th is the only reading that is not a
 * surprise. An unparseable value becomes `null` and the filter is simply not
 * applied, which the reply then says: silently returning an empty log for a
 * typo would read as "nothing happened".
 */
function parseDayOption(raw: string | null, end: boolean): string | null {
  const text = raw?.trim();
  if (!text) return null;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T${end ? "23:59:59.999" : "00:00:00.000"}Z` : text);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** What the overview's Range line says, given whichever bounds were supplied. */
function rangeLabel(days: number | null, since: string | null, until: string | null): string {
  const day = (iso: string): string => iso.slice(0, 10);
  if (since && until) return `${day(since)} → ${day(until)}`;
  if (since) return `since ${day(since)}`;
  if (until) return `up to ${day(until)}`;
  if (days) return `last ${days} day${days === 1 ? "" : "s"}`;
  return "All time";
}

const audit: AdminHandler = async (ctx, deps) => {
  const inForceOnly = ctx.args.getBoolean("in_force") ?? false;
  const days = ctx.args.getNumber("days");
  const rawFrom = ctx.args.getString("from");
  const rawTo = ctx.args.getString("to");
  const since = parseDayOption(rawFrom, false);
  const until = parseDayOption(rawTo, true);
  // Named rather than swallowed. A date the parser could not read is the one
  // case where an empty result would be actively misleading, so say which
  // option was dropped before the numbers are read as fact.
  const ignored = [
    ...(rawFrom && since === null ? ["from"] : []),
    ...(rawTo && until === null ? ["to"] : []),
  ];

  const result = await deps.moderation.listActions({
    guildId: ctx.guildId,
    actorDiscordId: ctx.args.getUser("actor"),
    targetDiscordId: ctx.args.getUser("target"),
    type: (ctx.args.getString("type") as ModActionType | null) ?? null,
    sinceDays: days,
    since,
    until,
    inForceOnly,
    limit: AUDIT_PAGE_LIMIT + 1,
  });
  if (!result.ok) return { ephemeral: true, text: E.generic.loadFailed };
  if (result.value.length === 0) {
    return {
      ephemeral: true,
      text:
        (inForceOnly
          ? "Nothing is being enforced right now."
          : "No moderation actions match those filters.") + unreadable(ignored),
    };
  }

  const truncated = result.value.length > AUDIT_PAGE_LIMIT;
  const rows = truncated ? result.value.slice(0, AUDIT_PAGE_LIMIT) : result.value;
  const label = rangeLabel(days, since, until);
  // Overview first, then the listing, as one paginated set: the reader who
  // wanted a number has it in the reply, and the reader who wanted the entries
  // is one page away. The case menu rides alongside both — `respond` appends
  // the pager to whatever components the reply carries — so a case can be
  // opened from any page.
  return {
    ephemeral: true,
    text: unreadable(ignored).trim(),
    ...paged([
      renderAuditOverviewEmbed(rows, {
        truncated,
        rangeLabel: inForceOnly ? `${label} · in force` : label,
        notice: unreadable(ignored).trim(),
      }),
      ...renderAuditPages(rows, { truncated }),
    ]),
    components: renderCaseSelectRow(rows),
  };
};

function unreadable(ignored: readonly string[]): string {
  return ignored.length === 0
    ? ""
    : `\n⚠️ Couldn't read \`${ignored.join("` and `")}\` as a date (use YYYY-MM-DD); that filter was ignored.`;
}

/**
 * `/case <id>` — one action, by the id every reply already quotes.
 *
 * The ids have been handed out since the first punishment landed — "(case
 * act-1f3b)" in the confirmation, in the mod-log card, in whatever appeal the
 * member opens afterwards — and until now there was nothing that took one back.
 * Staff paged `/audit` until the row turned up, which stops working at exactly
 * the point the log gets long enough to need searching.
 *
 * Rendered through `modLogEmbed`, the same renderer the log channel uses, so a
 * case looked up months later reads identically to the card posted when it
 * happened — including whether enforcement actually took.
 */
const caseLookup: AdminHandler = async (ctx, deps) => {
  const id = ctx.args.getString("id")?.trim();
  if (!id) return { ephemeral: true, text: "Usage: /case id:<case id>" };
  const result = await deps.moderation.findAction(ctx.guildId, id);
  if (!result.ok) return { ephemeral: true, text: E.generic.loadFailed };
  if (result.value === null) {
    // Deliberately not "no such case": the lookup is guild-scoped, so a real id
    // from another server lands here too, and staff should not learn which.
    return { ephemeral: true, text: `No case \`${id}\` in this server.` };
  }
  return {
    ephemeral: true,
    text: `Case ${result.value.id}:`,
    embed: modLogEmbed(result.value),
  };
};

// ── Safety postures ─────────────────────────────────────────────────────────

const lockdown: AdminHandler = async (ctx, deps) => {
  const scope = ctx.args.getString("scope") === "server" ? "SERVER" : "CHANNEL";
  const result = await deps.safety.lockdown({
    guildId: ctx.guildId,
    actorDiscordId: ctx.actorId,
    scope,
    channelId: scope === "CHANNEL" ? (ctx.args.getChannel("channel") ?? ctx.channelId ?? null) : null,
    reason: ctx.args.getString("reason") ?? NO_REASON,
    durationSeconds: parseDurationSeconds(ctx.args.getString("duration")) ?? null,
  });
  if (!result.ok) return { ephemeral: true, text: renderSafetyError(result.error) };

  const until = result.value.expiresAt
    ? `Lifts automatically ${relativeTs(result.value.expiresAt)}.`
    : "No expiry set — remember to lift it with /lockdown-lift.";
  const where = result.value.channelId ? `<#${result.value.channelId}>` : "the whole server";
  return { ephemeral: false, text: `🔒 Locked down ${where}. ${until}` };
};

const lockdownLift: AdminHandler = async (ctx, deps) => {
  const result = await deps.safety.liftLockdown(ctx.guildId);
  if (!result.ok) return { ephemeral: true, text: E.command.adminFailed };
  if (!result.value) return { ephemeral: true, text: "Nothing is locked down right now." };
  const where = result.value.channelId ? `<#${result.value.channelId}>` : "the server";
  return { ephemeral: false, text: `🔓 Lifted the lockdown on ${where}.` };
};

const antiraidOn: AdminHandler = async (ctx, deps) => {
  const result = await deps.safety.enableAntiRaid({
    guildId: ctx.guildId,
    actorDiscordId: ctx.actorId,
    sensitivity: (ctx.args.getString("sensitivity") as RaidSensitivity | null) ?? "MEDIUM",
    durationSeconds: parseDurationSeconds(ctx.args.getString("duration")) ?? null,
  });
  if (!result.ok) return { ephemeral: true, text: renderSafetyError(result.error) };
  const until = result.value.expiresAt ? ` until ${relativeTs(result.value.expiresAt)}` : "";
  return { ephemeral: false, text: `🛡️ Anti-raid on at ${result.value.sensitivity} sensitivity${until}.` };
};

const antiraidOff: AdminHandler = async (ctx, deps) => {
  const result = await deps.safety.disableAntiRaid(ctx.guildId);
  if (!result.ok) return { ephemeral: true, text: renderSafetyError(result.error) };
  return { ephemeral: false, text: "🛡️ Anti-raid off." };
};

const safetyStatus: AdminHandler = async (ctx, deps) => {
  const result = await deps.safety.status(ctx.guildId);
  if (!result.ok) return { ephemeral: true, text: E.generic.loadFailed };
  return { ephemeral: true, text: "Safety status", embed: renderSafetyStatusEmbed(result.value) };
};

// ── Chat filter ─────────────────────────────────────────────────────────────

const wordlist: AdminHandler = async (ctx, deps) => {
  const result = await deps.wordlist.list(ctx.guildId);
  if (!result.ok) return { ephemeral: true, text: E.generic.loadFailed };
  return { ephemeral: true, text: `${result.value.length} rule(s).`, embed: renderWordlistEmbed(result.value) };
};

const wordlistAdd: AdminHandler = async (ctx, deps) => {
  const pattern = ctx.args.getString("pattern");
  if (!pattern) {
    return { ephemeral: true, text: "Usage: /wordlist-add pattern:<text> match_type:<kind> action:<action>" };
  }
  const result = await deps.wordlist.add({
    guildId: ctx.guildId,
    pattern,
    matchType: (ctx.args.getString("match_type") as WordMatchType | null) ?? "SUBSTRING",
    action: (ctx.args.getString("action") as WordAction | null) ?? "BLOCK",
    severity: ctx.args.getNumber("severity") ?? 1,
    addedByDiscordId: ctx.actorId,
    note: ctx.args.getString("note"),
  });
  if (!result.ok) {
    return {
      ephemeral: true,
      text:
        result.error.kind === "DUPLICATE"
          ? "That exact rule already exists."
          : `That pattern isn't usable: ${result.error.detail}`,
    };
  }
  return {
    ephemeral: true,
    text: `Added \`${result.value.pattern}\` (${result.value.matchType} → ${result.value.action}). id \`${result.value.id}\``,
  };
};

const wordlistRemove: AdminHandler = async (ctx, deps) => {
  const ref = ctx.args.getString("rule");
  if (!ref) return { ephemeral: true, text: "Usage: /wordlist-remove rule:<id or exact pattern>" };
  const result = await deps.wordlist.remove(ctx.guildId, ref);
  if (!result.ok) return { ephemeral: true, text: E.command.adminFailed };
  if (!result.value) return { ephemeral: true, text: `No rule here matches \`${ref}\`.` };
  return { ephemeral: true, text: `Removed \`${result.value.pattern}\`.` };
};

/**
 * `/filter-test`. Runs the *same* compiled matchers the relay uses, so a rule
 * that passes here cannot behave differently in production.
 */
const filterTest: AdminHandler = async (ctx, deps) => {
  const text = ctx.args.getString("text");
  if (!text) return { ephemeral: true, text: "Usage: /filter-test text:<message>" };
  const result = await deps.wordlist.test(ctx.guildId, text);
  if (!result.ok) return { ephemeral: true, text: E.generic.loadFailed };
  return {
    ephemeral: true,
    text: result.value.matched.length > 0 ? `Caught — ${result.value.action}.` : "Allowed.",
    embed: renderFilterTestEmbed(result.value),
  };
};

// ── Configuration ───────────────────────────────────────────────────────────

const CHANNEL_SLOTS = ["bridge", "staff", "log", "applications", "events", "welcome"] as const;
type ChannelSlot = (typeof CHANNEL_SLOTS)[number];

const setChannel: AdminHandler = async (ctx, deps) => {
  const slot = ctx.args.getString("slot");
  if (!slot || !CHANNEL_SLOTS.includes(slot as ChannelSlot)) {
    return { ephemeral: true, text: `Pick a slot: ${CHANNEL_SLOTS.join(", ")}.` };
  }
  // An omitted channel clears the slot, which is the only way to unset one.
  const channelId = ctx.args.getChannel("channel");
  const result = await deps.config.setChannel(ctx.guildId, slot as ChannelSlot, channelId);
  if (!result.ok) return { ephemeral: true, text: E.command.adminFailed };
  return {
    ephemeral: true,
    text: channelId ? `${slot} channel set to <#${channelId}>.` : `${slot} channel cleared.`,
  };
};

const featureToggle: AdminHandler = async (ctx, deps) => {
  const feature = ctx.args.getString("feature");
  const enabled = ctx.args.getBoolean("enabled");
  if (!feature || enabled === null) {
    return { ephemeral: true, text: "Usage: /feature-toggle feature:<name> enabled:<true|false>" };
  }
  const result = await deps.config.setFeature(ctx.guildId, feature, enabled);
  if (!result.ok) return { ephemeral: true, text: E.command.adminFailed };
  return { ephemeral: true, text: `Feature \`${feature}\` is now ${enabled ? "on" : "off"}.` };
};

/**
 * `/set-recruitment`. One switch.
 *
 * It used to carry tri-state `min_weight` and `min_networth` options and a
 * `clear_requirements` wipe. The guild's only entry requirement is the scam
 * check now, so there is no bar to set and nothing to clear.
 */
const setRecruitment: AdminHandler = async (ctx, deps) => {
  const open = ctx.args.getBoolean("open");
  if (open === null) return { ephemeral: true, text: "Usage: /set-recruitment open:<true|false>" };

  const result = await deps.config.setRecruitment(ctx.guildId, { open });
  if (!result.ok) return { ephemeral: true, text: E.command.adminFailed };

  return { ephemeral: false, text: `Applications are now ${open ? "open" : "closed"}.` };
};

const ROLES: readonly MemberRole[] = ["MEMBER", "MODERATOR", "OFFICER", "ADMIN", "OWNER"];

/**
 * `/set-role`. Two jobs that look alike and are not: `member` changes someone's
 * platform rank, `mapping` binds a platform rank to a Discord role. Keeping them
 * behind one command with an explicit `type` is what the spec asks for.
 */
const setRole: AdminHandler = async (ctx, deps) => {
  const role = ctx.args.getString("role")?.toUpperCase() as MemberRole | undefined;
  if (!role || !ROLES.includes(role)) {
    return { ephemeral: true, text: `Pick a role: ${ROLES.join(", ")}.` };
  }
  const type = ctx.args.getString("type") ?? "member";

  if (type === "mapping") {
    const discordRoleId = ctx.args.getString("discord_role");
    const result = await deps.config.setRoleMapping(ctx.guildId, role, discordRoleId);
    if (!result.ok) return { ephemeral: true, text: E.command.adminFailed };
    return {
      ephemeral: true,
      text: discordRoleId ? `${role} now maps to <@&${discordRoleId}>.` : `${role} mapping cleared.`,
    };
  }

  const target = ctx.args.getUser("target");
  if (!target) return { ephemeral: true, text: "Usage: /set-role type:member target:<user> role:<rank>" };
  const result = await deps.community.setMemberRole(ctx.guildId, target, role);
  if (!result.ok) return { ephemeral: true, text: result.error.message };

  await deps.moderation.applyAction({
    guildId: ctx.guildId,
    type: "ROLE_CHANGE",
    actorDiscordId: ctx.actorId,
    targetDiscordId: target,
    reason: `Role set to ${role}`,
  });
  return { ephemeral: false, text: `<@${target}> is now ${role}.` };
};

// ── Applications ────────────────────────────────────────────────────────────

// ── The guild door, and the roster behind it ────────────────────────────────
//
// The counterpart to the bridge's auto-accept, and now the whole in-game
// membership surface: admit, refuse, invite, kick, mute, promote, demote.
//
// Two things shape this group. The first is that a join request is *live*: the
// applicant typed `/g join` and Hypixel will honour `/g accept` for five
// minutes, so these are not applications sitting in a tray. `/join-accept`
// therefore goes through `admit()`, which checks the clock and falls back to an
// invite once it has run out, rather than sending a command that would quietly
// fail upstream.
//
// The second is that everything here is MODERATOR by default. That is lower
// than the membership commands next door, deliberately: the value of these is
// that whoever is around can use them *now*, and a floor that waits for an
// officer is a floor that misses the window. Guilds that disagree raise it on
// the panel's Permissions card, which overrides every default in this file.

/** Shared by all of them: the bridge may simply not be wired into this process. */
function noBridge(): AdminReply {
  return {
    ephemeral: true,
    text: "In-game guild commands aren't available here — this bot has no bridge to send them through.",
  };
}

/**
 * The roster commands, which differ only in verb and argument.
 *
 * One factory rather than six handlers: the usage line, the missing-bridge
 * answer and the "sent, not necessarily obeyed" phrasing have to stay identical
 * across them, and six copies is six chances for a kick to report itself
 * differently from a mute.
 */
function rosterHandler(
  name: string,
  run: (queue: JoinQueueService, guildId: string, ign: string, actorId: string, extra: string) => Promise<JoinActionResult>,
  verb: string,
  extraOption?: { readonly option: string; readonly required: boolean },
): AdminHandler {
  return async (ctx, deps) => {
    if (!deps.joinQueue) return noBridge();
    const ign = ctx.args.getString("ign");
    const extra = (extraOption ? ctx.args.getString(extraOption.option) : null) ?? "";
    const usage = `Usage: /${name} ign:<name>${extraOption ? ` ${extraOption.option}:<value>` : ""}`;
    if (!ign) return { ephemeral: true, text: usage };
    if (extraOption?.required && extra === "") return { ephemeral: true, text: usage };

    const result = await run(deps.joinQueue, ctx.guildId, ign, ctx.actorId, extra);
    return { ephemeral: true, text: renderJoinAction(verb, result, extra) };
  };
}

const joinQueue: AdminHandler = async (ctx, deps) => {
  if (!deps.joinQueue) return noBridge();
  const rows = await deps.joinQueue.pending(ctx.guildId);
  return {
    ephemeral: true,
    text: rows.length === 0 ? "Nobody is waiting to join." : `${rows.length} waiting on a decision.`,
    embed: renderJoinQueueEmbed(rows),
  };
};

/**
 * Admit somebody, by whichever route is still open.
 *
 * Not shared with `/join-deny` any more, because the two stopped being mirror
 * images the moment the window mattered: denying a request that has already
 * expired changes nothing and reads the same either way, while accepting one
 * has to become an invite and say so.
 */
const joinAccept: AdminHandler = async (ctx, deps) => {
  if (!deps.joinQueue) return noBridge();
  const ign = ctx.args.getString("ign");
  if (!ign) return { ephemeral: true, text: "Usage: /join-accept ign:<name>" };
  return { ephemeral: true, text: renderAdmit(await deps.joinQueue.admit(ctx.guildId, ign, ctx.actorId)) };
};

const joinDeny = rosterHandler("join-deny", (queue, g, ign, actor) => queue.deny(g, ign, actor), "deny");

/**
 * Suggest the names actually waiting.
 *
 * Typed by hand, a username is one transposed character away from a command
 * that either does nothing or admits somebody else entirely — and the queue is
 * exactly the list of names that are valid right now, so there is no reason to
 * make staff retype one off a report.
 */
const joinQueueNames: NonNullable<AdminCommandSpec["autocomplete"]> = async (focused, ctx, deps) => {
  if (!deps.joinQueue) return [];
  const rows = await deps.joinQueue.pending(ctx.guildId).catch(() => []);
  const needle = focused.value.toLowerCase();
  return rows
    .filter((r) => r.ign.toLowerCase().startsWith(needle))
    .slice(0, 25)
    .map((r) => ({ name: `${r.ign} — ${r.verdict.toLowerCase()}`.slice(0, 100), value: r.ign }));
};

const guildInvite = rosterHandler("guild-invite", (queue, g, ign, actor) => queue.invite(g, ign, actor), "invite");

const guildKick = rosterHandler(
  "guild-kick",
  (queue, g, ign, actor, extra) => queue.kick(g, ign, actor, extra),
  "kick",
  // Required, because Hypixel refuses `/g kick <name>` with nothing after it.
  // Left optional, the command read as accepted here and did nothing in game.
  { option: "reason", required: true },
);

const guildMute = rosterHandler(
  "guild-mute",
  (queue, g, ign, actor, extra) => queue.mute(g, ign, actor, extra),
  "mute",
  { option: "duration", required: true },
);

const guildUnmute = rosterHandler("guild-unmute", (queue, g, ign, actor) => queue.unmute(g, ign, actor), "unmute");

const guildPromote = rosterHandler("guild-promote", (queue, g, ign, actor) => queue.promote(g, ign, actor), "promote");

const guildDemote = rosterHandler("guild-demote", (queue, g, ign, actor) => queue.demote(g, ign, actor), "demote");


// ─────────────────────────────── Tickets ────────────────────────────────────

/**
 * Resolve what a staffer typed into a ticket.
 *
 * Two forms are accepted because staff use two: "#12" is what the channel
 * topic, the panel and every conversation call it, and the opaque row id is
 * what a log line or the autocomplete hands back. Numbers only resolve against
 * the open list — a closed ticket is found by id, which is the id the close
 * notice printed.
 */
async function findTicket(
  ctx: AdminContext,
  deps: AdminHandlerDeps,
  raw: string,
): Promise<TicketDTO | null> {
  const number = Number.parseInt(raw.replace(/^#/, ""), 10);
  if (Number.isInteger(number) && String(number) === raw.replace(/^#/, "")) {
    const open = await deps.community.listTickets(ctx.guildId);
    return (open.ok ? open.value.find((t) => t.number === number) : undefined) ?? null;
  }
  const found = await deps.community.getTicket(raw);
  const ticket = found.ok ? found.value : null;
  // Guild-checked here rather than trusted: a ticket id is opaque but guessable
  // in bulk, and nothing else in this path would stop one server's staff from
  // reading another's conversation.
  return ticket !== null && ticket.guildId === ctx.guildId ? ticket : null;
}

/**
 * `/tickets` — the staff view of the queue, and the two actions that need one.
 *
 * `list` and `view` read the database directly. `close` and `transcript` go
 * through the bridge bot, because closing has to dispose of a Discord channel
 * this process cannot see, and a transcript is rendered from the archive the
 * gateway writes.
 */
const tickets: AdminHandler = async (ctx, deps) => {
  const action = ctx.args.getString("action") ?? "list";
  const id = ctx.args.getString("id");

  if (action === "list") {
    const open = await deps.community.listTickets(ctx.guildId);
    if (!open.ok) return { ephemeral: true, text: E.generic.loadFailed };
    return {
      ephemeral: true,
      text: open.value.length === 0 ? "Nothing open." : `${String(open.value.length)} open.`,
      embed: renderTicketListEmbed(open.value),
    };
  }

  if (!id) return { ephemeral: true, text: `Usage: /tickets action:${action} id:<number>` };
  const ticket = await findTicket(ctx, deps, id);
  if (ticket === null) return { ephemeral: true, text: E.generic.notFound };

  if (action === "view") {
    return { ephemeral: true, text: `Ticket #${String(ticket.number)}.`, embed: renderTicketEmbed(ticket) };
  }

  if (action === "transcript") {
    if (!deps.ticketBridge) return noTicketBridge();
    const transcript = await deps.ticketBridge.transcript(ctx.guildId, ticket.id);
    if (transcript === null) return { ephemeral: true, text: E.generic.loadFailed };
    return {
      ephemeral: true,
      text: `Transcript for ticket #${String(ticket.number)}.`,
      file: transcript,
    };
  }

  if (action === "close") {
    if (!deps.ticketBridge) return noTicketBridge();
    const result = await deps.ticketBridge.close({
      guildId: ctx.guildId,
      ticketId: ticket.id,
      actorDiscordId: ctx.actorId,
      reason: ctx.args.getString("reason"),
    });
    return {
      ephemeral: true,
      text: result.ok ? `Closed ticket #${String(result.number)}.` : `I couldn't close that — ${result.detail}.`,
    };
  }

  return { ephemeral: true, text: "Pick list, view, close or transcript." };
};

/** The bridge owns the channel; without it, closing would only move the row. */
function noTicketBridge(): AdminReply {
  return {
    ephemeral: true,
    text: "Tickets aren't reachable from here — the bridge bot isn't running or isn't wired to this one.",
  };
}

/**
 * Suggest the tickets that are actually open.
 *
 * The value is the row id rather than the number, so a pick is unambiguous even
 * as new tickets take the next number — and the label is what staff would have
 * typed anyway.
 */
const ticketNames: NonNullable<AdminCommandSpec["autocomplete"]> = async (focused, ctx, deps) => {
  const open = await deps.community.listTickets(ctx.guildId);
  if (!open.ok) return [];
  const needle = focused.value.replace(/^#/, "").toLowerCase();
  return open.value
    .filter((t) => needle === "" || String(t.number).startsWith(needle))
    .slice(0, 25)
    .map((t) => ({
      name: `#${String(t.number)} — ${t.categoryName ?? "uncategorised"}`.slice(0, 100),
      value: t.id,
    }));
};

/**
 * `/rolemenu` — put a self-service role menu in a channel, or see what exists.
 *
 * The menus themselves are built on the panel; this is only the staff verb that
 * publishes one. The message and its buttons belong to the member-facing bot,
 * which is why every action here goes over the bridge rather than being posted
 * from this process: a menu posted by the staff bot would be a menu members are
 * asked to interact with from a bot that never speaks to them.
 */
const rolemenu: AdminHandler = async (ctx, deps) => {
  if (!deps.roleMenuBridge) return noRoleMenuBridge();
  const action = ctx.args.getString("action") ?? "list";

  if (action === "list") {
    const menus = await deps.roleMenuBridge.list(ctx.guildId);
    if (menus.length === 0) {
      return { ephemeral: true, text: "No role menus yet — build one on the panel, then post it here." };
    }
    const lines = menus.map((menu) => {
      const where = menu.channelId === null ? "not posted" : `<#${menu.channelId}>`;
      return `\`${menu.id}\` — ${menu.title} · ${String(menu.optionCount)} roles · ${where}`;
    });
    return { ephemeral: true, text: lines.join("\n").slice(0, 1900) };
  }

  if (action !== "post") return { ephemeral: true, text: "Pick list or post." };

  const id = ctx.args.getString("id");
  if (!id) return { ephemeral: true, text: "Usage: /rolemenu action:post id:<menu>" };

  // Defaults to here, like `/lockdown` and `/set-channel`: a staffer typing it
  // in the channel they want it in should not have to name that channel.
  const channelId = ctx.args.getChannel("channel") ?? ctx.channelId ?? null;
  const result = await deps.roleMenuBridge.publish(ctx.guildId, id, channelId);
  if (!result.ok) return { ephemeral: true, text: `I couldn't post that — ${result.detail}.` };
  return {
    ephemeral: true,
    text: result.edited ? `Updated **${id}** where it was already posted.` : `Posted **${id}**.`,
  };
};

/** The member-facing bot owns the message; without it, posting would do nothing. */
function noRoleMenuBridge(): AdminReply {
  return {
    ephemeral: true,
    text: "Role menus aren't reachable from here — the bridge bot isn't running or isn't wired to this one.",
  };
}

/**
 * `/sticky` — keep one message at the bottom of a channel.
 *
 * The configuration is guild settings this process owns outright; the message
 * is the member-facing bot's, which is why setting one is a local write plus a
 * request to that bot to put it in place. A staffer typing this in the channel
 * they mean should not have to name it, so the channel defaults to here.
 */
const sticky: AdminHandler = async (ctx, deps) => {
  if (!deps.stickyBridge) return noStickyBridge();
  const action = ctx.args.getString("action") ?? "list";

  if (action === "list") {
    const stickies = await deps.stickyBridge.list(ctx.guildId);
    if (stickies.length === 0) {
      return { ephemeral: true, text: "No sticky messages yet — try `/sticky action:set message:...` in a channel." };
    }
    const lines = stickies.map((entry) => {
      const state = entry.enabled ? "" : " · off";
      return `<#${entry.channelId}>${state} — ${firstLine(entry.content)}`;
    });
    return { ephemeral: true, text: lines.join("\n").slice(0, 1900) };
  }

  const channelId = ctx.args.getChannel("channel") ?? ctx.channelId ?? null;
  if (channelId === null) {
    return { ephemeral: true, text: E.surface.nameChannel };
  }

  if (action === "clear") {
    const result = await deps.stickyBridge.clear(ctx.guildId, channelId);
    if (!result.ok) return { ephemeral: true, text: `I couldn't clear that — ${result.detail}.` };
    return {
      ephemeral: true,
      text: result.applied
        ? `Cleared the sticky in <#${channelId}>.`
        : `Cleared the sticky in <#${channelId}>. The old message is still up — the bridge bot didn't answer.`,
    };
  }

  if (action !== "set") return { ephemeral: true, text: "Pick list, set or clear." };

  const message = (ctx.args.getString("message") ?? "").trim();
  if (message === "") return { ephemeral: true, text: "Usage: /sticky action:set message:<what it should say>" };

  const result = await deps.stickyBridge.set(ctx.guildId, channelId, message);
  if (!result.ok) return { ephemeral: true, text: `I couldn't save that — ${result.detail}.` };
  const what = result.created ? "Sticky set in" : "Updated the sticky in";
  return {
    ephemeral: true,
    text: result.applied
      ? `${what} <#${channelId}>.`
      : `${what} <#${channelId}>. It appears the next time somebody talks there — the bridge bot didn't answer.`,
  };
};

/** The member-facing bot owns the message; without it, this would save and never post. */
function noStickyBridge(): AdminReply {
  return {
    ephemeral: true,
    text: "Sticky messages aren't reachable from here — the bridge bot isn't running or isn't wired to this one.",
  };
}

/** Enough of a sticky to recognise it in a list, on one line. */
function firstLine(content: string): string {
  const line = content.split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/**
 * Menu ids, so nobody has to remember one. The label carries the title because
 * the id is a slug and the title is what staff called it.
 */
const roleMenuIds: NonNullable<AdminCommandSpec["autocomplete"]> = async (focused, ctx, deps) => {
  if (!deps.roleMenuBridge) return [];
  const needle = focused.value.toLowerCase();
  const menus = await deps.roleMenuBridge.list(ctx.guildId);
  return menus
    .filter((menu) => needle === "" || menu.id.includes(needle) || menu.title.toLowerCase().includes(needle))
    .slice(0, 25)
    .map((menu) => ({ name: `${menu.id} — ${menu.title}`.slice(0, 100), value: menu.id }));
};

const applicationReview: AdminHandler = async (ctx, deps) => {
  const id = ctx.args.getString("id");
  if (id) {
    const result = await deps.community.getApplication(id);
    if (!result.ok) return { ephemeral: true, text: E.generic.loadFailed };
    if (result.value === null) return { ephemeral: true, text: E.generic.notFound };
    return {
      ephemeral: true,
      text: `Application ${result.value.id} — ${result.value.status.toLowerCase()}.`,
      embed: renderApplicationEmbed(result.value),
    };
  }

  const list = await deps.community.listApplications(ctx.guildId);
  if (!list.ok) return { ephemeral: true, text: E.generic.loadFailed };
  return {
    ephemeral: true,
    text: list.value.length === 0 ? "Nothing waiting for review." : `${list.value.length} waiting for review.`,
    embed: renderApplicationListEmbed(list.value),
  };
};

/**
 * `/accept-member` and `/deny-member` differ only in the verdict, so they share
 * one implementation — the audit trail and the already-decided guard should not
 * be able to drift between accept and deny.
 */
function decideHandler(accept: boolean): AdminHandler {
  return async (ctx, deps) => {
    const id = ctx.args.getString("id");
    if (!id) return { ephemeral: true, text: "Which application? Pass `id:` — /application-review lists them." };
    const reason = ctx.args.getString("reason");

    const result = await deps.community.decideApplication({
      applicationId: id,
      reviewerDiscordId: ctx.actorId,
      accept,
      ...(reason === null ? {} : { reason }),
    });
    if (!result.ok) {
      return {
        ephemeral: true,
        text:
          result.error.kind === "NOT_FOUND"
            ? E.generic.notFound
            : `That application was already ${result.error.status.toLowerCase()}.`,
      };
    }

    const app = result.value;
    // Accepting promotes the applicant onto the roster. A missing member row is
    // reported rather than swallowed: the decision stands, but staff need to
    // know the rank wasn't applied.
    let note = "";
    if (accept) {
      const promoted = await deps.community.setMemberRole(ctx.guildId, app.applicantDiscordId, "MEMBER");
      if (!promoted.ok) note = " (they aren't on the roster yet, so no rank was set)";
    }

    return {
      ephemeral: false,
      text: `<@${app.applicantDiscordId}>'s application was ${accept ? "accepted" : "denied"}${note}.`,
      embed: renderApplicationEmbed(app),
    };
  };
}

const acceptMember = decideHandler(true);
const denyMember = decideHandler(false);

const bridgeSuspend: AdminHandler = async (ctx, deps) => {
  const result = await deps.config.setBridgeSuspended(ctx.guildId, true);
  if (!result.ok) return { ephemeral: true, text: E.command.adminFailed };
  return { ephemeral: false, text: "⏸️ Bridge relay suspended. Messages stop crossing until /bridge-unsuspend." };
};

const bridgeUnsuspend: AdminHandler = async (ctx, deps) => {
  const result = await deps.config.setBridgeSuspended(ctx.guildId, false);
  if (!result.ok) return { ephemeral: true, text: E.command.adminFailed };
  return { ephemeral: false, text: "▶️ Bridge relay resumed." };
};

// ── Registry ────────────────────────────────────────────────────────────────

const MOD_ACTION_CHOICES = (
  ["WARN", "MUTE", "UNMUTE", "KICK", "BAN", "UNBAN", "NOTE", "ROLE_CHANGE", "GUILD_EXPEL"] as const
).map((v) => ({ name: v, value: v }));

const ROLE_CHOICES = ROLES.map((r) => ({ name: r, value: r }));

export function buildAdminRegistry(): Map<string, AdminCommandSpec> {
  const specs: AdminCommandSpec[] = [
    {
      name: "warn",
      description: "Issue a formal warning",
      options: [
        { name: "target", description: "Member to warn", type: "user", required: true },
        { name: "reason", description: "Reason", type: "string" },
      ],
      minRole: "MODERATOR",
      handler: warn,
    },
    {
      name: "mute",
      description: "Mute a member across Discord + guild chat",
      options: [
        { name: "target", description: "Member", type: "user", required: true },
        { name: "duration", description: "e.g. 1h, 30m", type: "string", required: true },
        { name: "reason", description: "Reason", type: "string" },
      ],
      minRole: "MODERATOR",
      handler: mute,
    },
    {
      name: "unmute",
      description: "Lift a mute early, on Discord and in guild chat",
      options: [
        { name: "target", description: "Member", type: "user", required: true },
        { name: "reason", description: "Reason", type: "string" },
      ],
      minRole: "MODERATOR",
      handler: unmute,
    },
    {
      name: "ban",
      description: "Ban a member",
      options: [
        { name: "target", description: "Member", type: "user", required: true },
        { name: "reason", description: "Reason", type: "string" },
        { name: "duration", description: "Optional temp-ban duration", type: "string" },
        { name: "confirm", description: "Confirm this destructive action", type: "boolean" },
      ],
      minRole: "OFFICER",
      destructive: true,
      handler: ban,
    },
    {
      name: "unban",
      description: "Lift a ban",
      options: [
        { name: "target", description: "Member (user ID — they aren't here to pick)", type: "user", required: true },
        { name: "reason", description: "Reason", type: "string" },
      ],
      minRole: "OFFICER",
      handler: unban,
    },
    {
      name: "kick",
      description: "Remove a member from the server",
      options: [
        { name: "target", description: "Member", type: "user", required: true },
        { name: "reason", description: "Reason", type: "string" },
        { name: "confirm", description: "Confirm this destructive action", type: "boolean" },
      ],
      minRole: "MODERATOR",
      destructive: true,
      handler: kick,
    },
    {
      name: "purge",
      description: "Bulk-delete recent messages in a channel",
      options: [
        { name: "count", description: "How many messages (1-100)", type: "integer", required: true, minValue: 1, maxValue: 100 },
        { name: "user", description: "Only this member's messages", type: "user" },
        { name: "channel", description: "Channel (defaults to here)", type: "channel" },
        { name: "confirm", description: "Confirm this destructive action", type: "boolean" },
      ],
      minRole: "MODERATOR",
      destructive: true,
      handler: purge,
    },
    {
      name: "member-note",
      description: "Attach a private staff note to a member",
      options: [
        { name: "target", description: "Member", type: "user", required: true },
        { name: "note", description: "The note", type: "string", required: true },
      ],
      minRole: "MODERATOR",
      handler: memberNote,
    },
    {
      name: "infractions",
      description: "View a member's infraction history",
      options: [{ name: "target", description: "Member", type: "user", required: true }],
      minRole: "MODERATOR",
      handler: infractions,
    },
    {
      name: "audit",
      description: "Search the moderation log",
      options: [
        { name: "actor", description: "Filter by the staffer who acted", type: "user" },
        { name: "target", description: "Filter by the member acted on", type: "user" },
        { name: "type", description: "Filter by action type", type: "string", choices: MOD_ACTION_CHOICES },
        { name: "days", description: "Look back this many days", type: "integer", minValue: 1, maxValue: 365 },
        { name: "from", description: "Earliest date, YYYY-MM-DD", type: "string" },
        { name: "to", description: "Latest date, YYYY-MM-DD", type: "string" },
        {
          name: "in_force",
          description: "Only punishments still being enforced right now",
          type: "boolean",
        },
      ],
      minRole: "MODERATOR",
      handler: audit,
    },
    {
      name: "case",
      description: "Look up one moderation case by its id",
      options: [
        { name: "id", description: "The case id, e.g. act-1f3b", type: "string", required: true },
      ],
      minRole: "MODERATOR",
      handler: caseLookup,
    },
    {
      name: "lockdown",
      description: "Lock a channel or the whole server",
      options: [
        {
          name: "scope",
          description: "channel (default) or server",
          type: "string",
          choices: [
            { name: "channel", value: "channel" },
            { name: "server", value: "server" },
          ],
        },
        { name: "channel", description: "Channel to lock (defaults to here)", type: "channel" },
        { name: "reason", description: "Why", type: "string" },
        { name: "duration", description: "Auto-lift after e.g. 30m", type: "string" },
        { name: "confirm", description: "Confirm this destructive action", type: "boolean" },
      ],
      minRole: "OFFICER",
      destructive: true,
      handler: lockdown,
    },
    {
      name: "lockdown-lift",
      description: "End an active lockdown early",
      minRole: "OFFICER",
      handler: lockdownLift,
    },
    {
      name: "antiraid-on",
      description: "Raise join gating and message-rate limits",
      options: [
        {
          name: "sensitivity",
          description: "LOW, MEDIUM (default) or HIGH",
          type: "string",
          choices: [
            { name: "LOW", value: "LOW" },
            { name: "MEDIUM", value: "MEDIUM" },
            { name: "HIGH", value: "HIGH" },
          ],
        },
        { name: "duration", description: "Auto-disable after e.g. 1h", type: "string" },
      ],
      minRole: "OFFICER",
      handler: antiraidOn,
    },
    {
      name: "antiraid-off",
      description: "Return to normal join and rate limits",
      minRole: "OFFICER",
      handler: antiraidOff,
    },
    {
      name: "safety-status",
      description: "Show any active lockdown or anti-raid posture",
      minRole: "MODERATOR",
      handler: safetyStatus,
    },
    {
      name: "wordlist",
      description: "List the chat-filter rules",
      minRole: "MODERATOR",
      handler: wordlist,
    },
    {
      name: "wordlist-add",
      description: "Add a chat-filter rule",
      options: [
        { name: "pattern", description: "Word, phrase, wildcard or regex", type: "string", required: true },
        {
          name: "match_type",
          description: "How to match (default SUBSTRING)",
          type: "string",
          choices: [
            { name: "EXACT", value: "EXACT" },
            { name: "SUBSTRING", value: "SUBSTRING" },
            { name: "WILDCARD", value: "WILDCARD" },
            { name: "REGEX", value: "REGEX" },
          ],
        },
        {
          name: "action",
          description: "What to do on a match (default BLOCK)",
          type: "string",
          choices: [
            { name: "BLOCK", value: "BLOCK" },
            { name: "FLAG", value: "FLAG" },
            { name: "REPLACE", value: "REPLACE" },
            { name: "SHADOW_MUTE", value: "SHADOW_MUTE" },
          ],
        },
        { name: "severity", description: "1-5", type: "integer", minValue: 1, maxValue: 5 },
        { name: "note", description: "Why this rule exists", type: "string" },
      ],
      minRole: "OFFICER",
      handler: wordlistAdd,
    },
    {
      name: "wordlist-remove",
      description: "Remove a chat-filter rule",
      options: [
        { name: "rule", description: "Rule id or exact pattern", type: "string", required: true, autocomplete: true },
      ],
      minRole: "OFFICER",
      handler: wordlistRemove,
      // Officers remove rules by pattern far more often than by id, so offer
      // both and let them pick the one they recognise.
      autocomplete: async (focused, ctx, deps) => {
        const result = await deps.wordlist.list(ctx.guildId);
        if (!result.ok) return [];
        const needle = focused.value.toLowerCase();
        return result.value
          .filter((r) => r.pattern.toLowerCase().includes(needle) || r.id.startsWith(focused.value))
          .slice(0, 25)
          .map((r) => ({ name: `${r.pattern} (${r.matchType} → ${r.action})`.slice(0, 100), value: r.id }));
      },
    },
    {
      name: "filter-test",
      description: "Check what the filter would do to a message",
      options: [{ name: "text", description: "Message to test", type: "string", required: true }],
      minRole: "MODERATOR",
      handler: filterTest,
    },
    {
      name: "set-channel",
      description: "Bind one of the platform's channels",
      options: [
        {
          name: "slot",
          description: "Which channel role to set",
          type: "string",
          required: true,
          choices: CHANNEL_SLOTS.map((s) => ({ name: s, value: s })),
        },
        { name: "channel", description: "Leave empty to clear the slot", type: "channel" },
      ],
      minRole: "ADMIN",
      handler: setChannel,
    },
    {
      name: "feature-toggle",
      description: "Turn a named feature on or off",
      options: [
        { name: "feature", description: "Feature key", type: "string", required: true },
        { name: "enabled", description: "On or off", type: "boolean", required: true },
      ],
      minRole: "ADMIN",
      handler: featureToggle,
    },
    {
      name: "set-recruitment",
      description: "Open or close applications",
      options: [{ name: "open", description: "Accept applications?", type: "boolean", required: true }],
      minRole: "OFFICER",
      handler: setRecruitment,
    },
    {
      name: "set-role",
      description: "Change a member's rank, or bind a rank to a Discord role",
      options: [
        {
          name: "role",
          description: "Platform rank",
          type: "string",
          required: true,
          choices: ROLE_CHOICES,
        },
        {
          name: "type",
          description: "member (default) or mapping",
          type: "string",
          choices: [
            { name: "member", value: "member" },
            { name: "mapping", value: "mapping" },
          ],
        },
        { name: "target", description: "Member (type:member)", type: "user" },
        { name: "discord_role", description: "Discord role id (type:mapping); empty clears it", type: "string" },
      ],
      minRole: "ADMIN",
      handler: setRole,
    },
    {
      name: "application-review",
      description: "List applications awaiting review, or open one by id",
      options: [{ name: "id", description: "Application id (omit to list)", type: "string" }],
      minRole: "OFFICER",
      handler: applicationReview,
    },
    {
      name: "accept-member",
      description: "Accept an application and add the applicant to the roster",
      options: [
        { name: "id", description: "Application id", type: "string", required: true },
        { name: "reason", description: "Note for the audit trail", type: "string" },
      ],
      minRole: "OFFICER",
      handler: acceptMember,
    },
    {
      name: "deny-member",
      description: "Reject an application",
      options: [
        { name: "id", description: "Application id", type: "string", required: true },
        { name: "reason", description: "Why it was rejected", type: "string" },
      ],
      minRole: "OFFICER",
      handler: denyMember,
    },
    {
      name: "tickets",
      description: "Look at the ticket queue, and close or export one",
      options: [
        {
          name: "action",
          description: "What to do",
          type: "string",
          choices: [
            { name: "list", value: "list" },
            { name: "view", value: "view" },
            { name: "close", value: "close" },
            { name: "transcript", value: "transcript" },
          ],
        },
        { name: "id", description: "Ticket number or id", type: "string", autocomplete: true },
        { name: "reason", description: "Why it is being closed", type: "string" },
      ],
      minRole: "MODERATOR",
      handler: tickets,
      autocomplete: ticketNames,
    },
    {
      name: "rolemenu",
      description: "Post a self-service role menu, or list the ones this server has",
      options: [
        {
          name: "action",
          description: "What to do",
          type: "string",
          choices: [
            { name: "list", value: "list" },
            { name: "post", value: "post" },
          ],
        },
        { name: "id", description: "Which menu", type: "string", autocomplete: true },
        { name: "channel", description: "Where to post it (defaults to here)", type: "channel" },
      ],
      minRole: "OFFICER",
      handler: rolemenu,
      autocomplete: roleMenuIds,
    },
    {
      name: "sticky",
      description: "Keep a message at the bottom of a channel",
      options: [
        {
          name: "action",
          description: "What to do",
          type: "string",
          choices: [
            { name: "list", value: "list" },
            { name: "set", value: "set" },
            { name: "clear", value: "clear" },
          ],
        },
        { name: "message", description: "What it should say", type: "string" },
        { name: "channel", description: "Which channel (defaults to here)", type: "channel" },
      ],
      minRole: "OFFICER",
      handler: sticky,
    },
    {
      name: "join-queue",
      description: "Live in-game join requests and how long is left to answer them",
      minRole: "MODERATOR",
      handler: joinQueue,
    },
    {
      name: "join-accept",
      description: "Admit somebody who asked to join in-game",
      options: [{ name: "ign", description: "Minecraft username", type: "string", required: true, autocomplete: true }],
      minRole: "MODERATOR",
      handler: joinAccept,
      autocomplete: joinQueueNames,
    },
    {
      name: "join-deny",
      description: "Refuse an in-game join request",
      options: [{ name: "ign", description: "Minecraft username", type: "string", required: true, autocomplete: true }],
      minRole: "MODERATOR",
      handler: joinDeny,
      autocomplete: joinQueueNames,
    },
    {
      name: "guild-invite",
      description: "Invite a player who hasn't asked to join",
      options: [{ name: "ign", description: "Minecraft username", type: "string", required: true }],
      minRole: "MODERATOR",
      handler: guildInvite,
    },
    {
      name: "guild-kick",
      description: "Remove a member from the in-game guild",
      options: [
        { name: "ign", description: "Minecraft username", type: "string", required: true },
        {
          name: "reason",
          description: "Shown in-game; letters, numbers and basic punctuation",
          type: "string",
          required: true,
        },
      ],
      minRole: "MODERATOR",
      handler: guildKick,
    },
    {
      name: "guild-mute",
      description: "Silence a member in guild chat",
      options: [
        { name: "ign", description: "Minecraft username", type: "string", required: true },
        { name: "duration", description: "How long, e.g. 30m, 12h, 7d", type: "string", required: true },
      ],
      minRole: "MODERATOR",
      handler: guildMute,
    },
    {
      name: "guild-unmute",
      description: "Let a muted member speak in guild chat again",
      options: [{ name: "ign", description: "Minecraft username", type: "string", required: true }],
      minRole: "MODERATOR",
      handler: guildUnmute,
    },
    {
      name: "guild-promote",
      description: "Raise a member one in-game guild rank",
      options: [{ name: "ign", description: "Minecraft username", type: "string", required: true }],
      minRole: "MODERATOR",
      handler: guildPromote,
    },
    {
      name: "guild-demote",
      description: "Lower a member one in-game guild rank",
      options: [{ name: "ign", description: "Minecraft username", type: "string", required: true }],
      minRole: "MODERATOR",
      handler: guildDemote,
    },
    {
      name: "bridge-suspend",
      description: "Stop relaying between Discord and guild chat",
      minRole: "OFFICER",
      handler: bridgeSuspend,
    },
    {
      name: "bridge-unsuspend",
      description: "Resume relaying between Discord and guild chat",
      minRole: "OFFICER",
      handler: bridgeUnsuspend,
    },
  ];
  // See the note on the bridge registry: the literals above are the fallback and
  // `withCommandCopy` supplies the resolved wording.
  return withCommandCopy(new Map(specs.map((s) => [s.name, s])));
}
