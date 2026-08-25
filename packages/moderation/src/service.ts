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
  type EnforcementStatus,
  type AuditQuery,
  type InfractionDTO,
  type ModActionType,
  type ModerationActionDTO,
  type ModerationError,
  type ModerationService,
  type ModerationSurface,
  type Result,
  type RoleDirtyMarker,
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
import { EXPIRY_ACTOR, inForce } from "./expiry.js";
import { modLogEmbed, type ModLogSink } from "./mod-log.js";
import { isPunitive, needsBotPermission, rankOf } from "./rank.js";
import { type GameCommandPlan, parseRelaySync, resolveGameCommand } from "./relay-sync.js";
import type {
  BotCapabilities,
  DiscordEnforcer,
  EnforcementMirror,
  EnforcementOutcome,
  EscalationPolicySource,
  GameCommandBus,
  IgnResolver,
  ModerationRepository,
  RankResolver,
  RelaySyncSource,
  StaffAlertSink,
} from "./ports.js";
import { AUTOMOD_ACTOR } from "./automod-runner.js";

/**
 * A punishment that happened somewhere this platform does not control.
 *
 * Today that means Hypixel: a staffer typing `/g kick` in game, read back out
 * of the guild-chat notice. Deliberately not an `ApplyActionInput` - this is a
 * record of something that has already happened, not an instruction, and the
 * distinction is load-bearing. Issuing it as an instruction would relay it
 * straight back into the game the notice came from, kicking somebody twice.
 */
export interface ExternalActionInput {
  readonly guildId: string;
  readonly type: "KICK" | "MUTE" | "UNMUTE";
  /** Resolved from the IGN, or null when the member never linked an account. */
  readonly targetDiscordId: string | null;
  readonly targetIgn: string;
  /** A snowflake when the staffer is linked, otherwise a sentinel. */
  readonly actorDiscordId: string;
  readonly actorIgn: string | null;
  readonly reason: string;
  readonly durationSeconds: number | null;
}

