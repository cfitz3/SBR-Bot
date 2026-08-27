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
import { withCommandCopy } from "@sbr/brand";
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
  renderAuditPages,
  renderEffectError,
  renderEnforcement,
  renderFilterTestEmbed,
  renderInfractionPages,
  renderJoinAction,
  renderJoinQueueEmbed,
  renderSafetyError,
  renderSafetyStatusEmbed,
  renderWordlistEmbed,
} from "./render.js";
import {
  renderNoteEmbed,
  renderRoleMenuControls,
  renderRoleMenuEmbed,
  renderStaffTicketEmbed,
  renderStickyControls,
  renderStickyEmbed,
  renderTicketControls,
  renderTicketQueueEmbed,
  trimTicketReason,
  type RoleMenuPrompt,
  type StickyPrompt,
  type TicketPrompt,
} from "./utilities.js";

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
  if (!channelId) return { ephemeral: true, text: "I couldn't tell which channel to purge." };

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
/**
 * `/note` — a private staff note, recorded but never enforced.
 *
 * It was `/member-note`. Staff say "note", the compound name only ever cost a
 * keystroke and a moment's recall, and there is nothing else the word could mean
 * on a staff bot. The reply is the note itself rather than a sentence about it,
 * so the thing worth checking — did I write what I meant to write — is on screen
 * instead of a case id in parentheses.
 */
const note: AdminHandler = async (ctx, deps) => {
  const target = ctx.args.getUser("target");
  const text = ctx.args.getString("note");
  if (!target || !text) return { ephemeral: true, text: "Name a member and give the note." };

  const result = await deps.moderation.applyAction({
    guildId: ctx.guildId,
    type: "NOTE",
    actorDiscordId: ctx.actorId,
    targetDiscordId: target,
    reason: text,
  });
  if (!result.ok) return { ephemeral: true, text: renderModError(result.error) };
  return {
    ephemeral: true,
    text: `Noted against <@${target}>.`,
    embed: renderNoteEmbed(result.value),
  };
};

const infractions: AdminHandler = async (ctx, deps) => {
  const target = ctx.args.getUser("target");
  if (!target) return { ephemeral: true, text: "Usage: /infractions target:<user>" };
  const result = await deps.moderation.listInfractions(ctx.guildId, target);
  if (!result.ok) return { ephemeral: true, text: "Couldn't load infractions." };
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

const audit: AdminHandler = async (ctx, deps) => {
  const inForceOnly = ctx.args.getBoolean("in_force") ?? false;
  const result = await deps.moderation.listActions({
    guildId: ctx.guildId,
    actorDiscordId: ctx.args.getUser("actor"),
    targetDiscordId: ctx.args.getUser("target"),
    type: (ctx.args.getString("type") as ModActionType | null) ?? null,
    sinceDays: ctx.args.getNumber("days"),
    inForceOnly,
    limit: AUDIT_PAGE_LIMIT + 1,
  });
  if (!result.ok) return { ephemeral: true, text: "Couldn't load the audit log." };
  if (result.value.length === 0) {
    return {
      ephemeral: true,
      text: inForceOnly
        ? "Nothing is being enforced right now."
        : "No moderation actions match those filters.",
    };
  }

  const truncated = result.value.length > AUDIT_PAGE_LIMIT;
  const rows = truncated ? result.value.slice(0, AUDIT_PAGE_LIMIT) : result.value;
  const count = truncated ? `${rows.length}+ action(s)` : `${rows.length} action(s)`;
  return {
    ephemeral: true,
    text: inForceOnly ? `${count} still in force.` : `${count}.`,
    ...paged(renderAuditPages(rows, { truncated })),
  };
};

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
  if (!result.ok) return { ephemeral: true, text: "Couldn't load that case." };
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
  if (!result.ok) return { ephemeral: true, text: "Couldn't lift the lockdown." };
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
  if (!result.ok) return { ephemeral: true, text: "Couldn't read the safety status." };
  return { ephemeral: true, text: "Safety status", embed: renderSafetyStatusEmbed(result.value) };
};

// ── Chat filter ─────────────────────────────────────────────────────────────

