/**
 * Ports for the moderation core. Implemented over @sbr/db (audit tables) and
 * @sbr/redis (enforcement mirror) at wiring time; faked in tests.
 */
import type {
  AntiRaidStateDTO,
  AuditQuery,
  InfractionDTO,
  LockdownStateDTO,
  MemberRole,
  ModActionType,
  ModerationActionDTO,
  ModerationSurface,
  WordAction,
  WordlistRuleDTO,
  WordMatchType,
} from "@sbr/shared-types";

export interface NewActionRecord {
  readonly guildId: string;
  readonly infractionId: string | null;
  readonly type: ModActionType;
  readonly actorDiscordId: string;
  readonly targetDiscordId: string | null;
  readonly targetMinecraftUuid: string | null;
  readonly reason: string;
  readonly durationSeconds: number | null;
  readonly expiresAt: string | null;
  readonly surfaces: readonly ModerationSurface[];
  readonly active: boolean;
}

export interface ModerationRepository {
  createInfraction(input: Omit<InfractionDTO, "id" | "createdAt">): Promise<InfractionDTO>;
  createAction(input: NewActionRecord): Promise<ModerationActionDTO>;
  listInfractions(guildId: string, discordId: string): Promise<readonly InfractionDTO[]>;
  /** Newest-first audit query behind `/audit`. */
  listActions(query: AuditQuery): Promise<readonly ModerationActionDTO[]>;
  /**
   * Clear the `active` flag on punishments past their expiry, returning how
   * many rows changed. The store filters by time itself: sweeping by reading
   * every active row into the process and writing back the stale ones would
   * race with anything applied in between.
   */
  deactivateExpired(guildId: string | null, now: Date): Promise<number>;
}

/** A wordlist rule as it is written, before the store assigns it an id. */
export interface NewWordlistRecord {
  readonly guildId: string;
  readonly pattern: string;
  readonly matchType: WordMatchType;
  readonly action: WordAction;
  readonly severity: number;
  readonly addedByDiscordId: string;
  readonly note: string | null;
}

/** Port: wordlist persistence, implemented by `@sbr/db`. */
export interface WordlistRepository {
  list(guildId: string): Promise<readonly WordlistRuleDTO[]>;
  add(input: NewWordlistRecord): Promise<WordlistRuleDTO>;
  /** Null when no rule in this guild carries that id / pattern. */
  removeById(guildId: string, id: string): Promise<WordlistRuleDTO | null>;
  removeByPattern(guildId: string, pattern: string): Promise<WordlistRuleDTO | null>;
}

/**
 * Port: where safety postures live. Redis-backed in production — the records
 * must be readable by every process, since the bridge consults the anti-raid
 * posture on messages the admin bot never sees.
 */
export interface SafetyStateStore {
  getLockdown(guildId: string): Promise<LockdownStateDTO | null>;
  putLockdown(state: LockdownStateDTO, ttlSeconds: number): Promise<void>;
  clearLockdown(guildId: string): Promise<void>;
  /** Every recorded lockdown, for the expiry sweep. */
  listLockdowns(): Promise<readonly LockdownStateDTO[]>;
  getAntiRaid(guildId: string): Promise<AntiRaidStateDTO | null>;
  putAntiRaid(state: AntiRaidStateDTO, ttlSeconds: number): Promise<void>;
  clearAntiRaid(guildId: string): Promise<void>;
  listAntiRaid(): Promise<readonly AntiRaidStateDTO[]>;
}

/** Resolves a member's platform role for rank-hierarchy checks (defaults MEMBER). */
export interface RankResolver {
  getRole(guildId: string, discordId: string): Promise<MemberRole>;
}

/** Mirrors active enforcement (mute/ban) into Redis for fast bridge/bot checks. */
export interface EnforcementMirror {
  apply(action: ModerationActionDTO): Promise<void>;
}

/** Whether the bot currently has the Discord permission to perform an action. */
export interface BotCapabilities {
  canPerform(guildId: string, type: ModActionType): Promise<boolean>;
}