export interface ModerationServiceDeps {
  readonly repo: ModerationRepository;
  readonly ranks: RankResolver;
  readonly enforcement: EnforcementMirror;
  /**
   * The half of a punishment that removes a person from Discord.
   *
   * Optional only so a process with no gateway can be composed at all; omitting
   * it does **not** mean "enforce nothing quietly". Every action that needs
   * Discord is then recorded `FAILED` and alerted on, because a deployment that
   * writes ban rows and bans nobody is the bug this whole port exists to close.
   */
  readonly discord?: DiscordEnforcer;
  /** Where an enforcement failure is announced. Omit and it is only logged. */
  readonly staffAlerts?: StaffAlertSink;
  /**
   * Somewhere to say "this member's auto-roles may be stale".
   *
   * A ban strips roles as a side effect of removing the member, and a mute
   * changes what the auto-role reconciler should be granting. Without a mark,
   * both waited for the next full sweep - so a punishment took effect on one
   * surface immediately and on another whenever the sweep next came round.
   * Optional and forgiving, like everywhere else it is used: a mark is a
   * promptness hint and the sweep is what makes the answer correct.
   */
  readonly rolesDirty?: RoleDirtyMarker;
  /**
   * Where the guild's moderation log is kept. Optional: a process with no
   * gateway cannot post, and a missing log is not a reason to refuse a
   * punishment.
   */
  readonly modLog?: ModLogSink;
  readonly botCaps: BotCapabilities;
  /**
   * Actor ids that stand outside the rank ladder — automod, and anything else
   * the platform issues on its own behalf.
   *
   * Without this, automod was refused every single punishment it tried to
   * issue: its actor id is the sentinel `"automod"`, no `GuildMember` row
   * carries that id, `RankResolver` answered null, and null actor means "no
   * standing to act". The exemptions inside the automod policy are what keep
   * staff safe from it, not the rank guard it could never pass.
   */
  readonly systemActorIds?: readonly string[];
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
  private readonly discord: DiscordEnforcer | null;
  private readonly staffAlerts: StaffAlertSink | null;
  private readonly rolesDirty: RoleDirtyMarker | null;
  private readonly modLog: ModLogSink | null;
  private readonly systemActorIds: ReadonlySet<string>;
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
    this.discord = deps.discord ?? null;
    this.staffAlerts = deps.staffAlerts ?? null;
    this.rolesDirty = deps.rolesDirty ?? null;
    this.modLog = deps.modLog ?? null;
    this.systemActorIds = new Set(deps.systemActorIds ?? [AUTOMOD_ACTOR, EXPIRY_ACTOR]);
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
   * One case, by the id every reply and every mod-log card already quotes.
   *
   * The ids were being handed out long before anything could look one up:
   * "(case act-1f3b)" appeared in the confirmation, in the log channel and in
   * appeals, and the only way to find it again was to page `/audit` until it
   * turned up. Guild-scoped in the port, not here, so no caller can forget.
   */
  async findAction(guildId: string, actionId: string): Promise<Result<ModerationActionDTO | null>> {
    return ok(await this.repo.findAction(guildId, actionId.trim()));
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

  /**
   * Lift punishments whose clock has run out — on Discord and in guild chat,
   * not merely in the database.
   *
   * `sweepExpired` clears the `active` column and stops there, which is correct
   * bookkeeping and was, until now, the *only* thing that happened when a temp
   * ban expired. Discord bans do not expire; neither does a Hypixel guild mute
   * we asked for in `/g mute`. So a 7-day ban became a permanent one with a row
   * claiming otherwise, and the only person who could tell was the member still
   * locked out on day eight.
   *
   * Each reversal is a real UNMUTE/UNBAN action: audited, attributed to
   * `EXPIRY_ACTOR`, enforced on both surfaces and marked FAILED with a staff
   * alert if either refuses. Reversals are attempted one at a time rather than
   * in parallel — this is a handful of rows an hour, and a burst of ban-removal
   * calls is a good way to meet Discord's rate limiter.
   *
   * Returns how many were reversed. Rows that could not be reversed still have
   * their flag cleared by the final sweep: the punishment *has* expired, and
   * leaving it flagged active would make the audit log wrong in the other
   * direction. The failed enforcement is what carries the alarm.
   */
  async reverseExpired(now: Date = this.now(), limit = 50): Promise<Result<number>> {
    const due = await this.repo.listExpiredActive(null, now, limit);

    let reversed = 0;
    for (const action of due) {
      if (action.targetDiscordId === null) continue;
      const type = action.type === "BAN" ? "UNBAN" : "UNMUTE";
      const result = await this.applyAction({
        guildId: action.guildId,
        type,
        actorDiscordId: EXPIRY_ACTOR,
        targetDiscordId: action.targetDiscordId,
        reason: `Automatic: ${action.type.toLowerCase()} from case ${action.id} expired`,
      });
      if (result.ok) reversed += 1;
      else {
        this.log.error("an expired punishment could not be reversed", {
          guildId: action.guildId,
          actionId: action.id,
          reason: result.error.kind,
        });
      }
    }

    const cleared = await this.repo.deactivateExpired(null, now);
    if (reversed > 0 || cleared > 0) {
      this.log.info("expired punishments swept", { reversed, cleared });
    }
    return ok(reversed);
  }

  /**
   * Mirror a punishment that happened in game.
   *
   * This replaces a deliberate bypass. `recordInGameAction` used to hand-write
   * the audit row and stop there, because routing it through `applyAction`
   * would have relayed the kick straight back into the game the notice came
   * from. That reasoning was sound and the consequence was not: somebody
   * kicked from the Hypixel guild kept their Discord membership, their roles
   * and their access, and the only trace was a row on a page nobody had reason
   * to open. Staff had to remember to do the Discord half by hand.
   *
   * So the row is written the same way, and then the Discord half is carried
   * out - with the game relay skipped, because the game has already acted.
   *
   * Only KICK mirrors. An in-game mute is Hypixel's to hold and Hypixel's to
   * lift; the platform cannot do either, and timing somebody out of Discord
   * because they were muted in a Minecraft guild is a punishment nobody asked
   * for.
   */
  async recordExternalAction(input: ExternalActionInput): Promise<Result<ModerationActionDTO>> {
    const mirrors = input.type === "KICK";
    const written = await this.repo.createAction({
      guildId: input.guildId,
      infractionId: null,
      type: input.type,
      actorDiscordId: input.actorDiscordId,
      targetDiscordId: input.targetDiscordId,
      targetMinecraftUuid: null,
      reason: input.reason,
      durationSeconds: input.durationSeconds,
      expiresAt:
        input.durationSeconds === null
          ? null
          : new Date(this.now().getTime() + input.durationSeconds * 1_000).toISOString(),
      surfaces: mirrors && input.targetDiscordId !== null ? ["GUILD_CHAT", "DISCORD"] : ["GUILD_CHAT"],
      // Not a punishment the platform holds. An in-game mute is Hypixel's to
      // expire and a kick has nothing to expire, so marking either active would
      // make the sweep think it owned something it cannot touch.
      active: false,
      sourceContext: "INGAME",
    });

    const settled = await this.settleExternal(written, input);
    await this.postModLog(settled);
    return ok(settled);
  }

  /**
   * The Discord half of an in-game punishment, and its verdict.
   *
   * Every refusal below is stamped on the row and said out loud to staff. A
   * mirror that quietly declines is the same silence this whole surface exists
   * to remove - worse here, because nobody typed anything, so nobody is waiting
   * for a reply that would have told them.
   */
  private async settleExternal(
    action: ModerationActionDTO,
    input: ExternalActionInput,
  ): Promise<ModerationActionDTO> {
    const stamp = async (status: EnforcementStatus, detail: string | null): Promise<ModerationActionDTO> => {
      await this.repo.setEnforcement(action.id, status, detail).catch((error: unknown) => {
        this.log.error("could not record the mirrored enforcement outcome", {
          guildId: action.guildId,
          actionId: action.id,
          error: message(error),
        });
      });
      return { ...action, enforcement: status, enforcementDetail: detail };
    };

    if (input.type !== "KICK") {
      return stamp("NOT_REQUIRED", "recorded from in game; Hypixel holds and lifts its own mutes");
    }

    if (action.targetDiscordId === null) {
      // Not a failure - there is no Discord account to remove. Said out loud
      // anyway, because "kicked in game, still in Discord under a name we
      // cannot match" is exactly the gap staff need to close by hand.
      const detail = `${input.targetIgn} has no linked Discord account, so nothing was mirrored`;
      await this.alertStaffText(
        action.guildId,
        `ℹ️ **In-game kick not mirrored** — \`${input.targetIgn}\` was kicked from the guild but has ` +
          `no linked Discord account, so nobody could be removed. Case \`${action.id}\`.`,
      );
      return stamp("NOT_REQUIRED", detail);
    }

    // Staff are not mirrored. An officer kicked in game is far more likely to
    // be a mistake, a test, or somebody's account being misused than a decision
    // to strip a staff member of their Discord access - and this path has no
    // human waiting on it to notice and undo it.
    const targetRole = await this.ranks.getRole(action.guildId, action.targetDiscordId).catch(() => null);
    if (targetRole !== null && rankOf(targetRole) > rankOf("MEMBER")) {
      const detail = "the target holds a staff role; the Discord half was left for a human";
      await this.alertStaffText(
        action.guildId,
        `⚠️ **In-game kick not mirrored** — <@${action.targetDiscordId}> was kicked from the guild in ` +
          `game, but they hold a staff role, so they were **not** removed from Discord. ` +
          `Case \`${action.id}\`.`,
      );
      return stamp("NOT_REQUIRED", detail);
    }

    if (this.discord === null) {
      const detail = "no Discord enforcer is wired into this process";
      await this.alertStaff(action, detail);
      return stamp("FAILED", detail);
    }

    const outcome = await this.discord
      .enforce(action)
      .catch((error: unknown): EnforcementOutcome => ({ ok: false, reason: message(error) }));

    if (!outcome.ok) {
      this.metrics?.actionFailed(action.guildId, action.type);
      await this.alertStaff(action, outcome.reason);
      return stamp("FAILED", outcome.reason);
    }
    if ("skipped" in outcome && outcome.skipped) return stamp("NOT_REQUIRED", outcome.reason);

    this.metrics?.actionApplied(action.guildId, action.type);
    this.log.info("in-game kick mirrored to Discord", {
      guildId: action.guildId,
      actionId: action.id,
      target: action.targetDiscordId,
      ign: input.targetIgn,
    });
    return stamp("CONFIRMED", null);
  }

  /**
   * Settle the rows the guild never answered for.
   *
   * PENDING is an honest answer for the fifteen seconds a `/g kick` is allowed
   * to take, and a dishonest one after ten minutes: nothing is coming, and a
   * case still reading "pending" is a punishment nobody has been told did not
   * land. This is the backstop that guarantees no row sits in limbo — it turns
   * the silence into a FAILED case and a staff alert, which is the same
   * treatment a refusal gets, because the consequence is identical.
   *
   * The grace period is generous on purpose. It has to outlast the bridge's own
   * outbound queue, which holds a command for as long as ten minutes waiting
   * for a Minecraft session to come back.
   */
  async settleStalePending(graceMs = 10 * 60_000, limit = 50): Promise<Result<number>> {
    const before = new Date(this.now().getTime() - graceMs);
    const stale = await this.repo.listStalePending(before, limit);

    let escalated = 0;
    for (const action of stale) {
      const detail = "the guild never confirmed the command; it was still pending when the sweep ran";
      await this.repo.setEnforcement(action.id, "FAILED", detail).catch((error: unknown) => {
        this.log.error("could not escalate a stale pending enforcement", {
          guildId: action.guildId,
          actionId: action.id,
          error: message(error),
        });
      });
      await this.alertStaff(action, detail);
      escalated += 1;
    }
    if (escalated > 0) this.log.warn("unconfirmed punishments escalated", { escalated });
    return ok(escalated);
  }

  async applyAction(input: ApplyActionInput): Promise<Result<ModerationActionDTO, ModerationError>> {
    const punitive = isPunitive(input.type);

    // Guard: no punishing yourself.
    if (punitive && input.targetDiscordId !== null && input.targetDiscordId === input.actorDiscordId) {
      return this.reject(input, { kind: "SELF_TARGET" });
    }

    // Guard: rank hierarchy — can't action an equal-or-higher rank.
    //
    // System actors are exempt, and have to be. Automod acts as the literal id
    // `automod`, which has no `GuildMember` row, so `getRole` returned null, so
    // "an actor with no membership has no standing" refused *every* automod
    // warn and mute — a whole enforcement path dead on arrival, and invisible
    // because the service test's rank fake defaulted unknown ids to MEMBER
    // instead of null. There is no hierarchy question to answer here anyway:
    // automod is not a member competing for rank, it is the guild's own rule.
    if (punitive && input.targetDiscordId !== null && !this.systemActorIds.has(input.actorDiscordId)) {
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

    // The row is written *before* anything is attempted, and written as
    // PENDING. An enforcement that throws, times out or takes the process down
    // with it then leaves evidence behind; a row written only after success
    // would leave none, which is the shape the original bug had.
    const written = await this.repo.createAction({
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

    const action = await this.enforce(written);

    // Escalation runs after the warning is recorded, never before: the count it
    // reads must include the warning that prompted it, and a warning that
    // failed to store is not one anybody should be punished for.
    if (action.type === "WARN") await this.escalate(action);
    return ok(action);
  }

  /**
   * Carry a recorded action out on both surfaces and say what happened.
   *
   * The ordering is the point of this method. Mirror first, because the mirror
   * is what the bridge and the dispatchers read and it must hold even if
   * Discord refuses — a failed timeout should not also leave someone unmuted
   * everywhere the platform *does* control. Then Discord, then guild chat, both
   * awaited and both able to fail. Only once both have answered is the row
   * given its verdict.
   *
   * Neither surface is allowed to fail the *call*. The action is recorded, and
   * `/ban` returning an error after the row exists would be a second kind of
   * lie. What it returns instead is an action carrying its own enforcement
   * status, which the caller shows to the staffer who typed the command.
   */
  private async enforce(action: ModerationActionDTO): Promise<ModerationActionDTO> {
    await this.mirror(action);

    // Before either surface is touched, because it is a hint and not a step: a
    // punishment that changes what roles somebody should hold should not wait
    // for the reconciler's daily sweep to notice.
    if (action.targetDiscordId !== null) {
      await this.rolesDirty
        ?.mark(action.guildId, [action.targetDiscordId])
        .catch(() => undefined);
    }

    const discord = await this.enforceDiscord(action);
    const game = await this.relayToGame(action);

    const failures: string[] = [];
    if (!discord.ok) failures.push(`Discord: ${discord.reason}`);
    if (!game.ok) failures.push(`guild chat: ${game.reason}`);

    // Unsettled, not failed. The row stays PENDING and `punishment-sweep`
    // escalates it if the guild never answers, which is what keeps an
    // unconfirmed kick from reading as a finished one without alerting staff
    // every time the outbound queue happens to be busy.
    const unsettled = "pending" in game && game.pending ? game.reason : null;

    const status: EnforcementStatus =
      failures.length > 0
        ? "FAILED"
        : !requiresEnforcement(action.type)
          ? "NOT_REQUIRED"
          : unsettled !== null
            ? "PENDING"
            : "CONFIRMED";
    const detail = failures.length > 0 ? failures.join("; ") : unsettled;

    // Counted only once both surfaces have answered, so the Analytics chart
    // means "a punishment took effect" rather than "a row was written". The
    // comment claiming exactly that used to sit above a call that ran before
    // either surface had been touched.
    if (status === "FAILED") this.metrics?.actionFailed(action.guildId, action.type);
    else this.metrics?.actionApplied(action.guildId, action.type);

    await this.repo.setEnforcement(action.id, status, detail).catch((error: unknown) => {
      this.log.error("could not record the enforcement outcome", {
        guildId: action.guildId,
        actionId: action.id,
        error: message(error),
      });
    });

    if (status === "FAILED") {
      this.log.error("moderation action was recorded but not enforced", {
        guildId: action.guildId,
        actionId: action.id,
        type: action.type,
        target: action.targetDiscordId,
        detail,
      });
      await this.alertStaff(action, detail ?? "unknown");
    } else {
      this.log.info("moderation action applied", {
        guildId: action.guildId,
        type: action.type,
        actor: action.actorDiscordId,
        target: action.targetDiscordId,
        surfaces: action.surfaces,
        expiresAt: action.expiresAt,
        enforcement: status,
      });
    }

    const settled: ModerationActionDTO = { ...action, enforcement: status, enforcementDetail: detail };
    // Posted after the verdict is known, so the card can say whether it took.
    // Awaited rather than fired and forgotten, for the same reason everything
    // else in this method is: an unawaited failure here is an unhandled
    // rejection, and the sink already swallows its own errors.
    await this.postModLog(settled);
    return settled;
  }

  /**
   * The moderation log card.
   *
   * Best-effort and never a reason to fail the action: the punishment has
   * already happened, and refusing it because a channel was deleted would be
   * the tail wagging the dog. A guild with no `modlog` slot bound has no sink
   * wired, and this costs nothing.
   */
  private async postModLog(action: ModerationActionDTO): Promise<void> {
    if (this.modLog === null) return;
    try {
      await this.modLog.post(action.guildId, modLogEmbed(action, this.now()));
    } catch (error) {
      this.log.warn("moderation log post failed", {
        guildId: action.guildId,
        actionId: action.id,
        error: message(error),
      });
    }
  }

  /**
   * The Redis mirror. Best-effort by design and never a reason to call the
   * action failed: it is a cache in front of the audit table, and the audit
   * table is already written by the time this runs.
   */
  private async mirror(action: ModerationActionDTO): Promise<void> {
    try {
      await this.enforcement.apply(action);
    } catch (error) {
      this.log.warn("enforcement mirror did not update", {
        guildId: action.guildId,
        actionId: action.id,
        error: message(error),
      });
    }
  }

  /** The Discord API half — the part that actually removes or silences someone. */
  private async enforceDiscord(action: ModerationActionDTO): Promise<EnforcementOutcome> {
    if (!requiresEnforcement(action.type)) return { ok: true };
    if (action.targetDiscordId === null) return { ok: true, skipped: true, reason: "no Discord target" };
    if (this.discord === null) {
      // Not silently skipped. A process wired without an enforcer cannot punish
      // anybody, and the whole point of the audit column is that this shows up
      // on the first action rather than on the first appeal.
      return { ok: false, reason: "no Discord enforcer is wired into this process" };
    }
    try {
      return await this.discord.enforce(action);
    } catch (error) {
      return { ok: false, reason: message(error) };
    }
  }

  /** Say something to staff that is not an enforcement failure. */
  private async alertStaffText(guildId: string, text: string): Promise<void> {
    if (this.staffAlerts === null) return;
    try {
      await this.staffAlerts.alert(guildId, text);
    } catch (error) {
      this.log.error("could not reach staff", { guildId, error: message(error) });
    }
  }

  private async alertStaff(action: ModerationActionDTO, detail: string): Promise<void> {
    if (this.staffAlerts === null) return;
    const target = action.targetDiscordId === null ? "the target" : `<@${action.targetDiscordId}>`;
    try {
      await this.staffAlerts.alert(
        action.guildId,
        `⚠️ **Enforcement failed** — case \`${action.id}\` (${action.type}) against ${target} ` +
          `was written to the log but did not take effect.\n> ${detail}\n` +
          `The case is marked \`enforcement_failed\` and needs doing by hand.`,
      );
    } catch (error) {
      this.log.error("could not reach staff about a failed enforcement", {
        guildId: action.guildId,
        actionId: action.id,
        error: message(error),
      });
    }
  }

  /**
   * Carry a Discord action into guild chat, if the guild's mapping says to.
   *
   * Every "nothing was sent" answer is now one of two *different* things, and
   * telling them apart is the whole change here. A mapping that resolves to no
   * command — sync off, row off, an action with no in-game equivalent, a target
   * who never linked an account — is `skipped`: nothing was supposed to go, and
   * nothing did. A command that resolved and could not be delivered is a
   * failure, and the case says so.
   *
   * That second case was the silent one. `GameCommandBus` publishes to Redis
   * pub/sub, which has no store-and-forward: with the bridge down, the publish
   * succeeded, the message evaporated, and the only trace was a log line
   * nobody was reading. A banned member kept their guild slot.
   */
  private async relayToGame(action: ModerationActionDTO): Promise<EnforcementOutcome> {
    if (this.gameCommands === null || this.igns === null) {
      return { ok: true, skipped: true, reason: "no relay wired into this process" };
    }
    if (action.targetDiscordId === null) {
      return { ok: true, skipped: true, reason: "no Discord target" };
    }

    let plan: GameCommandPlan;
    try {
      const policy = parseRelaySync(
        this.relaySyncSource === null ? null : await this.relaySyncSource.readRelaySync(action.guildId),
      );
      if (!policy.enabled) return { ok: true, skipped: true, reason: "relay sync is off for this guild" };

      const ign = await this.igns.ignFor(action.guildId, action.targetDiscordId);
      plan = resolveGameCommand(policy, {
        type: action.type,
        ign,
        durationSeconds: action.durationSeconds,
        reason: action.reason,
      });
    } catch (error) {
      // Reading the mapping or the link failed. That is not "no command
      // applies" — it is not knowing, which for a ban means the guild kick may
      // still be owed.
      this.log.error("relay sync could not resolve a command", {
        guildId: action.guildId,
        type: action.type,
        error: message(error),
      });
      return { ok: false, reason: `could not resolve the guild command (${message(error)})` };
    }

    if (plan.kind === "skip") {
      this.log.debug("relay sync skipped", {
        guildId: action.guildId,
        type: action.type,
        target: action.targetDiscordId,
        reason: plan.why,
      });
      return { ok: true, skipped: true, reason: plan.why };
    }

    // Owed and unbuildable. Reported as a failure so the case says the guild
    // kick is still outstanding instead of quietly reading as "not required".
    if (plan.kind === "blocked") {
      this.log.warn("relay sync could not build the guild command", {
        guildId: action.guildId,
        type: action.type,
        target: action.targetDiscordId,
        reason: plan.why,
      });
      return { ok: false, reason: plan.why };
    }

    const command = plan.command;
    try {
      const receipt = await this.gameCommands.send(action.guildId, command);
      this.log.info("relay sync sent", {
        guildId: action.guildId,
        type: action.type,
        target: action.targetDiscordId,
        command,
        outcome: receipt.outcome,
        detail: receipt.detail,
      });
      // Three answers, not two. Hypixel accepting the line is the only
      // success; Hypixel refusing it, or the bridge never typing it, is a
      // failure the case has to name. Everything in between — typed but
      // unacknowledged, or nothing back inside the wait — is neither, and is
      // left for the sweep rather than guessed at in either direction.
      switch (receipt.outcome) {
        case "CONFIRMED_INGAME":
          return { ok: true };
        case "UNCONFIRMED":
        case "TIMED_OUT":
          return { ok: true, pending: true, reason: `\`${command}\` was sent but not confirmed in game (${receipt.detail})` };
        default:
          return { ok: false, reason: `the guild did not run \`${command}\` (${receipt.detail})` };
      }
    } catch (error) {
      this.log.error("relay sync failed", {
        guildId: action.guildId,
        type: action.type,
        error: message(error),
      });
      return { ok: false, reason: `sending \`${command}\` failed (${message(error)})` };
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

/**
 * Whether this action type is supposed to *do* something on Discord.
 *
 * NOTE and WARN are records: they are complete the moment the row exists, and
 * marking them CONFIRMED would claim an API call that never needed making. The
 * rest remove, silence or release somebody, and for those "recorded" is not the
 * same as "done".
 */
function requiresEnforcement(type: ModActionType): boolean {
  return type === "MUTE" || type === "UNMUTE" || type === "KICK" || type === "BAN" || type === "UNBAN";
}

/** Whatever was thrown, rendered short enough to sit in an audit column. */
function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function surfacesFor(type: string): readonly ModerationSurface[] {
  // Cross-surface mute sweeps both Discord and guild chat; everything else is Discord.
  return type === "MUTE" ? ["DISCORD", "GUILD_CHAT"] : ["DISCORD"];
}

function isActiveState(type: string): boolean {
  // Reversal/annotation actions are not themselves "active enforcement".
  return type !== "UNMUTE" && type !== "UNBAN" && type !== "NOTE";
}
