/**
 * PanelMutations — the write half of the panel core, sibling to PanelService.
 *
 * Kept in its own class rather than added to PanelService because every method
 * here shares a pipeline the reads don't have: authorize → rate-limit → validate
 * → call the *shared domain service* → audit. The panel commands the same
 * services the bots do (WEB_PANEL.md §7) and never reaches around them into the
 * database, so this file holds no SQL and no enforcement logic of its own.
 */
import {
  CONFIG_CHANNEL_SLOTS,
  isConfigChannelSlot,
  isMilestoneMetric,
  MILESTONE_METRICS,
  MilestoneType as MILESTONE_TYPES,
} from "@sbr/shared-types";
import type {
  AnalyticsService,
  CommunityService,
  ConfigChannelSlot,
  EventType,
  GuildConfigService,
  IdentityService,
  MemberRole,
  MilestoneDefinitionInput,
  MilestoneDefinitionService,
  MilestoneType,
  ModActionType,
  ModerationService,
  RecruitmentSettings,
  XpService,
  XpSource,
  XpSourcePolicyDTO,
} from "@sbr/shared-types";
import { SCREENING_POLICY_KEY, serializePolicy, type ScreeningPolicy } from "@sbr/screening";
import type { Logger } from "@sbr/observability";
import { authorizeRole, type AccessDecision, type PanelSession, type RoleResolver } from "./access.js";
import { XP_SOURCE_ORDER } from "./service.js";

/** Every write the panel can perform, and the platform role it requires. */
export const MUTATION_TIERS = {
  "config.channel": "ADMIN",
  /**
   * Free-form admin config (embed templates, per-feature payloads). Admin
   * rather than Officer because the keys are not enumerable here: this one
   * mutation is the write path for every setting a later feature invents, so
   * its tier has to be the highest any of them would need.
   */
  "config.setting": "ADMIN",
  "config.role-mapping": "ADMIN",
  "config.feature": "ADMIN",
  "config.recruitment": "ADMIN",
  /**
   * The join-screening policy. Stored under the same `GuildSetting` row
   * `config.setting` could write, but given its own mutation because this is
   * the one setting whose contents decide whether a stranger is let into the
   * guild without a human looking: it earns a validated, named surface rather
   * than an opaque JSON blob.
   */
  "config.screening": "ADMIN",
  /**
   * XP source weights and anti-abuse limits, and hand-written ledger
   * adjustments. Both are Admin because the XP page itself is Admin: a write
   * reachable only from a page an Officer cannot open would be a tier nobody
   * could exercise, and the two settings decide what the whole guild's
   * standing means rather than what one member's does.
   */
  "xp.source": "ADMIN",
  "xp.adjust": "ADMIN",
  /**
   * What the guild recognises as a milestone, and what reaching one pays.
   * Admin because a definition carries an XP reward: at a lower tier this
   * would be a way to mint standing without the XP page's gate.
   */
  "milestone.upsert": "ADMIN",
  "milestone.remove": "ADMIN",
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
  /**
   * Optional for the same reason the read side is: a deployment can run with
   * XP switched off, and the page then says so. A missing service refuses the
   * write rather than crashing the request.
   */
  readonly xp?: XpService;
  /** Optional like XP: absent refuses the write instead of crashing. */
  readonly milestones?: MilestoneDefinitionService;
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

const MEMBER_ROLES: readonly MemberRole[] = ["MEMBER", "MODERATOR", "OFFICER", "ADMIN", "OWNER"];

/**
 * Discord snowflakes are 17–20 digits today. Validated by shape rather than by
 * asking Discord: the panel cannot prove a channel exists without the bot's
 * gateway, and rejecting obvious junk here is what keeps a typo from being
 * written into config and silently disabling a feature.
 */
const SNOWFLAKE = /^\d{17,20}$/;

/** Definition keys are ours to shape: lowercase, with `:` grouping a family. */
const MILESTONE_KEY = /^[a-z0-9]+(?:[.:-][a-z0-9]+)*$/;
const MILESTONE_LABEL_MAX = 80;
const MILESTONE_DESC_MAX = 500;
/** A reward big enough to matter, small enough not to rewrite the leaderboard. */
const MAX_MILESTONE_REWARD = 1_000_000;

/** Feature flag names are keys in a config JSON blob; keep them boring. */
const FEATURE_NAME = /^[a-z][a-z0-9-]{1,39}$/;

/**
 * Admin setting keys: a dotted namespace, e.g. `tickets.panel`, `xp.weights`.
 *
 * Deliberately not a closed list. A setting exists because some feature stores
 * a payload under a name it owns, and enumerating them here would mean every
 * new feature had to edit this file to become configurable. The shape rule is
 * what stops a caller writing a key it can never read back.
 */
const SETTING_KEY = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){0,3}$/;

