/**
 * Watches for punishments carried out in Discord's own interface, and adopts
 * them into the platform.
 *
 * Staff right-click and ban. They always have, and a platform that only records
 * what was typed into one of its own surfaces will always disagree with the
 * server it claims to describe: no case, no mod-log card, nothing in `/audit`,
 * and — the half that actually costs something — no guild-chat kick, so the
 * person carries on playing in a Minecraft guild they were just thrown out of
 * the Discord for.
 *
 * This is the mirror the in-game path already had, pointing the other way.
 *
 * Three events, and one of them is not really an event at all:
 *
 * - **Bans and unbans** arrive as `GuildBanAdd` / `GuildBanRemove`, which are
 *   unambiguous — the state changed, and the audit log is only consulted for
 *   *who* and *why*.
 * - **Kicks** have no event. Discord reports a kick as an ordinary
 *   `GuildMemberRemove`, identical to somebody leaving of their own accord, and
 *   the only thing that tells the two apart is a `MemberKick` entry appearing
 *   in the audit log at about the same moment. That is a race by construction,
 *   so it is treated as one: a short delay, a bounded search, a strict window,
 *   and a bias toward doing nothing.
 *
 * The bias matters more than the coverage. A missed kick is a case staff can
 * add by hand; a *wrongly* adopted one is a case saying a member was kicked by
 * a staffer who did nothing, and — with relay sync on — a real kick out of the
 * Minecraft guild for somebody who simply left the Discord. So every uncertain
 * branch here returns without recording.
 */
import { AuditLogEvent, Events, type Client, type Guild } from "discord.js";
import { DISCORD_ACTOR } from "@sbr/moderation";
import type { Logger } from "@sbr/observability";

/**
 * How long to wait before looking for the audit-log entry that explains a
 * departure.
 *
 * Discord writes the entry asynchronously and the gateway event routinely wins
 * the race. Without the wait, a genuine kick reads as a voluntary leave — which
 * is the failure that makes this whole path pointless.
 */
export const AUDIT_SETTLE_MS = 2_000;

/**
 * How recent an audit-log entry must be to explain the departure in hand.
 *
 * Generous enough to survive the settle delay and a slow gateway, tight enough
 * that yesterday's kick of the same person — someone who was kicked, rejoined
 * and has now left on their own — cannot be adopted a second time.
 */
const AUDIT_WINDOW_MS = 15_000;

/** Entries scanned per departure. The one we want is at the head or nowhere. */
const AUDIT_LIMIT = 8;

export interface DiscordModObserverDeps {
  /** Discord guild id → this platform's guild id, or null if unmapped. */
  resolveGuild(discordGuildId: string): Promise<string | null>;
  /**
   * Adopt the action. Implemented by `ModerationService.recordDiscordAction`,
   * which writes the case, mirrors it, posts the mod-log card and carries out
   * the guild-chat half.
   */
  record(input: {
    readonly guildId: string;
    readonly type: "BAN" | "UNBAN" | "KICK";
    readonly targetDiscordId: string;
    readonly actorDiscordId: string;
    readonly reason: string;
  }): Promise<void>;
  readonly logger: Logger;
  /** Overridable so a test does not have to wait two real seconds. */
  readonly settleMs?: number;
}

/** The audit log, reduced to the two facts a case needs. */
interface Attribution {
  readonly actorDiscordId: string | null;
  readonly reason: string | null;
}

/** A reason column is not a free-text field; a novel in it helps nobody. */
function trimReason(raw: string | null): string | null {
  const text = raw?.replace(/\s+/g, " ").trim() ?? "";
  return text === "" ? null : text.slice(0, 400);
}

