/**
 * Ports for the moderation core. Implemented over @sbr/db (audit tables) and
 * @sbr/redis (enforcement mirror) at wiring time; faked in tests.
 */
import type { PackSelection } from "./wordlist-packs.js";
import type {
  AntiRaidStateDTO,
  EnforcementAttemptDTO,
  EnforcementStatus,
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

/**
 * A sparse correction to an existing case.
 *
 * Every field is optional and `undefined` means "leave it alone", so the panel
 * can write one field at a time without reading and re-posting the rest of the
 * case; `null` where the type allows it is a real value, meaning "clear this".
 * `editedByDiscordId` is not optional: the store stamps it on every write,
 * because a case that changed with no author beside the change is a rumour.
 */
export interface ModerationActionPatch {
  readonly reason?: string;
  readonly durationSeconds?: number | null;
  readonly expiresAt?: string | null;
  readonly active?: boolean;
  readonly enforcement?: EnforcementStatus;
  readonly enforcementDetail?: string | null;
  readonly voidedAt?: string | null;
  readonly voidReason?: string | null;
  readonly editedByDiscordId: string;
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
  /**
   * Record what became of the enforcement attempt for one action.
   *
   * Written after the fact rather than passed to `createAction`, because the
   * row has to exist before anything is attempted: an enforcement that crashes
   * the process must leave evidence behind, and a row written only on success
   * leaves none.
   *
   * `attempt` is the 1-based count of tries this row has now had; passing it
   * also stamps the attempt time, which is what the sweep measures staleness
   * from. It is omitted when a person sets the status by hand, because a
   * correction is not an attempt and must not spend one of the retries.
   */
  setEnforcement(
    actionId: string,
    status: EnforcementStatus,
    detail: string | null,
    attempt?: number,
  ): Promise<void>;
  /**
   * Append what one surface said about one attempt.
   *
   * The case row carries only the current verdict, and the question staff ask
   * when enforcement goes wrong is what Hypixel said and when. Append-only, and
   * implementations swallow their own errors: losing the note must never fail
   * the punishment it is a note about.
   */
  recordEnforcementAttempt(input: {
    readonly actionId: string;
    readonly attempt: number;
    readonly surface: "DISCORD" | "GAME";
    readonly outcome: string;
    readonly detail: string | null;
  }): Promise<void>;
  /** The attempt log for one case, oldest first. */
  listEnforcementAttempts(actionId: string, limit?: number): Promise<readonly EnforcementAttemptDTO[]>;
  /**
   * Punishments whose clock has run out but which are still flagged active —
   * the ones a sweep has to *reverse*, not merely un-flag. Returned newest
   * first and capped, since the sweep issues an API call per row.
   */
  listExpiredActive(guildId: string | null, now: Date, limit: number): Promise<readonly ModerationActionDTO[]>;
  /**
   * Punishments still waiting on an answer long after anyone could arrive.
   *
   * A row goes PENDING when the guild command was sent and the guild said
   * nothing back inside the wait. That is a fair reading for fifteen seconds
   * and a lie long after: by then either nothing is coming or the attempt was
   * lost, and a case that still reads "pending" is a ban nobody has been told
   * did not happen.
   *
   * Staleness is measured from the last attempt rather than from the case's
   * creation, so a row the sweep has already retried is given the same grace
   * over again instead of being judged against the moment it was written.
   */
  listStalePending(before: Date, limit: number): Promise<readonly ModerationActionDTO[]>;
  /**
   * Correct a case in place, guild-scoped. Null when no row in this guild has
   * that id — an id from another guild must read as "no such case", never as a
   * cross-guild write.
   */
  updateAction(
    guildId: string,
    actionId: string,
    patch: ModerationActionPatch,
  ): Promise<ModerationActionDTO | null>;
  /**
   * One action by its case id, scoped to the guild asking.
   *
   * Guild-scoped rather than a bare lookup because a case id is quoted in
   * public - it goes in a command reply, a mod-log card and an appeal ticket -
   * and an id from one guild must not read another guild's moderation history.
   */
  findAction(guildId: string, actionId: string): Promise<ModerationActionDTO | null>;
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
/**
 * Port: which packaged lists a guild has switched on.
 *
 * Separate from `WordlistRepository` because it is a setting rather than a
 * table, and optional on every consumer: a deployment that never wires it sees
 * exactly the guild's own rules, which is what every deployment saw before
 * packs existed.
 */
export interface WordlistPackSource {
  selection(guildId: string): Promise<PackSelection>;
}

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

/**
 * How an enforcement attempt ended.
 *
 * `skipped` is not a failure and not a success: it is "this action has no
 * counterpart on that surface", which is the true answer for a note reaching
 * Discord or a ban reaching a guild the target was never in. Keeping it
 * distinct from `ok` is what stops the audit row claiming a punishment landed
 * somewhere nothing was ever sent.
 */
export type EnforcementOutcome =
  | { readonly ok: true }
  | { readonly ok: true; readonly skipped: true; readonly reason: string }
  /**
   * Handed over, and not yet answered for.
   *
   * Only the guild-chat leg produces this. The command reached the bridge and
   * the bridge is expected to type it, but nothing has come back within the
   * wait — a paced backlog, or a Hypixel that printed nothing we recognised.
   * Calling that a success would repeat the bug this whole surface exists to
   * close; calling it a failure would alert staff every time the queue is
   * busy. It leaves the row PENDING for the sweep to settle or escalate.
   */
  | { readonly ok: true; readonly pending: true; readonly reason: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Port: the Discord API call that actually punishes somebody.
 *
 * Deliberately separate from `EnforcementMirror`. The mirror is a cache the
 * bridge and the dispatchers read; this is the thing that removes a person from
 * a server. They were conflated for long enough that the admin bot wired only
 * the mirror and `/ban` banned nobody while reporting success — so the port
 * that performs the punishment now has its own name, its own outcome type, and
 * a return value the service is obliged to look at.
 *
 * Optional at the composition root, but a deployment that omits it gets every
 * Discord-enforced action recorded as `FAILED` with `no Discord enforcer
 * wired`, rather than recorded as though it worked.
 */
export interface DiscordEnforcer {
  enforce(action: ModerationActionDTO): Promise<EnforcementOutcome>;
}

/**
 * Port: somewhere staff will actually see that an enforcement did not happen.
 *
 * A log line is not this. The failure mode being closed here is a punishment
 * that silently did not take, and a warning in a log file nobody tails is the
 * same silence with extra steps. Implementations post to the guild's staff
 * channel.
 */
export interface StaffAlertSink {
  alert(guildId: string, text: string): Promise<void>;
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
export type GameCommandOutcome =
  /** Hypixel printed the notice this command was supposed to produce. */
  | "CONFIRMED_INGAME"
  /** Hypixel printed a refusal instead. Named in `detail`. */
  | "REFUSED_INGAME"
  /** The bridge typed it. Hypixel said nothing we recognised either way. */
  | "UNCONFIRMED"
  /** No Minecraft session, so there was nowhere to type it. */
  | "NO_SESSION"
  /** A bridge answered, but it is not this guild's bridge. */
  | "WRONG_GUILD"
  /** The outbound queue was full; the command was refused, not delayed. */
  | "REFUSED_BACKLOG"
  /** It sat in the queue past its useful life and was discarded untyped. */
  | "EXPIRED"
  /** Nothing came back inside the wait. Still possible it lands. */
  | "TIMED_OUT";

/** What became of one guild command, in the words of whoever found out. */
export interface GameCommandReceipt {
  readonly outcome: GameCommandOutcome;
  /** The guild-chat line that settled it, or why it never got typed. */
  readonly detail: string;
}

export interface GameCommandBus {
  /**
   * Returns what became of the command, not whether it was published.
   *
   * This used to be `Promise<void>`, then `Promise<boolean>`, and both were a
   * lie in the case that mattered. The production implementation is a Redis
   * publish; pub/sub has no store-and-forward, so publishing to a channel with
   * no subscriber succeeds and drops the message. A `/g kick` for a banned
   * member vanished exactly that way. `true` then meant "a heartbeat said a
   * bridge was alive up to 45 seconds ago", which is not the same as "Hypixel
   * ran it" — so implementations now wait for the bridge to answer for it.
   */
  send(guildId: string, command: string): Promise<GameCommandReceipt>;
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