const wordlist: AdminHandler = async (ctx, deps) => {
  const result = await deps.wordlist.list(ctx.guildId);
  if (!result.ok) return { ephemeral: true, text: "Couldn't load the wordlist." };
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
  if (!result.ok) return { ephemeral: true, text: "Couldn't remove that rule." };
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
  if (!result.ok) return { ephemeral: true, text: "Couldn't run the filter." };
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
  if (!result.ok) return { ephemeral: true, text: "Couldn't save that channel." };
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
  if (!result.ok) return { ephemeral: true, text: "Couldn't save that flag." };
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
  if (!result.ok) return { ephemeral: true, text: "Couldn't save the recruitment settings." };

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
    if (!result.ok) return { ephemeral: true, text: "Couldn't save that mapping." };
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
 * `/tickets` — the queue, and the two actions that need one ticket.
 *
 * `action:` is gone from the command and lives on the card. Typing `/tickets`
 * shows what is open with a picker under it; naming an id opens that one with
 * its verbs attached. The verbs are attached only when they apply — *Close* is
 * absent on a closed ticket and *Transcript* is absent until the archive exists,
 * which is a better answer than a button that exists to tell you it cannot work.
 *
 * `reason` stays an option, and rides in the close button's custom id, so
 * closing with a recorded reason is still one interaction and not two.
 */
const tickets: AdminHandler = async (ctx, deps) => {
  const action = ctx.args.getString("action") ?? "show";
  const raw = ctx.args.getString("id");
  const reason = trimTicketReason(ctx.args.getString("reason"));

  const open = await deps.community.listTickets(ctx.guildId);
  if (!open.ok) return { ephemeral: true, text: "Couldn't read the ticket queue. Try /health." };

  /** The queue, plus whichever ticket is in focus if it has already left it. */
  const withFocus = (ticket: TicketDTO | null): readonly TicketDTO[] =>
    ticket === null || open.value.some((t) => t.id === ticket.id) ? open.value : [...open.value, ticket];

  const queue = (notice?: string): AdminReply => {
    const prompt: TicketPrompt = { ticketId: null, reason, ...(notice === undefined ? {} : { notice }) };
    return {
      ephemeral: true,
      text: open.value.length === 0 ? "Nothing open." : `${String(open.value.length)} open.`,
      embed: renderTicketQueueEmbed(open.value, prompt),
      components: renderTicketControls(open.value, prompt),
    };
  };

  if (!raw) return queue();

  const ticket = await findTicket(ctx, deps, raw);
  if (ticket === null) return { ephemeral: true, text: "I couldn't find that ticket." };

  const show = (notice?: string): AdminReply => {
    const prompt: TicketPrompt = {
      ticketId: ticket.id,
      reason,
      ...(notice === undefined ? {} : { notice }),
    };
    return {
      ephemeral: true,
      text: `Ticket #${String(ticket.number)}.`,
      embed: renderStaffTicketEmbed(ticket, prompt),
      components: renderTicketControls(withFocus(ticket), prompt),
    };
  };

  if (action === "transcript") {
    if (!deps.ticketBridge) return noTicketBridge();
    const transcript = await deps.ticketBridge.transcript(ctx.guildId, ticket.id);
    if (transcript === null) return { ephemeral: true, text: "I couldn't render that transcript. Try /health." };
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
      reason: reason === "" ? null : reason,
    });
    if (!result.ok) return { ephemeral: true, text: `I couldn't close that — ${result.detail}.` };
    // Re-read rather than echo: the close disposes of a channel and stamps the
    // row, and a card built from the pre-close copy would show it still open.
    const after = await deps.community.getTicket(ticket.id);
    const closed = after.ok ? after.value : null;
    if (closed === null) return { ephemeral: true, text: `Closed ticket #${String(result.number)}.` };
    const prompt: TicketPrompt = { ticketId: closed.id, reason: "", notice: "Closed." };
    return {
      ephemeral: true,
      text: `Closed ticket #${String(result.number)}.`,
      embed: renderStaffTicketEmbed(closed, prompt),
      components: renderTicketControls(withFocus(closed), prompt),
    };
  }

  return show();
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
 *
 * The list used to print raw ids in backticks because the next step required
 * typing one. It no longer does — picking from the menu is the next step — so
 * the ids stop being the most prominent thing on a card about role menus.
 */
