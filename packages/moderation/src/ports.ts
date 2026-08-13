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
  WordlistRuleUpdate,
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
  /**
   * Which surface the action was issued on. Omitted means DISCORD, which is
   * what every platform-issued action is; INGAME is written only by the bridge
   * when it reconstructs an action from Hypixel's own guild-chat notices.
   */
  readonly sourceContext?: "BRIDGE" | "DISCORD" | "INGAME";
}

export interface ModerationRepository {
  createInfraction(input: Omit<InfractionDTO, "id" | "createdAt">): Promise<InfractionDTO>;
  createAction(input: NewActionRecord): Promise<ModerationActionDTO>;
  listInfractions(guildId: string, discordId: string): Promise<readonly InfractionDTO[]>;
  /** Guild-wide, newest first — the moderation page's default view. */
  listRecentInfractions(guildId: string, limit: number): Promise<readonly InfractionDTO[]>;
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

/**
 * Port: where a guild's escalation policy is stored.
 *
 * Deliberately `unknown` rather than a typed policy. It is a `GuildSetting` KV
 * row — hand-editable JSON that predates any validation we might add — so the
 * shape is checked by `parsePolicy` at the moment of use, in one place, rather
 * than trusted at the boundary of every implementation of this port.
 */
export interface EscalationPolicySource {
  readPolicy(guildId: string): Promise<unknown>;
}

/**
 * Port: where a guild's automod policy is stored. Same `unknown` posture as the
 * escalation source and for the same reason — it is a hand-editable KV row, and
 * `parseAutomod` is the one place its shape is decided.
 */
export interface AutomodPolicySource {
  readPolicy(guildId: string): Promise<unknown>;
}

/**
 * Port: the windowed counters behind the spam and repeat triggers.
 *
 * Reading bumps: the message being judged belongs in its own window. Keyed by
 * rule id because two rules with different windows are two separate counts.
 */
export interface AutomodCounterStore {
  read(
    guildId: string,
    author: string,
    text: string,
    requests: readonly { ruleId: string; kind: "spam" | "repeat"; windowSeconds: number }[],
  ): Promise<Readonly<Record<string, number>>>;
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
  /** Null when the guild has no rule with that id. */
  update(guildId: string, id: string, patch: WordlistRuleUpdate): Promise<WordlistRuleDTO | null>;
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

/**
 * Resolves a member's platform role for rank-hierarchy checks.
 *
 * Null means "not a member of this guild". For an actor that is a refusal; for
 * a target it is the weakest possible standing, so anyone may act on them.
 */
export interface RankResolver {
  getRole(guildId: string, discordId: string): Promise<MemberRole | null>;
}

/** Mirrors active enforcement (mute/ban) into Redis for fast bridge/bot checks. */
export interface EnforcementMirror {
  apply(action: ModerationActionDTO): Promise<void>;
}

/** Whether the bot currently has the Discord permission to perform an action. */
export interface BotCapabilities {
  canPerform(guildId: string, type: ModActionType): Promise<boolean>;
}

/**
 * Port: where a guild's relay-sync mapping is stored.
 *
 * `unknown` for the same reason `EscalationPolicySource` is: it is a
 * hand-editable `GuildSetting` KV row, so the shape is checked by
 * `parseRelaySync` at the moment of use rather than trusted at every boundary.
 */
export interface RelaySyncSource {
  readRelaySync(guildId: string): Promise<unknown>;
}

/**
 * Port: sends a line to guild chat as the bridge account.
 *
 * Only the bridge process holds the Minecraft socket, so in production this is a
 * Redis publish that the bridge drains through its own rate-limited queue. The
 * moderation core knows nothing about either — it hands over a command and does
 * not wait to see it land, because a punishment that was recorded and enforced
 * in Discord must not be rolled back by a bridge that happens to be offline.
 */
export interface GameCommandBus {
  send(guildId: string, command: string): Promise<void>;
}

/**
 * Port: the target's in-game name, for the guild command that needs it.
 *
 * Null when they have no verified link. That is a normal outcome, not an error:
 * plenty of Discord members are not in the guild.
 */
export interface IgnResolver {
  ignFor(guildId: string, discordId: string): Promise<string | null>;
}