/**
 * Ceiling on one stored setting, in characters of JSON.
 *
 * These land in a single row read on the config path, so a setting is meant to
 * be a template or a small table — not a place to park a member list. 64 KiB is
 * far above anything the platform stores and far below anything that would make
 * a config read expensive.
 */
const SETTING_MAX_CHARS = 64 * 1024;

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

/**
 * Bounds on an XP source's weight.
 *
 * Fractional and small at the top end, because the raw values these multiply
 * differ by orders of magnitude: GEXP arrives in the thousands per day and
 * wants a weight well under one, while a message is a single unit and wants a
 * weight above it. A ceiling of 1000 is far past any sane setting and still
 * catches the accident this guards against — a weight typed into the cap field
 * or a stray extra zero turning one member's chatter into a permanent lead.
 */
const MAX_SOURCE_WEIGHT = 1_000;

/** A day's ceiling for one member from one source. Generous; not unbounded. */
const MAX_DAILY_CAP = 1_000_000;

/** A day. Anything longer is a disabled source expressed the confusing way. */
const MAX_COOLDOWN_SEC = 24 * 60 * 60;

/** Message length gate. Above this a source would count nothing anyone types. */
const MAX_MIN_LENGTH = 500;

/**
 * Ceiling on one hand-written ledger adjustment, either direction.
 *
 * Adjustments exist to correct a mistake or to pay out an event, not to seed a
 * standing from nothing — and unlike every other award on the ledger, nothing
 * derived this one from an activity that can be re-counted, so an error here is
 * only ever fixed by a second adjustment somebody has to notice first.
 */
