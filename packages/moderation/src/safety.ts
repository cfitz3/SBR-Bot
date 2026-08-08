/**
 * Server-safety postures: `/lockdown`, `/antiraid-on`, `/antiraid-off`.
 *
 * ADMIN_BOT.md §6 requires these to be time-boxed and to expire on their own so
 * a forgotten toggle cannot silently strangle a server. `expiresAt` — not a
 * Redis TTL — is authoritative for that: a key that simply vanished would take
 * with it the record of which channels to unlock, leaving the server locked
 * forever with nothing left to explain why. Instead the record outlives the
 * posture, `status()` reports an elapsed posture as inactive, and `sweepExpired`
 * (driven by a worker) performs the actual unlock.
 */
import {
  err,
  ok,
  type AntiRaidInput,
  type AntiRaidStateDTO,
  type GuildEffects,
  type LockdownInput,
  type LockdownStateDTO,
  type Result,
  type SafetyError,
  type SafetyService,
  type SafetyStatusDTO,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import type { SafetyStateStore } from "./ports.js";

export interface SafetyServiceDeps {
  readonly store: SafetyStateStore;
  readonly effects: GuildEffects;
  readonly logger: Logger;
  readonly now?: () => Date;
}

/** How long a lifted-or-elapsed record lingers before Redis reclaims it. */
const RECORD_TTL_SECONDS = 30 * 24 * 60 * 60;

function isElapsed(expiresAt: string | null, now: Date): boolean {
  return expiresAt !== null && new Date(expiresAt).getTime() <= now.getTime();
}

export class SafetyServiceImpl implements SafetyService {
  private readonly store: SafetyStateStore;
  private readonly effects: GuildEffects;
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(deps: SafetyServiceDeps) {
    this.store = deps.store;
    this.effects = deps.effects;
    this.log = deps.logger.child({ service: "safety" });
    this.now = deps.now ?? (() => new Date());
  }

  async lockdown(input: LockdownInput): Promise<Result<LockdownStateDTO, SafetyError>> {
    if (input.scope === "CHANNEL" && !input.channelId) return err({ kind: "CHANNEL_REQUIRED" });

    const now = this.now();
    const current = await this.store.getLockdown(input.guildId);
    if (current && !isElapsed(current.expiresAt, now)) {
      return err({ kind: "ALREADY_ACTIVE", until: current.expiresAt });
    }

    const channelId = input.scope === "SERVER" ? null : (input.channelId ?? null);
    const applied = await this.effects.setLocked(input.guildId, channelId, true);
    if (!applied.ok) return err({ kind: "DISCORD_FAILED", detail: describe(applied.error) });

    const duration = input.durationSeconds ?? null;
    const state: LockdownStateDTO = {
      guildId: input.guildId,
      scope: input.scope,
      channelId,
      reason: input.reason,
      actorDiscordId: input.actorDiscordId,
      startedAt: now.toISOString(),
      expiresAt: duration && duration > 0 ? new Date(now.getTime() + duration * 1000).toISOString() : null,
    };
    await this.store.putLockdown(state, RECORD_TTL_SECONDS);
    this.log.warn("lockdown engaged", {
      guildId: state.guildId,
      scope: state.scope,
      channels: applied.value,
      actor: state.actorDiscordId,
      expiresAt: state.expiresAt,
    });
    return ok(state);
  }

  async liftLockdown(guildId: string): Promise<Result<LockdownStateDTO | null>> {
    const state = await this.store.getLockdown(guildId);
    if (!state) return ok(null);
    const applied = await this.effects.setLocked(guildId, state.channelId, false);
    if (!applied.ok) return err(new Error(describe(applied.error)));
    await this.store.clearLockdown(guildId);
    this.log.info("lockdown lifted", { guildId, scope: state.scope });
    return ok(state);
  }

  async enableAntiRaid(input: AntiRaidInput): Promise<Result<AntiRaidStateDTO, SafetyError>> {
    const now = this.now();
    const current = await this.store.getAntiRaid(input.guildId);
    if (current && !isElapsed(current.expiresAt, now)) {
      return err({ kind: "ALREADY_ACTIVE", until: current.expiresAt });
    }

    const duration = input.durationSeconds ?? null;
    const state: AntiRaidStateDTO = {
      guildId: input.guildId,
      sensitivity: input.sensitivity,
      actorDiscordId: input.actorDiscordId,
      startedAt: now.toISOString(),
      expiresAt: duration && duration > 0 ? new Date(now.getTime() + duration * 1000).toISOString() : null,
    };
    await this.store.putAntiRaid(state, RECORD_TTL_SECONDS);
    this.log.warn("anti-raid enabled", {
      guildId: state.guildId,
      sensitivity: state.sensitivity,
      actor: state.actorDiscordId,
      expiresAt: state.expiresAt,
    });
    return ok(state);
  }

  async disableAntiRaid(guildId: string): Promise<Result<AntiRaidStateDTO, SafetyError>> {
    const now = this.now();
    const state = await this.store.getAntiRaid(guildId);
    if (!state || isElapsed(state.expiresAt, now)) return err({ kind: "NOT_ACTIVE" });
    await this.store.clearAntiRaid(guildId);
    this.log.info("anti-raid disabled", { guildId });
    return ok(state);
  }

  async status(guildId: string): Promise<Result<SafetyStatusDTO>> {
    const now = this.now();
    const [lockdown, antiRaid] = await Promise.all([
      this.store.getLockdown(guildId),
      this.store.getAntiRaid(guildId),
    ]);
    return ok({
      lockdown: lockdown && !isElapsed(lockdown.expiresAt, now) ? lockdown : null,
      antiRaid: antiRaid && !isElapsed(antiRaid.expiresAt, now) ? antiRaid : null,
    });
  }

  /**
   * Unlock every lockdown whose window has closed and drop elapsed anti-raid
   * records. This is what makes "auto-expiry" true rather than nominal, so a
   * worker calls it on a short cadence. Returns how many guilds were reopened.
   */
  async sweepExpired(): Promise<number> {
    const now = this.now();
    let reopened = 0;
    for (const state of await this.store.listLockdowns()) {
      if (!isElapsed(state.expiresAt, now)) continue;
      const applied = await this.effects.setLocked(state.guildId, state.channelId, false);
      if (!applied.ok) {
        // Leave the record in place: an unlock we could not perform must be
        // retried next tick, not forgotten with the channels still locked.
        this.log.error("lockdown auto-lift failed", { guildId: state.guildId, error: describe(applied.error) });
        continue;
      }
      await this.store.clearLockdown(state.guildId);
      reopened += 1;
      this.log.info("lockdown expired and lifted", { guildId: state.guildId });
    }
    for (const state of await this.store.listAntiRaid()) {
      if (!isElapsed(state.expiresAt, now)) continue;
      await this.store.clearAntiRaid(state.guildId);
      this.log.info("anti-raid expired", { guildId: state.guildId });
    }
    return reopened;
  }
}

function describe(error: { readonly kind: string; readonly detail?: string }): string {
  switch (error.kind) {
    case "MISSING_PERMISSION":
      return "the bot lacks Manage Channels here";
    case "NOT_FOUND":
      return "that channel no longer exists";
    default:
      return error.detail ?? "Discord rejected the change";
  }
}
