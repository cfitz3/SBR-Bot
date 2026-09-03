/**
 * The anti-raid posture, actually applied to arriving members.
 *
 * `packages/moderation/src/antiraid.ts` decides; this attaches that decision to
 * the gateway. Until this file existed, `/antiraid on` wrote a sensitivity into
 * Redis that nothing read: the posture was reported by `/safety`, expired by
 * the sweep, and gated nobody.
 *
 * It lives in the admin bot because this is the process that already holds
 * `GuildMembers` and already observes joins, and because everything it does on
 * a decision is a privileged write — the ownership split says those happen
 * here, never in the member-facing bot.
 *
 * Removal goes through `ModerationService.applyAction` rather than
 * `member.kick()`, so a raider turned away is a case in the audit log with an
 * actor and a reason, reversible like any other. A gate that kicked directly
 * would be a hundred removals with no record of why, discovered the next
 * morning.
 */
import { Events, type Client, type GuildMember } from "discord.js";
import type { Logger } from "@sbr/observability";
import { evaluateJoin, type AntiRaidRules, type JoinDecision } from "@sbr/moderation";

/** The actor recorded on a case the gate opened. */
export const RAID_GATE_ACTOR = "system:antiraid";

/**
 * How many joins have happened lately, per guild.
 *
 * In-process and in-memory, deliberately. A raid is measured in seconds and the
 * admin bot is the one process holding the members intent, so a per-process
 * window is the same window; putting it in Redis would add a round trip to the
 * hot path of exactly the event it exists to survive. The cost is that two
 * admin-bot instances would each count half a raid and so each need twice as
 * long to trip — worth stating, and the reason `burst.joins` is a guild's
 * number to tune rather than a constant.
 */
export class JoinWindow {
  private readonly times = new Map<string, number[]>();

  /** Record a join and report how many are inside the window, this one included. */
  record(guildId: string, windowSeconds: number, at: number): number {
    const cutoff = at - windowSeconds * 1000;
    const kept = (this.times.get(guildId) ?? []).filter((t) => t > cutoff);
    kept.push(at);
    this.times.set(guildId, kept);
    return kept.length;
  }

  /** Drop guilds nobody has joined lately, so a long-lived process does not grow. */
  prune(windowSeconds: number, at: number): void {
    const cutoff = at - windowSeconds * 1000;
    for (const [guildId, times] of this.times) {
      const kept = times.filter((t) => t > cutoff);
      if (kept.length === 0) this.times.delete(guildId);
      else this.times.set(guildId, kept);
    }
  }
}

export interface RaidGateDeps {
  /** Discord guild id → this platform's guild id, or null if unmapped. */
  resolveGuild(discordGuildId: string): Promise<string | null>;
  /** The guild's stored rules, already parsed with defaults underneath. */
  rules(guildId: string): Promise<AntiRaidRules>;
  /** Is the posture on right now — however it got there. */
  postureActive(guildId: string): Promise<boolean>;
  /**
   * Turn the posture on because a burst tripped it.
   *
   * Routed through the safety service rather than set here, so an automatic
   * engage produces the same state, the same expiry and the same `/safety`
   * reading as a human typing `/antiraid on`. Two ways to switch on that wrote
   * different state is how the sweep ends up unable to lift one of them.
   */
  engage(guildId: string, rules: AntiRaidRules): Promise<void>;
  /** Kick or ban, through the moderation service so it becomes a case. */
  punish(input: {
    guildId: string;
    discordId: string;
    action: "KICK" | "BAN";
    reason: string;
  }): Promise<void>;
  /** Tell staff. The only thing a `FLAG` does, and it does it every time. */
  flag(input: { guildId: string; discordId: string; reasons: readonly string[] }): Promise<void>;
  readonly logger: Logger;
  now?: () => number;
}

/** Hours since the member's account was created. */
export function accountAgeHours(member: GuildMember, now: number): number {
  const created = member.user.createdTimestamp;
  return Math.max(0, (now - created) / 3_600_000);
}

export function attachRaidGate(client: Client, deps: RaidGateDeps): void {
  const window = new JoinWindow();
  const now = deps.now ?? (() => Date.now());

  const gate = async (member: GuildMember): Promise<void> => {
    // A bot join is an administrator's action, not a member's, and the gate
    // reads as a member gate throughout: an integration added minutes ago has
    // no account age to speak of and frequently no avatar, so every heuristic
    // here fires on it at once. Skipped before the window is touched, so a
    // staffer wiring up three integrations cannot trip the burst threshold and
    // put the guild into a posture aimed at people. Whether a bot may be added
    // at all is Discord's own Manage Server permission; this is not the place
    // to second-guess it, and a `joinAction` of KICK or BAN reaching one would
    // undo a staff decision and open a moderation case against a webhook.
    if (member.user.bot) return;

    const guildId = await deps.resolveGuild(member.guild.id);
    if (guildId === null) return;

    const rules = await deps.rules(guildId);
    // Off means off, before anything is counted: a guild that has switched
    // anti-raid off should not be paying for a window it will never read.
    if (!rules.enabled) return;

    const at = now();
    const joinsInWindow = window.record(guildId, rules.burst.windowSeconds, at);
    const active = await deps.postureActive(guildId);

    const decision: JoinDecision = evaluateJoin(rules, {
      accountAgeHours: accountAgeHours(member, at),
      // `avatar` is the member's own upload; `displayAvatarURL` would count
      // Discord's generated default and make the rule match nobody.
      hasAvatar: member.user.avatar !== null,
      joinsInWindow,
      postureActive: active,
    });

    // Engage first. The member who tripped the burst is judged by the posture
    // they triggered — which `evaluateJoin` has already done — so the state has
    // to catch up before anyone acts on that decision.
    if (decision.engages) {
      await deps.engage(guildId, rules);
      deps.logger.warn("anti-raid engaged", { guildId, joinsInWindow });
    }

    if (decision.action === "ALLOW") return;

    const reason = `Anti-raid: ${decision.reasons.join("; ")}`;
    if (decision.action === "FLAG") {
      await deps.flag({ guildId, discordId: member.id, reasons: decision.reasons });
      return;
    }
    await deps.punish({ guildId, discordId: member.id, action: decision.action, reason });
    window.prune(rules.burst.windowSeconds, at);
  };

  client.on(Events.GuildMemberAdd, (member) => {
    void gate(member).catch((error: unknown) => {
      // Warn and let them in. A gate that throws must fail open: the failure
      // mode of failing closed is a server that silently stops admitting
      // anybody because one Redis read timed out.
      deps.logger.warn("raid gate did not run", { discordId: member.id, error: String(error) });
    });
  });
}