const rolemenu: AdminHandler = async (ctx, deps) => {
  if (!deps.roleMenuBridge) return noRoleMenuBridge();
  const action = ctx.args.getString("action") ?? "show";
  const id = ctx.args.getString("id");
  // Defaults to here, like `/lockdown` and `/set-channel`: a staffer typing it
  // in the channel they want it in should not have to name that channel. The
  // button says which channel that is, so the default is no longer invisible.
  const channelId = ctx.args.getChannel("channel") ?? ctx.channelId ?? null;

  const menus = await deps.roleMenuBridge.list(ctx.guildId);

  const view = (menuId: string | null, notice?: string): AdminReply => {
    const prompt: RoleMenuPrompt = {
      menuId,
      channelId,
      ...(notice === undefined ? {} : { notice }),
    };
    return {
      ephemeral: true,
      text: notice ?? (menus.length === 0 ? "No role menus yet." : `${String(menus.length)} built.`),
      embed: renderRoleMenuEmbed(menus, prompt),
      components: renderRoleMenuControls(menus, prompt),
    };
  };

  if (action !== "post") return view(id);

  if (!id) return view(null, "Pick which menu to post.");
  const result = await deps.roleMenuBridge.publish(ctx.guildId, id, channelId);
  if (!result.ok) return { ephemeral: true, text: `I couldn't post that — ${result.detail}.` };
  // Re-read: publishing stamps the menu with where it landed, and the card's
  // "Posted in" line is the only confirmation of the channel that was implied.
  const after = await deps.roleMenuBridge.list(ctx.guildId);
  const prompt: RoleMenuPrompt = {
    menuId: id,
    channelId,
    notice: result.edited ? `Updated it in <#${String(channelId)}>.` : `Posted in <#${String(channelId)}>.`,
  };
  return {
    ephemeral: true,
    text: result.edited ? "Updated where it was already posted." : "Posted.",
    embed: renderRoleMenuEmbed(after, prompt),
    components: renderRoleMenuControls(after, prompt),
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
 * they mean should not have to name it, so a set defaults to here.
 *
 * The verb is inferred rather than typed: a message means set, no message means
 * show, and clearing is a button on the card of the sticky being cleared. That
 * removes the two ways the old shape could waste a round trip — `action:set`
 * with no message, and `action:clear` against a channel with nothing in it,
 * which used to answer with a success message about removing nothing.
 */
const sticky: AdminHandler = async (ctx, deps) => {
  if (!deps.stickyBridge) return noStickyBridge();
  const message = (ctx.args.getString("message") ?? "").trim();
  // Only an explicitly named channel focuses the card. Falling back to "here"
  // for a bare `/sticky` would answer a question about the server with a card
  // about one channel, usually the staff room it was typed in.
  const named = ctx.args.getChannel("channel");
  const action = ctx.args.getString("action") ?? (message === "" ? "show" : "set");

  const view = async (channelId: string | null, notice?: string): Promise<AdminReply> => {
    const stickies = await deps.stickyBridge!.list(ctx.guildId);
    const prompt: StickyPrompt = { channelId, ...(notice === undefined ? {} : { notice }) };
    return {
      ephemeral: true,
      text: notice ?? (stickies.length === 0 ? "None set." : `${String(stickies.length)} set.`),
      embed: renderStickyEmbed(stickies, prompt),
      components: renderStickyControls(stickies, prompt),
    };
  };

  if (action === "show") return view(named);

  const channelId = named ?? ctx.channelId ?? null;
  if (channelId === null) {
    return { ephemeral: true, text: "Name a channel — I can't tell where you typed this." };
  }

  if (action === "clear") {
    const result = await deps.stickyBridge.clear(ctx.guildId, channelId);
    if (!result.ok) return { ephemeral: true, text: `I couldn't clear that — ${result.detail}.` };
    // Land on the overview: the channel being cleared no longer has a card.
    return view(
      null,
      result.applied
        ? `Cleared the sticky in <#${channelId}>.`
        : `Cleared the sticky in <#${channelId}>. The old message is still up — I couldn't reach the bridge bot to take it down. Try /health.`,
    );
  }

  if (message === "") {
    return { ephemeral: true, text: "Give the message it should repeat." };
  }

  const result = await deps.stickyBridge.set(ctx.guildId, channelId, message);
  if (!result.ok) return { ephemeral: true, text: `I couldn't save that — ${result.detail}.` };
  const what = result.created ? "Sticky set in" : "Updated the sticky in";
  return view(
    channelId,
    result.applied
      ? `${what} <#${channelId}>.`
      : `${what} <#${channelId}>. It'll appear the next time somebody talks there — I couldn't reach the bridge bot to post it now. Try /health.`,
  );
};

/** The member-facing bot owns the message; without it, this would save and never post. */
function noStickyBridge(): AdminReply {
  return {
    ephemeral: true,
    text: "Sticky messages aren't reachable from here — the bridge bot isn't running or isn't wired to this one.",
  };
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
    if (!result.ok) return { ephemeral: true, text: "Couldn't load that application." };
    if (result.value === null) return { ephemeral: true, text: "I couldn't find an application with that id." };
    return {
      ephemeral: true,
      text: `Application ${result.value.id} — ${result.value.status.toLowerCase()}.`,
      embed: renderApplicationEmbed(result.value),
    };
  }

  const list = await deps.community.listApplications(ctx.guildId);
  if (!list.ok) return { ephemeral: true, text: "Couldn't load applications." };
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
            ? "I couldn't find an application with that id."
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
  if (!result.ok) return { ephemeral: true, text: "Couldn't suspend the bridge." };
  return { ephemeral: false, text: "⏸️ Bridge relay suspended. Messages stop crossing until /bridge-unsuspend." };
};

const bridgeUnsuspend: AdminHandler = async (ctx, deps) => {
  const result = await deps.config.setBridgeSuspended(ctx.guildId, false);
  if (!result.ok) return { ephemeral: true, text: "Couldn't resume the bridge." };
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
      name: "note",
      description: "Attach a private staff note to a member",
      options: [
        { name: "target", description: "Member", type: "user", required: true },
        { name: "note", description: "The note", type: "string", required: true },
      ],
      minRole: "MODERATOR",
      handler: note,
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
