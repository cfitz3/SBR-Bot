/**
 * PanelMutations — the write half of the panel core, sibling to PanelService.
 *
 * Kept in its own class rather than added to PanelService because every method
 * here shares a pipeline the reads don't have: authorize → rate-limit → validate
 * → call the *shared domain service* → audit. The panel commands the same
 * services the bots do (WEB_PANEL.md §7) and never reaches around them into the
 * database, so this file holds no SQL and no enforcement logic of its own.
 */
import type {
  AnalyticsService,
  CommunityService,
  ConfigChannelSlot,
  EventType,
  GuildConfigService,
  IdentityService,
  MemberRole,
  ModActionType,
  ModerationService,
  RecruitmentSettings,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { authorizeRole, type AccessDecision, type PanelSession, type RoleResolver } from "./access.js";

/** Every write the panel can perform, and the platform role it requires. */
export const MUTATION_TIERS = {
  "config.channel": "ADMIN",
  "config.role-mapping": "ADMIN",
  "config.feature": "ADMIN",
  "config.recruitment": "ADMIN",
  /** Bridge control is an Officer power in WEB_PANEL.md §2, not an Admin one. */
  "bridge.suspend": "OFFICER",
  /**
   * Staff act within their rank (§3.6). The tier here is the floor; the real
   * limit is ModerationService's own rank check, which refuses a target who
   * outranks the actor — a gate this layer must not try to duplicate.
   */
  "moderation.action": "MODERATOR",
  /** Tickets are explicitly Staff work in §3.7, unlike application decisions. */
  "ticket.close": "MODERATOR",
  "application.decide": "OFFICER",
  /** Events are Officer work in §3.8, both scheduling and calling one off. */
  "event.create": "OFFICER",
  "event.cancel": "OFFICER",
  "member.unlink": "OFFICER",
  /**
   * Admin, though §3.10 says Officer for member edits.
   *
   * Role assignment is the one "member edit" that hands out authority: at
   * Officer tier an officer could promote themselves to ADMIN and reach the
   * config pages. Until the platform grows a rule that bounds an assignment by
   * the actor's own rank, the safe reading of "Officer+ may edit members" is
   * that this particular edit sits one tier higher.
   */
  "member.role": "ADMIN",
} as const satisfies Readonly<Record<string, MemberRole>>;

export type MutationName = keyof typeof MUTATION_TIERS;

export const MUTATION_NAMES = Object.keys(MUTATION_TIERS) as readonly MutationName[];

/**
 * Per-user, per-mutation floor between writes.
 *
 * Short on purpose: this is not a quota, it is a guard against a stuck key or a
 * double-clicked toggle turning into a stream of config writes and pub/sub
 * invalidations. A human editing settings never notices two seconds.
 */
export const MUTATION_COOLDOWN_MS = 2_000;

export type MutationErrorKind =
  | "RATE_LIMITED"
  | "INVALID_INPUT"
  /** The domain service refused or failed; `detail` carries its reason. */
  | "SERVICE_ERROR";

export interface MutationError {
  readonly kind: MutationErrorKind;
  readonly detail?: string;
  /** Present on RATE_LIMITED so the UI can say when, not just "too fast". */
  readonly retryAfterMs?: number;
}

/**
 * Mirrors `PageResult`: the access decision always travels with the outcome, and
 * a denied write carries no result at all. Same shape means the client's
 * envelope handling is one code path for reads and writes alike.
 */
export type MutationResult =
  | { readonly access: Extract<AccessDecision, { allowed: true }>; readonly ok: true; readonly error: null }
  | {
      readonly access: Extract<AccessDecision, { allowed: true }>;
      readonly ok: false;
      readonly error: MutationError;
    }
  | { readonly access: Extract<AccessDecision, { allowed: false }>; readonly ok: false; readonly error: null };

/** Rate-limit gate (the Redis cooldown adapter at wiring time, `cd:web:*`). */
export interface MutationLimiter {
  consume(key: string, ttlMs: number): Promise<{ allowed: boolean; retryAfterMs?: number }>;
}

/**
 * One recorded configuration change.
 *
 * Config writes get their own audit port rather than a `ModerationAction`: that
 * table's `type` enum describes actions taken *on a person*, and widening it to
 * carry "someone changed the bridge channel" would put two unrelated timelines
 * in one place. A durable table can back this later; the port is what makes that
 * a wiring change instead of a rewrite of every call site.
 */
export interface ConfigAuditEntry {
  readonly guildId: string;
  readonly actorDiscordId: string;
  readonly mutation: MutationName;
  /** What was asked for, already validated. Never contains a secret. */
  readonly change: Readonly<Record<string, unknown>>;
  readonly at: string;
}

export interface ConfigAuditSink {
  record(entry: ConfigAuditEntry): Promise<void>;
}

export interface PanelMutationsDeps {
  readonly roles: RoleResolver;
  readonly config: GuildConfigService;
  readonly moderation: ModerationService;
  readonly community: CommunityService;
  readonly identity: IdentityService;
  readonly limiter: MutationLimiter;
  readonly audit: ConfigAuditSink;
  /** Panel writes land in the same usage stream as commands, `surface=WEB_PANEL`. */
  readonly analytics: AnalyticsService;
  readonly logger: Logger;
  /** Injectable clock, so audit timestamps are assertable in tests. */
  readonly now?: () => Date;
}

/** Redis keyspace for panel write limits (REDIS_KEYSPACE.md §1, `cd:web:*`). */
function limiterKey(discordId: string, mutation: MutationName): string {
  return `cd:web:${mutation}:${discordId}`;
}

const CHANNEL_SLOTS: readonly ConfigChannelSlot[] = ["bridge", "staff", "log", "applications", "events"];

const MEMBER_ROLES: readonly MemberRole[] = ["MEMBER", "MODERATOR", "OFFICER", "ADMIN", "OWNER"];

/**
 * Discord snowflakes are 17–20 digits today. Validated by shape rather than by
 * asking Discord: the panel cannot prove a channel exists without the bot's
 * gateway, and rejecting obvious junk here is what keeps a typo from being
 * written into config and silently disabling a feature.
 */
const SNOWFLAKE = /^\d{17,20}$/;

/** Feature flag names are keys in a config JSON blob; keep them boring. */
const FEATURE_NAME = /^[a-z][a-z0-9-]{1,39}$/;

/** Database ids (cuid/uuid). Shape-checked so a lookup miss means "not found". */
const ENTITY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Minecraft uuids, dashed or not, as `unlink` takes them. */
const MC_UUID = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;

/**
 * Moderation actions the panel may issue.
 *
 * `ROLE_CHANGE` and `GUILD_EXPEL` are deliberately absent: those are records
 * written by the flows that perform them (`member.role`, the roster sync), and
 * letting the panel post one by hand would put entries in the audit log that
 * describe something that never happened.
 */
const PANEL_ACTIONS: readonly ModActionType[] = ["WARN", "NOTE", "MUTE", "UNMUTE", "KICK", "BAN", "UNBAN"];

/** Actions where a duration is meaningful; everything else is instantaneous. */
const TIMED_ACTIONS: readonly ModActionType[] = ["MUTE", "BAN"];

/** A year. Longer than any real mute, and short enough to catch a ms/s mix-up. */
const MAX_DURATION_SECONDS = 365 * 24 * 60 * 60;

const REASON_MAX = 500;

/** Event types the schema knows; anything else is a typo, not a new category. */
const EVENT_TYPES: readonly EventType[] = [
  "DUNGEON",
  "SLAYER",
  "FISHING",
  "MINING",
  "GIVEAWAY",
  "MEETING",
  "CUSTOM",
];

/** Long enough for "Catacombs F7 carry night", short enough to fit a table cell. */
const EVENT_TITLE_MAX = 120;

const DESCRIPTION_MAX = 2_000;

/** A guild-sized ceiling. The floor (≥ 1) is CommunityService's own rule. */
const MAX_CAPACITY = 1_000;

/**
 * Roles assignable from the panel.
 *
 * OWNER is excluded: it is the one role that can never be taken back by anyone
 * else here, and platform ownership should follow the Discord guild's owner
 * rather than a checkbox in a web form.
 */
const ASSIGNABLE_ROLES: readonly MemberRole[] = ["MEMBER", "MODERATOR", "OFFICER", "ADMIN"];

export class PanelMutations {
  private readonly d: PanelMutationsDeps;
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(deps: PanelMutationsDeps) {
    this.d = deps;
    this.log = deps.logger.child({ service: "panel-mutations" });
    this.now = deps.now ?? (() => new Date());
  }

  // ─────────────────────────── config ───────────────────────────

  async setChannel(
    session: PanelSession | null,
    guildId: string,
    slot: unknown,
    channelId: unknown,
  ): Promise<MutationResult> {
    return this.run(session, guildId, "config.channel", async () => {
      if (typeof slot !== "string" || !CHANNEL_SLOTS.includes(slot as ConfigChannelSlot)) {
        return invalid(`slot must be one of ${CHANNEL_SLOTS.join(", ")}`);
      }
      // null clears the slot; anything else must look like a channel id.
      if (channelId !== null && (typeof channelId !== "string" || !SNOWFLAKE.test(channelId))) {
        return invalid("channelId must be a Discord id or null");
      }
      const result = await this.d.config.setChannel(guildId, slot as ConfigChannelSlot, channelId);
      return { result, change: { slot, channelId } };
    });
  }

  async setRoleMapping(
    session: PanelSession | null,
    guildId: string,
    role: unknown,
    discordRoleId: unknown,
  ): Promise<MutationResult> {
    return this.run(session, guildId, "config.role-mapping", async () => {
      if (typeof role !== "string" || !MEMBER_ROLES.includes(role as MemberRole)) {
        return invalid(`role must be one of ${MEMBER_ROLES.join(", ")}`);
      }
      if (discordRoleId !== null && (typeof discordRoleId !== "string" || !SNOWFLAKE.test(discordRoleId))) {
        return invalid("discordRoleId must be a Discord id or null");
      }
      const result = await this.d.config.setRoleMapping(guildId, role as MemberRole, discordRoleId);
      return { result, change: { role, discordRoleId } };
    });
  }

  async setFeature(
    session: PanelSession | null,
    guildId: string,
    feature: unknown,
    enabled: unknown,
  ): Promise<MutationResult> {
    return this.run(session, guildId, "config.feature", async () => {
      if (typeof feature !== "string" || !FEATURE_NAME.test(feature)) {
        return invalid("feature must be a short lowercase name");
      }
      if (typeof enabled !== "boolean") return invalid("enabled must be a boolean");

      const result = await this.d.config.setFeature(guildId, feature, enabled);
      return { result, change: { feature, enabled } };
    });
  }

  async setBridgeSuspended(
    session: PanelSession | null,
    guildId: string,
    suspended: unknown,
  ): Promise<MutationResult> {
    return this.run(session, guildId, "bridge.suspend", async () => {
      if (typeof suspended !== "boolean") return invalid("suspended must be a boolean");

      const result = await this.d.config.setBridgeSuspended(guildId, suspended);
      return { result, change: { suspended } };
    });
  }

  async setRecruitment(
    session: PanelSession | null,
    guildId: string,
    input: unknown,
  ): Promise<MutationResult> {
    return this.run(session, guildId, "config.recruitment", async () => {
      if (typeof input !== "object" || input === null) return invalid("body must be an object");
      const body = input as Record<string, unknown>;

      if (typeof body["open"] !== "boolean") return invalid("open must be a boolean");
      // Tri-state, as RecruitmentSettings documents: absent leaves the bar
      // alone, null clears it, a number sets it. Collapsing absent into null
      // here would wipe a guild's entry bar every time someone toggled
      // applications open.
      const minWeight = threshold(body, "minWeight");
      const minNetworth = threshold(body, "minNetworth");
      if (minWeight === INVALID || minNetworth === INVALID) {
        return invalid("minWeight and minNetworth must be a non-negative number or null");
      }

      const settings: RecruitmentSettings = {
        open: body["open"],
        ...(minWeight === ABSENT ? {} : { minWeight }),
        ...(minNetworth === ABSENT ? {} : { minNetworth }),
      };
      const result = await this.d.config.setRecruitment(guildId, settings);
      return { result, change: { ...settings } };
    });
  }

  // ─────────────────────────── moderation ───────────────────────────

  /**
   * Issue a moderation action against a member.
   *
   * Rank is not checked here. `ModerationService.applyAction` already refuses a
   * target who outranks the actor, and re-implementing that comparison in the
   * panel would create a second rule to keep in step with the first — the exact
   * drift that lets one surface permit what the other forbids.
   */
  async applyModeration(
    session: PanelSession | null,
    guildId: string,
    input: unknown,
  ): Promise<MutationResult> {
    return this.run(session, guildId, "moderation.action", async (actorDiscordId) => {
      if (typeof input !== "object" || input === null) return invalid("body must be an object");
      const body = input as Record<string, unknown>;

      const type = body["type"];
      if (typeof type !== "string" || !PANEL_ACTIONS.includes(type as ModActionType)) {
        return invalid(`type must be one of ${PANEL_ACTIONS.join(", ")}`);
      }
      const target = body["targetDiscordId"];
      if (typeof target !== "string" || !SNOWFLAKE.test(target)) {
        return invalid("targetDiscordId must be a Discord id");
      }
      const reason = typeof body["reason"] === "string" ? body["reason"].trim() : "";
      // Required, not defaulted: an audit row reading "no reason given" is worse
      // than a refused write, because it is permanent and unattributable.
      if (reason.length === 0) return invalid("a reason is required");
      if (reason.length > REASON_MAX) return invalid(`reason must be under ${REASON_MAX} characters`);

      const raw = body["durationSeconds"];
      let durationSeconds: number | null = null;
      if (raw !== undefined && raw !== null) {
        if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0 || raw > MAX_DURATION_SECONDS) {
          return invalid(`durationSeconds must be a whole number of seconds under ${MAX_DURATION_SECONDS}`);
        }
        if (!TIMED_ACTIONS.includes(type as ModActionType)) {
          return invalid(`${type} does not take a duration`);
        }
        durationSeconds = raw;
      }

      const result = await this.d.moderation.applyAction({
        guildId,
        type: type as ModActionType,
        actorDiscordId,
        targetDiscordId: target,
        reason,
        durationSeconds,
      });
      return { result, change: { type, targetDiscordId: target, reason, durationSeconds } };
    });
  }

  // ─────────────────────────── recruitment ───────────────────────────

  async decideApplication(
    session: PanelSession | null,
    guildId: string,
    applicationId: unknown,
    accept: unknown,
    reason: unknown,
  ): Promise<MutationResult> {
    return this.run(session, guildId, "application.decide", async (actorDiscordId) => {
      if (typeof applicationId !== "string" || !ENTITY_ID.test(applicationId)) {
        return invalid("applicationId must be an application id");
      }
      if (typeof accept !== "boolean") return invalid("accept must be a boolean");
      const note = typeof reason === "string" ? reason.trim() : "";
      // A rejection is the one the applicant reads, so it must carry a why.
      if (!accept && note.length === 0) return invalid("a reason is required when rejecting");
      if (note.length > REASON_MAX) return invalid(`reason must be under ${REASON_MAX} characters`);

      const result = await this.d.community.decideApplication({
        applicationId,
        reviewerDiscordId: actorDiscordId,
        accept,
        reason: note.length === 0 ? null : note,
      });
      return { result, change: { applicationId, accept, reason: note || null } };
    });
  }

  async closeTicket(
    session: PanelSession | null,
    guildId: string,
    ticketId: unknown,
    reason: unknown,
  ): Promise<MutationResult> {
    return this.run(session, guildId, "ticket.close", async (actorDiscordId) => {
      if (typeof ticketId !== "string" || !ENTITY_ID.test(ticketId)) {
        return invalid("ticketId must be a ticket id");
      }
      const note = typeof reason === "string" ? reason.trim() : "";
      if (note.length > REASON_MAX) return invalid(`reason must be under ${REASON_MAX} characters`);

      const result = await this.d.community.closeTicket(ticketId, actorDiscordId, note.length === 0 ? null : note);
      return { result, change: { ticketId, reason: note || null } };
    });
  }

  // ─────────────────────────── events ───────────────────────────

  /**
   * Schedule an event, hosted by whoever is signed in.
   *
   * The host is taken from the session rather than the body because the host is
   * the person `cancelEvent` later checks against: letting the form name someone
   * else would create events their supposed host cannot call off.
   *
   * "In the past" is not checked here — `CommunityService.createEvent` owns that
   * rule along with the capacity floor, and its `detail` is what the panel shows.
   */
  async createEvent(session: PanelSession | null, guildId: string, input: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "event.create", async (actorDiscordId) => {
      if (typeof input !== "object" || input === null) return invalid("body must be an object");
      const body = input as Record<string, unknown>;

      const title = typeof body["title"] === "string" ? body["title"].trim() : "";
      if (title.length === 0) return invalid("a title is required");
      if (title.length > EVENT_TITLE_MAX) return invalid(`title must be under ${EVENT_TITLE_MAX} characters`);

      const type = body["type"];
      if (typeof type !== "string" || !EVENT_TYPES.includes(type as EventType)) {
        return invalid(`type must be one of ${EVENT_TYPES.join(", ")}`);
      }

      const startsAt = body["startsAt"];
      if (typeof startsAt !== "string" || Number.isNaN(Date.parse(startsAt))) {
        return invalid("startsAt must be a date and time");
      }

      const rawCapacity = body["capacity"];
      let capacity: number | null = null;
      if (rawCapacity !== undefined && rawCapacity !== null) {
        if (
          typeof rawCapacity !== "number" ||
          !Number.isInteger(rawCapacity) ||
          rawCapacity < 1 ||
          rawCapacity > MAX_CAPACITY
        ) {
          return invalid(`capacity must be a whole number between 1 and ${MAX_CAPACITY}`);
        }
        capacity = rawCapacity;
      }

      const rawDescription = typeof body["description"] === "string" ? body["description"].trim() : "";
      if (rawDescription.length > DESCRIPTION_MAX) {
        return invalid(`description must be under ${DESCRIPTION_MAX} characters`);
      }
      const description = rawDescription.length === 0 ? null : rawDescription;

      const result = await this.d.community.createEvent({
        guildId,
        title,
        startsAt: new Date(startsAt).toISOString(),
        type: type as EventType,
        hostDiscordId: actorDiscordId,
        description,
        capacity,
      });
      return { result, change: { title, type, startsAt, capacity, description } };
    });
  }

  /**
   * Call an event off.
   *
   * `CommunityService.cancelEvent` refuses anyone but the host, so an Officer
   * cancelling a colleague's event gets NOT_HOST back. That limit is deliberate
   * and lives there; the panel surfaces the refusal rather than working around it.
   */
  async cancelEvent(session: PanelSession | null, guildId: string, eventId: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "event.cancel", async (actorDiscordId) => {
      if (typeof eventId !== "string" || !ENTITY_ID.test(eventId)) {
        return invalid("eventId must be an event id");
      }
      const result = await this.d.community.cancelEvent(eventId, actorDiscordId);
      return { result, change: { eventId } };
    });
  }

  // ─────────────────────────── members ───────────────────────────

  async setMemberRole(
    session: PanelSession | null,
    guildId: string,
    discordId: unknown,
    role: unknown,
  ): Promise<MutationResult> {
    return this.run(session, guildId, "member.role", async (actorDiscordId) => {
      if (typeof discordId !== "string" || !SNOWFLAKE.test(discordId)) {
        return invalid("discordId must be a Discord id");
      }
      if (typeof role !== "string" || !ASSIGNABLE_ROLES.includes(role as MemberRole)) {
        return invalid(`role must be one of ${ASSIGNABLE_ROLES.join(", ")}`);
      }
      // Self-demotion is the realistic accident here — an admin dropping their
      // own tier locks themselves out of the page they did it from.
      if (discordId === actorDiscordId) return invalid("you cannot change your own role from the panel");

      const result = await this.d.community.setMemberRole(guildId, discordId, role as MemberRole);
      return { result, change: { discordId, role } };
    });
  }

  /**
   * Detach a Minecraft account from a Discord user.
   *
   * The uuid is required rather than inferred: a member may have more than one
   * linked account, and "unlink whatever is primary" is not something staff can
   * see the consequences of before clicking.
   */
  async unlinkMember(
    session: PanelSession | null,
    guildId: string,
    discordId: unknown,
    minecraftUuid: unknown,
  ): Promise<MutationResult> {
    return this.run(session, guildId, "member.unlink", async () => {
      if (typeof discordId !== "string" || !SNOWFLAKE.test(discordId)) {
        return invalid("discordId must be a Discord id");
      }
      if (typeof minecraftUuid !== "string" || !MC_UUID.test(minecraftUuid)) {
        return invalid("minecraftUuid must be a Minecraft uuid");
      }
      const result = await this.d.identity.unlink(discordId, minecraftUuid);
      return { result, change: { discordId, minecraftUuid } };
    });
  }

  // ─────────────────────────── pipeline ───────────────────────────

  /**
   * The shared write pipeline. `body` runs only once the caller is authorized
   * and under the rate limit, and its validation happens before the service call
   * so a rejected write never reaches the database or the audit trail.
   *
   * The actor's id is handed to `body` rather than read from the session by each
   * caller, so a mutation cannot accidentally attribute an action to anyone but
   * the authenticated user.
   *
   * Usage is captured for *every* authorized attempt, failures included — a
   * panel that only records its successes hides exactly the pattern (a wave of
   * refused writes) worth noticing.
   */
  private async run(
    session: PanelSession | null,
    guildId: string,
    mutation: MutationName,
    body: (actorDiscordId: string) => Promise<Step>,
  ): Promise<MutationResult> {
    const startedAt = Date.now();
    // Checked here as well as inside authorizeRole so the actor's id is a plain
    // string below rather than a non-null assertion on a narrowing the type
    // system can't see through.
    if (!session) {
      return { access: { allowed: false, reason: "NOT_AUTHENTICATED" }, ok: false, error: null };
    }
    const access = await authorizeRole(session, guildId, MUTATION_TIERS[mutation], this.d.roles);
    if (!access.allowed) {
      this.log.warn("panel write denied", { mutation, guildId, reason: access.reason });
      return { access, ok: false, error: null };
    }
    const actorDiscordId = session.discordId;

    const gate = await this.d.limiter.consume(limiterKey(actorDiscordId, mutation), MUTATION_COOLDOWN_MS);
    if (!gate.allowed) {
      return this.fail(access, mutation, guildId, actorDiscordId, startedAt, {
        kind: "RATE_LIMITED",
        ...(gate.retryAfterMs === undefined ? {} : { retryAfterMs: gate.retryAfterMs }),
      });
    }

    const step = await body(actorDiscordId);
    if ("error" in step) {
      return this.fail(access, mutation, guildId, actorDiscordId, startedAt, step.error);
    }
    if (!step.result.ok) {
      // The domain service refused. Its reason is already logged there; what
      // this layer adds is that a panel write was the thing that asked.
      return this.fail(access, mutation, guildId, actorDiscordId, startedAt, {
        kind: "SERVICE_ERROR",
        detail: describe(step.result.error),
      });
    }

    const at = this.now().toISOString();
    await this.d.audit.record({ guildId, actorDiscordId, mutation, change: step.change, at });
    await this.capture(mutation, guildId, actorDiscordId, true, startedAt, at);
    this.log.info("panel write applied", { mutation, guildId, actor: actorDiscordId, change: step.change });

    return { access, ok: true, error: null };
  }

  private async fail(
    access: Extract<AccessDecision, { allowed: true }>,
    mutation: MutationName,
    guildId: string,
    actorDiscordId: string,
    startedAt: number,
    error: MutationError,
  ): Promise<MutationResult> {
    await this.capture(mutation, guildId, actorDiscordId, false, startedAt, this.now().toISOString());
    this.log.warn("panel write refused", { mutation, guildId, actor: actorDiscordId, reason: error.kind });
    return { access, ok: false, error };
  }

  private async capture(
    command: MutationName,
    guildId: string,
    discordId: string,
    success: boolean,
    startedAt: number,
    invokedAt: string,
  ): Promise<void> {
    await this.d.analytics.capture({
      guildId,
      discordId,
      surface: "WEB_PANEL",
      command,
      success,
      latencyMs: Date.now() - startedAt,
      invokedAt,
    });
  }
}

/**
 * What one mutation body reports: either a validation refusal, or the domain
 * service's own Result plus the change to write to the audit trail.
 */
type Step =
  | { readonly error: MutationError }
  | {
      readonly result: { readonly ok: true } | { readonly ok: false; readonly error: unknown };
      readonly change: Readonly<Record<string, unknown>>;
    };

function invalid(detail: string): Step {
  return { error: { kind: "INVALID_INPUT", detail } };
}

/** Domain errors are tagged unions or Errors; either way the audit wants a word. */
function describe(error: unknown): string {
  if (error && typeof error === "object" && "kind" in error && typeof error.kind === "string") {
    return error.kind;
  }
  if (error instanceof Error) return error.message;
  return "unknown";
}

// Sentinels for the tri-state thresholds. Distinct objects rather than
// undefined/null, because both of those are meaningful *values* here.
const ABSENT = Symbol("absent");
const INVALID = Symbol("invalid");

function threshold(body: Record<string, unknown>, key: string): number | null | typeof ABSENT | typeof INVALID {
  if (!(key in body) || body[key] === undefined) return ABSENT;
  const value = body[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return INVALID;
  return value;
}