export function attachDiscordModObserver(client: Client, deps: DiscordModObserverDeps): void {
  const log = deps.logger.child({ service: "discord-mod-observer" });

  /**
   * Who did it and why, from Discord's audit log.
   *
   * `null` is returned for "this was us" specifically, and it is the
   * load-bearing check in this file. Every ban the platform places goes through
   * the same REST call a staffer's right-click does, so `GuildBanAdd` fires for
   * our own enforcement too. Adopting that would write a second case for every
   * ban issued from the panel, each one duly posting its own mod-log card. The
   * executor being the bot itself is the only reliable way to tell them apart,
   * and it is exactly reliable: the platform has no other way to ban.
   */
  async function attribute(
    guild: Guild,
    type: AuditLogEvent,
    targetId: string,
  ): Promise<Attribution | null> {
    // Without View Audit Log there is no attribution to be had. A ban is still
    // adopted — it happened either way — with an unknown actor.
    const entries = await guild
      .fetchAuditLogs({ type, limit: AUDIT_LIMIT })
      .then((logs) => [...logs.entries.values()])
      .catch((error: unknown) => {
        log.warn("could not read the audit log", {
          guildId: guild.id,
          error: error instanceof Error ? error.message : "unknown",
        });
        return null;
      });
    if (entries === null) return { actorDiscordId: null, reason: null };

    const cutoff = Date.now() - AUDIT_WINDOW_MS;
    const entry = entries.find((e) => e.targetId === targetId && e.createdTimestamp >= cutoff);
    if (!entry) return { actorDiscordId: null, reason: null };
    if (entry.executorId !== null && entry.executorId === client.user?.id) return null;

    return { actorDiscordId: entry.executorId, reason: trimReason(entry.reason) };
  }

  async function adopt(
    guild: Guild,
    type: "BAN" | "UNBAN",
    auditType: AuditLogEvent,
    targetDiscordId: string,
    fallbackReason: string,
  ): Promise<void> {
    const guildId = await deps.resolveGuild(guild.id);
    // A server this platform has never been told about is not an error; the bot
    // sits in servers that are not guilds here, and their moderation is theirs.
    if (guildId === null) return;

    const attribution = await attribute(guild, auditType, targetDiscordId);
    // Our own enforcement, already recorded by whoever asked for it.
    if (attribution === null) return;

    await deps.record({
      guildId,
      type,
      targetDiscordId,
      actorDiscordId: attribution.actorDiscordId ?? DISCORD_ACTOR,
      reason: attribution.reason ?? fallbackReason,
    });
  }

  client.on(Events.GuildBanAdd, (ban) => {
    void adopt(ban.guild, "BAN", AuditLogEvent.MemberBanAdd, ban.user.id, "Banned in Discord").catch(
      (error: unknown) => {
        log.error("could not adopt a Discord ban", { user: ban.user.id, error: String(error) });
      },
    );
  });

  client.on(Events.GuildBanRemove, (ban) => {
    void adopt(
      ban.guild,
      "UNBAN",
      AuditLogEvent.MemberBanRemove,
      ban.user.id,
      "Unbanned in Discord",
    ).catch((error: unknown) => {
      log.error("could not adopt a Discord unban", { user: ban.user.id, error: String(error) });
    });
  });

  client.on(Events.GuildMemberRemove, (member) => {
    // The only branch that guesses, so the only one that waits. Without the
    // pause the audit entry usually is not written yet, and every kick reads as
    // a resignation.
    const timer = setTimeout(() => {
      void (async () => {
        const guild = member.guild;
        const attribution = await attribute(guild, AuditLogEvent.MemberKick, member.id);
        // Our own kick, or nobody's. A member who left of their own accord is
        // not a moderation action, and an entry with no executor is not enough
        // to say one happened.
        if (attribution === null || attribution.actorDiscordId === null) return;

        const guildId = await deps.resolveGuild(guild.id);
        if (guildId === null) return;

        await deps.record({
          guildId,
          type: "KICK",
          targetDiscordId: member.id,
          actorDiscordId: attribution.actorDiscordId,
          reason: attribution.reason ?? "Kicked in Discord",
        });
      })().catch((error: unknown) => {
        log.error("could not adopt a Discord kick", { user: member.id, error: String(error) });
      });
    }, deps.settleMs ?? AUDIT_SETTLE_MS);
    // Nothing here is worth holding the process open at shutdown.
    timer.unref();
  });
}