const MAX_ADJUSTMENT = 1_000_000;

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
      // The registry in shared-types is the one list: what the API accepts and
      // what the UI renders are the same set, so a slot cannot exist as a
      // control that saves into a rejection.
      if (!isConfigChannelSlot(slot)) {
        return invalid(`slot must be one of ${CONFIG_CHANNEL_SLOTS.join(", ")}`);
      }
      // null clears the slot; anything else must look like a channel id.
      if (channelId !== null && (typeof channelId !== "string" || !SNOWFLAKE.test(channelId))) {
        return invalid("channelId must be a Discord id or null");
      }
      const result = await this.d.config.setChannel(guildId, slot, channelId);
      return { result, change: { slot, channelId } };
    });
  }

  /**
   * Write one free-form admin setting.
   *
   * The value is opaque to this layer — its shape belongs to whichever feature
   * owns the key, and validating it here would put two copies of that shape in
   * the codebase. What is enforced is what is true of *every* setting: a
   * well-formed key, and a value that round-trips through JSON at a sane size.
   */
  async setSetting(
    session: PanelSession | null,
    guildId: string,
    key: unknown,
    value: unknown,
  ): Promise<MutationResult> {
    return this.run(session, guildId, "config.setting", async () => {
      if (typeof key !== "string" || !SETTING_KEY.test(key)) {
        return invalid("key must be a dotted lowercase name, e.g. tickets.panel");
      }
      if (value === undefined) return invalid("value is required; send null to clear the setting");

      let encoded: string;
      try {
        // Catches cycles and non-JSON values (functions, BigInt) before they
        // reach the repository, where the same failure would surface as an
        // opaque driver error.
        encoded = JSON.stringify(value) ?? "null";
      } catch {
        return invalid("value must be JSON");
      }
      if (encoded.length > SETTING_MAX_CHARS) {
        return invalid(`value must be under ${SETTING_MAX_CHARS} characters of JSON`);
      }

      const result = await this.d.config.setSetting(guildId, key, value);
      // The key, not the payload: a setting may hold a message template with
      // someone's words in it, and the audit trail records who changed what
      // named thing, not a copy of its contents.
      return { result, change: { key, bytes: encoded.length } };
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

  /**
   * Replace the guild's join-screening policy.
   *
   * Validated strictly, and deliberately so — the exact opposite of the
   * evaluator's `parsePolicy`, which fills anything malformed from the defaults
   * rather than taking screening offline. The pair is intentional: **tolerant
   * read, strict write.** A stored policy written years ago must still evaluate;
   * a policy being typed *now* should fail at the keyboard, where someone can
   * fix it, rather than silently degrade into a default that quietly stops
   * enforcing the bar they thought they had set.
   *
   * That is also why an unknown key is rejected instead of ignored. A typo'd
   * `minCatacomb` accepted here would read back as "no dungeon requirement",
   * and the admin would have no way to tell that from the setting working.
   *
   * The whole policy is sent on every save, not a patch: the form shows every
   * field, and a partial write against a policy someone else just edited is a
   * lost update nobody would notice until the wrong person got in.
   */
  async setScreeningPolicy(
    session: PanelSession | null,
    guildId: string,
    input: unknown,
  ): Promise<MutationResult> {
    return this.run(session, guildId, "config.screening", async () => {
      const parsed = readScreeningPolicy(input);
      if (typeof parsed === "string") return invalid(parsed);

      const stored = serializePolicy(parsed);
      const result = await this.d.config.setSetting(guildId, SCREENING_POLICY_KEY, stored);
      // Recorded in full, unlike `config.setting`, which logs only the key: a
      // screening policy is numbers and switches with nobody's words in it, and
      // "who lowered the bar, and to what" is the question this audit exists to
      // answer.
      return { result, change: { ...stored } };
    });
  }

  // ─────────────────────────── xp ───────────────────────────

  /**
   * Configure one XP source: whether it counts, what it is worth, and the
   * anti-abuse limits that bound it.
   *
   * One source per write, unlike the screening policy's whole-form save. The
   * difference is that the sources are independent — nothing about the GEXP
   * weight is invalidated by someone else changing the message cooldown, so a
   * per-row save costs no consistency and lets the page save a toggle without
   * re-posting six settings it did not touch.
   *
   * Nothing here is retroactive, and the UI should say so: the weights are read
   * when `xp-aggregate` derives a day, so a change lands on today's still-open
   * counters and on everything after, while yesterday keeps the numbers it was
   * scored under.
   */
  async setXpSource(session: PanelSession | null, guildId: string, input: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "xp.source", async () => {
      const xp = this.d.xp;
      if (xp === undefined) return unavailable("XP is not enabled on this deployment");
      if (typeof input !== "object" || input === null) return invalid("body must be an object");
      const body = input as Record<string, unknown>;

      const source = body["source"];
      if (typeof source !== "string" || !XP_SOURCE_ORDER.includes(source as XpSource)) {
        return invalid(`source must be one of ${XP_SOURCE_ORDER.join(", ")}`);
      }
      if (typeof body["enabled"] !== "boolean") return invalid("enabled must be a boolean");

      // Fractional, so this one is bounded rather than integer-checked.
      const weight = body["weight"];
      if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > MAX_SOURCE_WEIGHT) {
        return invalid(`weight must be between 0 and ${MAX_SOURCE_WEIGHT}`);
      }
      // null is "uncapped", which is a real choice for GEXP and tenure — those
      // are already bounded by what Hypixel reports and by the calendar.
      const dailyCap = body["dailyCap"];
      if (dailyCap !== null && !isCount(dailyCap, MAX_DAILY_CAP)) {
        return invalid(`dailyCap must be a whole number up to ${MAX_DAILY_CAP}, or null for uncapped`);
      }
      const cooldownSec = body["cooldownSec"];
      if (!isCount(cooldownSec, MAX_COOLDOWN_SEC)) {
        return invalid(`cooldownSec must be a whole number of seconds up to ${MAX_COOLDOWN_SEC}`);
      }
      const minLength = body["minLength"];
      if (!isCount(minLength, MAX_MIN_LENGTH)) {
        return invalid(`minLength must be a whole number up to ${MAX_MIN_LENGTH}`);
      }

      const policy: XpSourcePolicyDTO = {
        source: source as XpSource,
        enabled: body["enabled"],
        weight,
        dailyCap,
        cooldownSec,
        minLength,
      };
      try {
        await xp.setSourcePolicy(guildId, policy);
      } catch (error) {
        return { error: { kind: "SERVICE_ERROR", detail: describe(error) } };
      }
      // Recorded in full, like the screening policy and for the same reason:
      // these are numbers and switches with nobody's words in them, and "who
      // made chat worth ten times more, and when" is the question this answers.
      return { result: { ok: true }, change: { ...policy } };
    });
  }

  /**
   * Credit or debit a member's XP by hand.
   *
   * The amount is signed and the reason is required, because this is the one
   * award on the ledger that no counter can explain: every other row can be
   * re-derived from the activity that produced it, while this one exists only
   * because a person decided it should. The reason is that person's account of
   * why, and it is stored on the ledger row itself, not merely in the audit
   * trail — a member asking where 5,000 XP came from should be answerable from
   * their own history.
   *
   * Zero is refused rather than accepted as a no-op: an adjustment of nothing
   * is a typo in the amount field, and writing it would put a ledger row and an
   * audit entry in front of anyone reviewing the guild for no reason at all.
   */
  async adjustXp(session: PanelSession | null, guildId: string, input: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "xp.adjust", async (actorDiscordId) => {
      const xp = this.d.xp;
      if (xp === undefined) return unavailable("XP is not enabled on this deployment");
      if (typeof input !== "object" || input === null) return invalid("body must be an object");
      const body = input as Record<string, unknown>;

      const discordId = body["discordId"];
      if (typeof discordId !== "string" || !SNOWFLAKE.test(discordId)) {
        return invalid("discordId must be a Discord id");
      }
      const amount = body["amount"];
      if (typeof amount !== "number" || !Number.isInteger(amount) || amount === 0) {
        return invalid("amount must be a non-zero whole number");
      }
      if (Math.abs(amount) > MAX_ADJUSTMENT) {
        return invalid(`amount must be within ±${MAX_ADJUSTMENT}`);
      }
      const reason = typeof body["reason"] === "string" ? body["reason"].trim() : "";
      if (reason.length === 0) return invalid("a reason is required");
      if (reason.length > REASON_MAX) return invalid(`reason must be under ${REASON_MAX} characters`);

      try {
        // The returned standing is discarded on purpose. `adjust` writes the
        // ledger row before it reads a standing back, so a null here would mean
        // the read found nothing — not that the write failed — and reporting
        // that as an error would tell the admin to retry a change that landed.
        await xp.adjust(guildId, discordId, amount, reason, actorDiscordId);
      } catch (error) {
        return { error: { kind: "SERVICE_ERROR", detail: describe(error) } };
      }
      return { result: { ok: true }, change: { discordId, amount, reason } };
    });
  }

  // ─────────────────────────── milestones ───────────────────────────

  /**
   * Create or edit one milestone definition.
   *
   * Keyed by `key`, so editing a built-in default is a create that shadows it
   * and switching one off is a store with `enabled: false`. The panel never
   * has to write the other twenty-nine defaults to change one of them, and a
   * default added by a later release still reaches a guild that has customised
   * something else.
   */
  async upsertMilestone(session: PanelSession | null, guildId: string, input: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "milestone.upsert", async () => {
      const milestones = this.d.milestones;
      if (milestones === undefined) return unavailable("Milestones are not enabled on this deployment");
      if (typeof input !== "object" || input === null) return invalid("body must be an object");
      const body = input as Record<string, unknown>;

      const key = body["key"];
      if (typeof key !== "string" || !MILESTONE_KEY.test(key)) {
        return invalid("key must be a short lowercase name, e.g. networth:1b");
      }
      const label = body["label"];
      if (typeof label !== "string" || label.trim().length === 0 || label.length > MILESTONE_LABEL_MAX) {
        return invalid(`label must be 1–${MILESTONE_LABEL_MAX} characters`);
      }
      const description = body["description"] ?? null;
      if (description !== null && (typeof description !== "string" || description.length > MILESTONE_DESC_MAX)) {
        return invalid(`description must be under ${MILESTONE_DESC_MAX} characters, or null`);
      }
      const type = body["type"];
      if (typeof type !== "string" || !(type in MILESTONE_TYPES)) {
        return invalid(`type must be one of ${Object.keys(MILESTONE_TYPES).join(", ")}`);
      }
      // The metric decides which snapshot field is compared; anything outside
      // the list would store a definition that can never fire, which reads on
      // the page as configured and behaves as absent.
      const metric = body["metric"];
      if (!isMilestoneMetric(metric)) {
        return invalid(`metric must be one of ${MILESTONE_METRICS.join(", ")}`);
      }
      const threshold = body["threshold"];
      if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0) {
        return invalid("threshold must be a positive number");
      }
      if (!isCount(body["xpReward"], MAX_MILESTONE_REWARD)) {
        return invalid(`xpReward must be a whole number up to ${MAX_MILESTONE_REWARD}`);
      }
      if (typeof body["announce"] !== "boolean") return invalid("announce must be a boolean");
      if (typeof body["enabled"] !== "boolean") return invalid("enabled must be a boolean");

      const definition: MilestoneDefinitionInput = {
        key,
        label: label.trim(),
        description: description as string | null,
        type: type as MilestoneType,
        metric,
        threshold,
        xpReward: body["xpReward"],
        announce: body["announce"],
        enabled: body["enabled"],
      };
      try {
        await milestones.upsert(guildId, definition);
      } catch (error) {
        return { error: { kind: "SERVICE_ERROR", detail: describe(error) } };
      }
      // Recorded in full: a definition is numbers, switches and a label
      // somebody wrote for public display — there is nothing private in it, and
      // "who made this milestone worth 5,000 XP" is the question the trail is
      // for.
      return { result: { ok: true }, change: { ...definition } };
    });
  }

  /**
   * Drop a guild's definition row.
   *
   * A shadowed default reverts to the built-in rather than disappearing — to
   * stop recognising one of those, store it disabled instead. Milestones
   * already recorded against it are untouched: deleting the definition changes
   * what the guild recognises from now on, it does not unmake the fact that
   * somebody reached it.
   */
  async removeMilestone(session: PanelSession | null, guildId: string, key: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "milestone.remove", async () => {
      const milestones = this.d.milestones;
      if (milestones === undefined) return unavailable("Milestones are not enabled on this deployment");
      if (typeof key !== "string" || !MILESTONE_KEY.test(key)) return invalid("key must be a definition key");

      let removed: boolean;
      try {
        removed = await milestones.remove(guildId, key);
      } catch (error) {
        return { error: { kind: "SERVICE_ERROR", detail: describe(error) } };
      }
      // A key with no row is not an error: the page may have been showing a
      // built-in default, and "there is nothing of yours to remove" is the
      // state the caller wanted to reach.
      return { result: { ok: true }, change: { key, removed } };
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

/**
 * A write whose service isn't wired into this deployment.
 *
 * SERVICE_ERROR rather than INVALID_INPUT: nothing is wrong with what the
 * caller sent, and telling them to fix their input would send them editing a
 * form that was never going to save.
 */
function unavailable(detail: string): Step {
  return { error: { kind: "SERVICE_ERROR", detail } };
}

/** A whole number in `[0, max]` — the shape every XP limit shares. */
function isCount(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
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
// ── screening policy validation ─────────────────────────────────────────────

const SCREENING_FLAGS = [
  "enabled",
  "autoAccept",
  "denyOnScammer",
  "reviewOnScammerUnknown",
  "denyOnPriorExpulsion",
  "reviewOnUnreadable",
] as const;

/** Nullable bars. Null means "do not check this", which is not the same as 0. */
const SCREENING_BARS = [
  "minSkyblockLevel",
  "minSkillAverage",
  "minCatacombs",
  "minSenitherWeight",
  "minAccountAgeDays",
  "maxInactiveDays",
] as const;

/**
 * Upper bound on any bar.
 *
 * Deliberately one loose ceiling rather than a per-stat one. A table saying
 * "skill average tops out at 60" is a piece of game trivia that goes stale with
 * the next Skyblock update, and a stale ceiling rejects a policy that is
 * perfectly reasonable. What this actually needs to catch is Infinity, NaN and
 * a slipped decimal point, and one bound does that.
 */
const BAR_MAX = 1e9;

const SCREENING_COUNTS = {
  repeatWindowDays: { min: 1, max: 365 },
  maxAttemptsInWindow: { min: 1, max: 100 },
  /** A risk score, so its range is the score's range. */
  reviewAtRisk: { min: 0, max: 100 },
} as const;

const SCREENING_KEYS: readonly string[] = [
  ...SCREENING_FLAGS,
  ...SCREENING_BARS,
  ...Object.keys(SCREENING_COUNTS),
  "minNetworth",
];

/** Coins, as the form sends them: digits in a string, so 10b survives JSON. */
const COINS = /^\d{1,30}$/;

/**
 * Validate a screening policy payload. Returns the policy, or the message to
 * show the admin — never a half-applied policy.
 */
function readScreeningPolicy(input: unknown): ScreeningPolicy | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "body must be an object";
  const body = input as Record<string, unknown>;

  const unknownKeys = Object.keys(body).filter((k) => !SCREENING_KEYS.includes(k));
  if (unknownKeys.length > 0) return `unknown field(s): ${unknownKeys.join(", ")}`;

  const flags: Record<string, boolean> = {};
  for (const key of SCREENING_FLAGS) {
    const value = body[key];
    if (typeof value !== "boolean") return `${key} must be a boolean`;
    flags[key] = value;
  }

  const bars: Record<string, number | null> = {};
  for (const key of SCREENING_BARS) {
    const value = body[key];
    if (value === null || value === undefined) {
      bars[key] = null;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > BAR_MAX) {
      return `${key} must be a number between 0 and ${BAR_MAX}, or null for no requirement`;
    }
    bars[key] = value;
  }

  const counts: Record<string, number> = {};
  for (const [key, range] of Object.entries(SCREENING_COUNTS)) {
    const value = body[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max) {
      return `${key} must be a whole number between ${range.min} and ${range.max}`;
    }
    counts[key] = value;
  }

  const raw = body["minNetworth"];
  let minNetworth: bigint | null = null;
  if (raw !== null && raw !== undefined) {
    // A number is accepted because a small threshold typed into a number field
    // is a reasonable thing to send; anything past 2^53 has to arrive as a
    // string, because by then a double has already lost the digits.
    if (typeof raw === "number") {
      if (!Number.isFinite(raw) || raw < 0 || !Number.isSafeInteger(raw)) {
        return "minNetworth must be a whole number of coins, or a digit string for large values";
      }
      minNetworth = BigInt(raw);
    } else if (typeof raw === "string" && COINS.test(raw.trim())) {
      minNetworth = BigInt(raw.trim());
    } else {
      return "minNetworth must be a string of digits, a whole number, or null";
    }
  }

  // `autoAccept` is the switch that admits a stranger with nobody watching, so
  // the one cross-field rule guards it: with screening off, nothing is
  // evaluated, and an accept flag left on would mean "admit everyone".
  if (flags["autoAccept"] && !flags["enabled"]) {
    return "autoAccept requires enabled: with screening off, nothing is checked before accepting";
  }

  return {
    enabled: flags["enabled"]!,
    autoAccept: flags["autoAccept"]!,
    denyOnScammer: flags["denyOnScammer"]!,
    reviewOnScammerUnknown: flags["reviewOnScammerUnknown"]!,
    denyOnPriorExpulsion: flags["denyOnPriorExpulsion"]!,
    reviewOnUnreadable: flags["reviewOnUnreadable"]!,
    minSkyblockLevel: bars["minSkyblockLevel"]!,
    minSkillAverage: bars["minSkillAverage"]!,
    minCatacombs: bars["minCatacombs"]!,
    minSenitherWeight: bars["minSenitherWeight"]!,
    minNetworth,
    minAccountAgeDays: bars["minAccountAgeDays"]!,
    maxInactiveDays: bars["maxInactiveDays"]!,
    repeatWindowDays: counts["repeatWindowDays"]!,
    maxAttemptsInWindow: counts["maxAttemptsInWindow"]!,
    reviewAtRisk: counts["reviewAtRisk"]!,
  };
}

const ABSENT = Symbol("absent");
const INVALID = Symbol("invalid");

function threshold(body: Record<string, unknown>, key: string): number | null | typeof ABSENT | typeof INVALID {
  if (!(key in body) || body[key] === undefined) return ABSENT;
  const value = body[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return INVALID;
  return value;
}
