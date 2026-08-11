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
import { inForce } from "./expiry.js";
import { isPunitive, needsBotPermission, rankOf } from "./rank.js";
import type {
  BotCapabilities,
  EnforcementMirror,
  ModerationRepository,
  RankResolver,
} from "./ports.js";

export interface ModerationServiceDeps {
  readonly repo: ModerationRepository;
  readonly ranks: RankResolver;
  readonly enforcement: EnforcementMirror;
  readonly botCaps: BotCapabilities;
  readonly logger: Logger;
  /** Injectable clock for deterministic expiry in tests. */
  readonly now?: () => Date;
}

export class ModerationServiceImpl implements ModerationService {
  private readonly repo: ModerationRepository;
  private readonly ranks: RankResolver;
  private readonly enforcement: EnforcementMirror;
  private readonly botCaps: BotCapabilities;
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(deps: ModerationServiceDeps) {
    this.repo = deps.repo;
    this.ranks = deps.ranks;
    this.enforcement = deps.enforcement;
    this.botCaps = deps.botCaps;
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
      if (rankOf(targetRole) >= rankOf(actorRole)) {
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

    await this.enforcement.apply(action);
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
