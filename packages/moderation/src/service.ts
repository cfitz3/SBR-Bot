/**
 * ModerationServiceImpl — the shared moderation core used by both the admin bot
 * and the web panel (ADMIN_BOT.md). Enforces rank hierarchy + self-target guards,
 * requires a duration for the cross-surface /mute, writes the audit record, and
 * mirrors active enforcement into Redis. Every outcome is logged.
 */
import {
  err,
  ok,
  type ApplyActionInput,
  type AuditQuery,
  type InfractionDTO,
  type ModerationActionDTO,
  type ModerationError,
  type ModerationService,
  type ModerationSurface,
  type Result,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import type { ModerationMetrics } from "./metrics.js";
import {
  countWarnsInWindow,
  escalationReason,
  parsePolicy,
  rungFor,
  type EscalationRung,
} from "./escalation.js";
import { inForce } from "./expiry.js";
import { isPunitive, needsBotPermission, rankOf } from "./rank.js";
import { parseRelaySync, resolveGameCommand } from "./relay-sync.js";
import type {
  BotCapabilities,
  EnforcementMirror,
  EscalationPolicySource,
  GameCommandBus,
  IgnResolver,
  ModerationRepository,
  RankResolver,
  RelaySyncSource,
} from "./ports.js";

export interface ModerationServiceDeps {
  readonly repo: ModerationRepository;
  readonly ranks: RankResolver;
  readonly enforcement: EnforcementMirror;
  readonly botCaps: BotCapabilities;
  /**
   * Omit to turn auto-escalation off entirely. A deployment that has not wired
   * a policy source gets warnings that are only warnings, which is the safe
   * direction: the alternative is a bot inventing bans from a default nobody
   * chose.
   */
  readonly escalation?: EscalationPolicySource;
  /**
   * Omit either of these to turn relay sync off. A deployment with no bridge has
   * nowhere to send a guild command, and a deployment that cannot resolve an IGN
   * would be sending it about nobody.
   */
  readonly gameCommands?: GameCommandBus;
  readonly igns?: IgnResolver;
  readonly relaySync?: RelaySyncSource;
  /** Optional: absent means actions are applied but not counted. */
  readonly metrics?: ModerationMetrics;
  readonly logger: Logger;
  /** Injectable clock for deterministic expiry in tests. */
  readonly now?: () => Date;
}

export class ModerationServiceImpl implements ModerationService {
  private readonly repo: ModerationRepository;
  private readonly ranks: RankResolver;
  private readonly enforcement: EnforcementMirror;
  private readonly botCaps: BotCapabilities;
  private readonly escalationSource: EscalationPolicySource | null;
  private readonly gameCommands: GameCommandBus | null;
  private readonly igns: IgnResolver | null;
  private readonly relaySyncSource: RelaySyncSource | null;
  private readonly metrics: ModerationMetrics | null;
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(deps: ModerationServiceDeps) {
    this.repo = deps.repo;
    this.ranks = deps.ranks;
    this.enforcement = deps.enforcement;
    this.botCaps = deps.botCaps;
    this.escalationSource = deps.escalation ?? null;
    this.gameCommands = deps.gameCommands ?? null;
    this.igns = deps.igns ?? null;
    this.relaySyncSource = deps.relaySync ?? null;
    this.metrics = deps.metrics ?? null;
    this.log = deps.logger.child({ service: "moderation" });
    this.now = deps.now ?? (() => new Date());
  }

  async recordInfraction(input: Omit<InfractionDTO, "id" | "createdAt">): Promise<Result<InfractionDTO>> {
    const dto = await this.repo.createInfraction(input);
    this.log.info("infraction filed", { guildId: dto.guildId, type: dto.type, id: dto.id });
    return ok(dto);
  }

  async listInfractions(guildId: string, discordId: string): Promise<Result<readonly InfractionDTO[]>> {
    return ok(await this.repo.listInfractions(guildId, discordId));
  }

  async listRecentInfractions(guildId: string, limit = 50): Promise<Result<readonly InfractionDTO[]>> {
    return ok(await this.repo.listRecentInfractions(guildId, limit));
  }

  async listActions(query: AuditQuery): Promise<Result<readonly ModerationActionDTO[]>> {
    return ok(await this.repo.listActions(query));
  }

  /**
   * Filtered twice on purpose: the store narrows to flagged-active rows that
   * have not passed their expiry, and `inForce` re-checks against this
   * process's clock. The second pass costs nothing and covers the seconds
   * between the query and the render, plus any store that answers with a
   * coarser notion of "active" than this one.
   */
  async listInForce(
    guildId: string,
    targetDiscordId: string | null = null,
  ): Promise<Result<readonly ModerationActionDTO[]>> {
    const rows = await this.repo.listActions({
      guildId,
      targetDiscordId,
      inForceOnly: true,
      limit: 200,
    });
    return ok(inForce(rows, this.now()));
  }

  async sweepExpired(now: Date = this.now()): Promise<Result<number>> {
    const cleared = await this.repo.deactivateExpired(null, now);
    if (cleared > 0) this.log.info("expired punishments cleared", { cleared });
    return ok(cleared);
  }

  async applyAction(input: ApplyActionInput): Promise<Result<ModerationActionDTO, ModerationError>> {
    const punitive = isPunitive(input.type);

    // Guard: no punishing yourself.
    if (punitive && input.targetDiscordId !== null && input.targetDiscordId === input.actorDiscordId) {
      return this.reject(input, { kind: "SELF_TARGET" });
    }

    // Guard: rank hierarchy — can't action an equal-or-higher rank.
    if (punitive && input.targetDiscordId !== null) {
      const [actorRole, targetRole] = await Promise.all([
        this.ranks.getRole(input.guildId, input.actorDiscordId),
        this.ranks.getRole(input.guildId, input.targetDiscordId),
      ]);
      // An actor with no membership has no standing to act at all, so they are
      // treated as outranked by everyone. A *target* with no membership is the
      // weakest possible standing rather than an error: someone who has left the
      // server is exactly who a ban is for.
      if (actorRole === null || rankOf(targetRole ?? "MEMBER") >= rankOf(actorRole)) {
        return this.reject(input, { kind: "TARGET_OUTRANKS_ACTOR" });
      }
    }

    // Guard: cross-surface mute must be time-bounded (Hypixel chat mutes require it).
    if (input.type === "MUTE" && !(input.durationSeconds && input.durationSeconds > 0)) {
      return this.reject(input, { kind: "DURATION_REQUIRED" });
    }

    // Guard: bot must actually be able to enforce the Discord side.
    if (needsBotPermission(input.type) && !(await this.botCaps.canPerform(input.guildId, input.type))) {
      return this.reject(input, { kind: "BOT_MISSING_PERMISSION" });
    }

    const duration = input.durationSeconds ?? null;
    const expiresAt =
      duration && duration > 0 ? new Date(this.now().getTime() + duration * 1000).toISOString() : null;
    const surfaces = surfacesFor(input.type);

    const action = await this.repo.createAction({
      guildId: input.guildId,
      infractionId: input.infractionId ?? null,
      type: input.type,
      actorDiscordId: input.actorDiscordId,
      targetDiscordId: input.targetDiscordId,
      targetMinecraftUuid: input.targetMinecraftUuid ?? null,
      reason: input.reason,
      durationSeconds: duration,
      expiresAt,
      surfaces,
      active: isActiveState(input.type),
    });

    // Counted here rather than at `createAction`, so the count means "a
    // punishment took effect" and not "a row was written" — the two differ
    // whenever enforcement is the thing that failed.
    this.metrics?.actionApplied(action.guildId, action.type);

    await this.enforcement.apply(action);
    await this.relayToGame(action);
    // Escalation runs after the warning is recorded, never before: the count it
    // reads must include the warning that prompted it, and a warning that
    // failed to store is not one anybody should be punished for.
    if (action.type === "WARN") await this.escalate(action);
    this.log.info("moderation action applied", {
      guildId: action.guildId,
      type: action.type,
      actor: action.actorDiscordId,
      target: action.targetDiscordId,
      surfaces: action.surfaces,
      expiresAt: action.expiresAt,
    });
    return ok(action);
  }

  /**
   * Carry a Discord action into guild chat, if the guild's mapping says to.
   *
   * Failures are logged and swallowed, for the same reason escalation failures
   * are: the punishment has already been recorded and mirrored, the staffer has
   * been told it worked, and an offline bridge must not retroactively undo a
   * mute that is in force everywhere else. What it must not do is fail silently
   * — every skipped send says why.
   */
  private async relayToGame(action: ModerationActionDTO): Promise<void> {
    if (this.gameCommands === null || this.igns === null) return;
    if (action.targetDiscordId === null) return;

    try {
      const policy = parseRelaySync(
        this.relaySyncSource === null ? null : await this.relaySyncSource.readRelaySync(action.guildId),
      );
      if (!policy.enabled) return;

      const ign = await this.igns.ignFor(action.guildId, action.targetDiscordId);
      const command = resolveGameCommand(policy, {
        type: action.type,
        ign,
        durationSeconds: action.durationSeconds,
      });
      if (command === null) {
        // Worth a line only when a mapping existed and the target was the
        // reason it could not fire — "this action maps to nothing" is the
        // configured answer, not an incident.
        if (ign === null) {
          this.log.debug("relay sync skipped: target has no linked account", {
            guildId: action.guildId,
            type: action.type,
            target: action.targetDiscordId,
          });
        }
        return;
      }

      await this.gameCommands.send(action.guildId, command);
      this.log.info("relay sync sent", {
        guildId: action.guildId,
        type: action.type,
        target: action.targetDiscordId,
        command,
      });
    } catch (error) {
      this.log.warn("relay sync failed", {
        guildId: action.guildId,
        type: action.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Apply the ladder to a warning that was just recorded.
   *
   * Failures here are logged and swallowed. The warning itself succeeded and
   * the staffer is told so; turning "the escalation ban was refused because the
   * bot lacks the permission" into a failed `/warn` would lose the warning too,
   * and the record of it is the part that must not be lost.
   */
  private async escalate(warning: ModerationActionDTO): Promise<void> {
    if (this.escalationSource === null || warning.targetDiscordId === null) return;

    try {
      const policy = parsePolicy(await this.escalationSource.readPolicy(warning.guildId));
      if (!policy.enabled) return;

      const now = this.now();
      const history = await this.repo.listActions({
        guildId: warning.guildId,
        targetDiscordId: warning.targetDiscordId,
        type: "WARN",
        sinceDays: policy.windowDays,
        limit: 200,
      });
      // Counted again in-process against the same window the ladder is written
      // in: `sinceDays` is the store's approximation, and the rung a member
      // lands on should not depend on whose clock rounded which way.
      const warnCount = countWarnsInWindow(history, policy.windowDays, now);
      const rung = rungFor(policy.rungs, warnCount);
      if (rung === null) return;

      await this.applyEscalationRung(warning, rung, warnCount, policy.windowDays);
    } catch (error) {
      this.log.error("escalation failed", {
        guildId: warning.guildId,
        target: warning.targetDiscordId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async applyEscalationRung(
    warning: ModerationActionDTO,
    rung: EscalationRung,
    warnCount: number,
    windowDays: number,
  ): Promise<void> {
    // Attributed to the staffer who issued the warning, not to a synthetic
    // "system" id. They are the one who took the action that tripped the rung,
    // and an audit row whose actor is nobody is a row nobody can be asked about.
    // It also means the rank guard still applies: escalation cannot reach
    // somebody the warning itself was not allowed to touch.
    const result = await this.applyAction({
      guildId: warning.guildId,
      type: rung.action,
      actorDiscordId: warning.actorDiscordId,
      targetDiscordId: warning.targetDiscordId,
      reason: escalationReason(warnCount, windowDays),
      durationSeconds: rung.durationSeconds,
    });

    if (!result.ok) {
      this.log.warn("escalation refused", {
        guildId: warning.guildId,
        target: warning.targetDiscordId,
        rung: rung.warns,
        action: rung.action,
        reason: result.error.kind,
      });
      return;
    }
    this.log.info("warning escalated", {
      guildId: warning.guildId,
      target: warning.targetDiscordId,
      warnCount,
      rung: rung.warns,
      action: rung.action,
      source: rung.source,
    });
  }

  private reject(
    input: ApplyActionInput,
    error: ModerationError,
  ): Result<ModerationActionDTO, ModerationError> {
    this.log.warn("moderation action refused", {
      guildId: input.guildId,
      type: input.type,
      actor: input.actorDiscordId,
      target: input.targetDiscordId,
      reason: error.kind,
    });
    return err(error);
  }
}

function surfacesFor(type: string): readonly ModerationSurface[] {
  // Cross-surface mute sweeps both Discord and guild chat; everything else is Discord.
  return type === "MUTE" ? ["DISCORD", "GUILD_CHAT"] : ["DISCORD"];
}

function isActiveState(type: string): boolean {
  // Reversal/annotation actions are not themselves "active enforcement".
  return type !== "UNMUTE" && type !== "UNBAN" && type !== "NOTE";
}
