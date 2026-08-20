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
  ACHIEVEMENT_TIERS,
  BridgeCapability,
  CONFIG_CHANNEL_SLOTS,
  isAchievementTier,
  isConfigChannelSlot,
  isMilestoneMetric,
  isUpstreamUnavailable,
  MILESTONE_METRICS,
  MilestoneType as MILESTONE_TYPES,
} from "@sbr/shared-types";
import type {
  AnalyticsService,
  ModerationSurface,
  CommunityService,
  ConfigChannelSlot,
  EventEdit,
  EventType,
  GuildConfigService,
  HypixelResult,
  IdentityService,
  MemberRole,
  MilestoneDefinitionInput,
  MilestoneDefinitionService,
  MilestoneType,
  ModActionType,
  TicketActor,
  TicketCategoryInput,
  TicketConfigService,
  TicketPanelInput,
  TicketPanelStyle,
  TicketQuestionDTO,
  TicketSettingsInput,
  TicketTagInput,
  TicketWorkingHoursDTO,
  ViewColor,
  ModerationService,
  RecruitmentSettings,
  XpService,
  XpSource,
  XpSourcePolicyDTO,
  WordAction,
  WordlistError,
  WordlistRuleUpdate,
  WordlistService,
  WordMatchType,
} from "@sbr/shared-types";
import {
  AUTOMOD_ACTION_TYPES,
  AUTOMOD_SETTING_KEY,
  AUTOMOD_TRIGGER_KINDS,
  ESCALATION_SETTING_KEY,
  evaluateAutomod,
  MAX_GAME_MUTE_SECONDS,
  parseAutomod,
  RELAY_DISCORD_ACTIONS,
  RELAY_GAME_ACTIONS,
  RELAY_SYNC_SETTING_KEY,
  type AutomodActionType,
  type AutomodRule,
  type AutomodTrigger,
  type AutomodTriggerKind,
  type EscalationAction,
  type RelayDiscordAction,
  type RelayGameAction,
  type RelaySyncRow,
} from "@sbr/moderation";
import { SCREENING_POLICY_KEY, serializePolicy, type ScreeningPolicy } from "@sbr/screening";
import {
  CAPABILITIES,
  COOLDOWN_SETTING_KEY,
  DEFAULT_CAPABILITY_FLOOR,
  MAX_COOLDOWN_SECONDS,
  ROLES,
  ROLE_POLICY_SETTING_KEY,
  normalizeRank,
  parseRolePolicy,
  validateRolePolicy,
  type RolePolicy,
} from "@sbr/guild-config";
import type { Logger } from "@sbr/observability";
import { authorizeRole, type AccessDecision, type PanelSession, type RoleResolver } from "./access.js";
import type { PermissionExceptionStore, PermSubjectKind } from "./reads.js";
import { XP_SOURCE_ORDER } from "./service.js";

/** Every write the panel can perform, and the platform role it requires. */
export const MUTATION_TIERS = {
  "config.channel": "ADMIN",
  /**
   * Which Hypixel guild this platform guild tracks. Admin because it decides
   * whose roster the workers sync and whose members the whole panel is about —
   * repointing it is closer to re-creating the guild than to editing a setting.
   */
  "config.hypixel": "ADMIN",
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
  /**
   * The ticket menu and the panels advertising it. Admin because a category
   * names the staff roles pulled into a ticket and the Discord category it
   * opens under — reachable at a lower tier, it would be a way to route reports
   * and appeals somewhere the people they are about can read them.
   */
  "ticket.category.upsert": "ADMIN",
  "ticket.category.remove": "ADMIN",
  "ticket.panel.upsert": "ADMIN",
  "ticket.panel.remove": "ADMIN",
  /**
   * Posting a panel is its own mutation rather than a side effect of saving
   * one: an admin editing wording should not push a message into a channel by
   * accident, and a re-publish edits the message it already posted.
   */
  "ticket.panel.publish": "ADMIN",
  "ticket.tag.upsert": "ADMIN",
  "ticket.tag.remove": "ADMIN",
  /**
   * Ticket behaviour: colours, the archive switch, the auto-close clock and the
   * blocklist. Admin because switching archiving off stops transcripts being
   * captured at all, which is a decision about evidence, not presentation.
   */
  "ticket.settings.save": "ADMIN",
  /**
   * The chat filter's rules and the escalation ladder. Admin because both act
   * on members with nobody in the loop: a filter rule blocks or shadow-mutes at
   * relay time, and a ladder rung mutes or bans off a warning count. A rule is
   * also a pattern the bridge compiles and runs, which is not a thing to hand
   * out one tier down.
   */
  "wordlist.upsert": "ADMIN",
  "wordlist.delete": "ADMIN",
  "moderation.defaults": "ADMIN",
  /**
   * The Discord→in-game punishment mapping. Admin because a row here turns a
   * Discord action into a command typed by an account holding guild-officer
   * permissions — the blast radius is the game guild, not just the server.
   */
  "moderation.relay-sync": "ADMIN",
  /**
   * Trying a message against the automod policy. Moderator rather than Admin,
   * and deliberately one tier below the rules themselves: it writes nothing and
   * punishes nobody, and the person who most needs to know why a rule fired is
   * the moderator holding the report, not the admin who wrote it.
   */
  "automod.test": "MODERATOR",
  /**
   * The automod policy itself. Admin for the same reason the wordlist is: a
   * rule deletes messages and mutes members with nobody in the loop, on both
   * the Discord server and the game guild's chat.
   */
  "automod.rule.upsert": "ADMIN",
  "automod.rule.remove": "ADMIN",
  /**
   * The master switch. Its own mutation rather than a field of the rule write
   * so that switching the whole thing off is one click that cannot fail
   * halfway, which is what an operator wants at the moment they want it.
   */
  "automod.enable": "ADMIN",
  /**
   * How often a member may speak or run a command before the gate holds them.
   * Admin because the same numbers bound the XP earned from talking: a lower
   * tier here would be an indirect way to change what standing costs.
   */
  "config.cooldowns": "ADMIN",
  /**
   * The permission model itself: which Discord roles and in-game ranks confer
   * which level, what each level may do on the bridge, what each level may run,
   * and the per-person exceptions.
   *
   * Admin, and it could not be anything else — every other tier on this table is
   * enforced by comparing against a level these four writes define. At Officer
   * tier, `roles.binding` alone would let an officer bind their own Discord role
   * to ADMIN and reach the whole panel; `roles.exception` would let them grant
   * themselves the ADMIN capability outright. This is the one place where the
   * gate and the thing being gated are the same object.
   */
  "roles.binding": "ADMIN",
  "roles.rank": "ADMIN",
  "roles.capability": "ADMIN",
  "roles.command": "ADMIN",
  "roles.exception": "ADMIN",
  "roles.exception.remove": "ADMIN",
  /**
   * Starting a scheduled worker by hand. Admin because the cheap-sounding ones
   * are not: a snapshot pass walks every tracked member through the Hypixel
   * budget, and an AH sweep is hundreds of upstream calls. The button exists for
   * the moment a roster is visibly wrong, not for idle refreshing — hence the
   * per-job cooldown on top of this tier.
   */
  "health.run-job": "ADMIN",
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
  "ticket.claim": "MODERATOR",
  "ticket.transfer": "MODERATOR",
  /**
   * Re-sending a transcript is Staff work because it DMs a member a full copy
   * of a conversation. It is here at all because the first DM can fail against
   * a closed DM channel, and swallowing that would lose the transcript.
   */
  "ticket.transcript.resend": "MODERATOR",
  "application.decide": "OFFICER",
  /** Events are Officer work in §3.8, both scheduling and calling one off. */
  "event.create": "OFFICER",
  "event.cancel": "OFFICER",
  "event.update": "OFFICER",
  "event.complete": "OFFICER",
  /** Marking turnout writes to the record achievements are counted from. */
  "event.attendance": "OFFICER",
  /** Redrawing the tracker board edits a message in a members-visible channel. */
  "event.board.publish": "OFFICER",
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
  | {
      readonly access: Extract<AccessDecision, { allowed: true }>;
      readonly ok: true;
      readonly error: null;
      /**
       * A caveat on a write that did succeed — "linked, but we couldn't reach
       * Hypixel to confirm it". Distinct from an error because the row is
       * written and refusing would be a lie; distinct from silence because the
       * admin needs to know the confirmation didn't happen.
       */
      readonly note?: string;
    }
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

/**
 * Just enough of the Hypixel client to resolve a guild before linking it.
 *
 * Declared structurally here, like `MutationLimiter` and `ConfigAuditSink`, so
 * panel-core keeps out of `@sbr/hypixel`'s dependency graph — a data-source
 * package is the wrong thing for this layer to import, and the real client
 * satisfies this shape without knowing the interface exists.
 */
export interface HypixelGuildLookup {
  getGuild(
    id: string,
    by: "id" | "name",
  ): Promise<HypixelResult<{ readonly id: string; readonly name: string | null }>>;
}

/**
 * "Run this job now", and the set of jobs that may be asked for.
 *
 * Structural, like the other ports here, so panel-core neither imports the job
 * package nor learns what a queue is: the wiring supplies something that can
 * publish a request, and the allow-list travels with it because the two are one
 * fact — what this deployment's workers will actually accept.
 */
export interface JobTrigger {
  readonly runnable: readonly string[];
  trigger(request: {
    readonly jobName: string;
    readonly guildId: string;
    readonly actorDiscordId: string;
  }): Promise<void>;
}

/**
 * Port: the Discord side of a ticket mutation.
 *
 * The panel process has no gateway connection and no Mineflayer socket, so
 * anything that has to reach Discord is asked for here and carried out by a bot.
 * Implemented over Redis in `apps/web-panel`; a plain object in tests.
 */
export interface TicketEffects {
  /** Post a panel into its channel, or edit the message it posted before. */
  publishPanel(guildId: string, panelId: string, actorDiscordId: string): Promise<void>;
  /** DM a closed ticket's opener their transcript again. */
  resendTranscript(guildId: string, ticketId: string, actorDiscordId: string): Promise<void>;
}

/**
 * The Discord side of an event, done by whichever process holds a gateway.
 *
 * One method rather than "announce" and "remind" as well, because the tracker
 * board is the only event message the panel can ask for on demand: the reminder
 * and the announcement are the scheduler's, and a button that raced it would
 * post the same thing twice.
 */
export interface EventEffects {
  /** Post the tracker board into its channel, or edit the one already there. */
  publishBoard(guildId: string, eventId: string, actorDiscordId: string): Promise<void>;
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
  /** Optional like XP: absent refuses the write instead of crashing. */
  readonly tickets?: TicketConfigService;
  /**
   * The Discord-side work a ticket mutation asks for, done by whichever process
   * holds a gateway connection. Optional because the panel can run without a
   * bot; absent, the two mutations that need one refuse rather than reporting
   * success for something that never happened.
   */
  readonly ticketEffects?: TicketEffects;
  /**
   * Optional like the ticket side: without a bridge the board still redraws on
   * its half-hourly pass, and the button says so rather than pretending.
   */
  readonly eventEffects?: EventEffects;
  /** Optional like XP: absent refuses the write instead of crashing. */
  readonly wordlist?: WordlistService;
  /**
   * Optional like the rest: without it a guild can still be unlinked, but
   * linking one refuses rather than writing an id nothing ever checked.
   */
  readonly hypixel?: HypixelGuildLookup;
  /**
   * Optional like the rest: a deployment running the panel without workers
   * refuses the run rather than reporting a queue that nothing is draining.
   */
  readonly jobs?: JobTrigger;
  /**
   * Optional like the rest: without it the levels, floors and command table are
   * still editable and only per-person exceptions refuse.
   */
  readonly permissionExceptions?: PermissionExceptionStore;
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

/**
 * How long a hand-started job is barred from being started again.
 *
 * Long enough that a double-click, an impatient second admin and a refreshed tab
 * all collapse into one run; short enough that somebody watching a roster fix
 * itself is not locked out for the rest of the afternoon.
 */
export const MANUAL_JOB_COOLDOWN_MS = 60_000;

/** Per job, per guild — not per person. See `runJob` for why. */
function manualJobKey(guildId: string, jobName: string): string {
  return `cd:web:job:${guildId}:${jobName}`;
}

const MEMBER_ROLES: readonly MemberRole[] = ["MEMBER", "MODERATOR", "OFFICER", "ADMIN", "OWNER"];

/**
 * Discord snowflakes are 17–20 digits today. Validated by shape rather than by
 * asking Discord: the panel cannot prove a channel exists without the bot's
 * gateway, and rejecting obvious junk here is what keeps a typo from being
 * written into config and silently disabling a feature.
 */
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Hypixel guild ids are 24 hex characters (a Mongo ObjectId). Used to tell an
 * id apart from a name in the one free-text field that accepts either — no real
 * guild name is 24 unbroken hex characters, so the split is unambiguous.
 */
const HYPIXEL_GUILD_ID = /^[0-9a-f]{24}$/i;

/** Hypixel caps guild names at 32; the slack is for whitespace already trimmed. */
const HYPIXEL_GUILD_NAME_MAX = 64;

/** Definition keys are ours to shape: lowercase, with `:` grouping a family. */
const MILESTONE_KEY = /^[a-z0-9]+(?:[.:-][a-z0-9]+)*$/;
const MILESTONE_LABEL_MAX = 80;
const MILESTONE_DESC_MAX = 500;
/** Room for one emoji, or a couple of combining parts of one. Not a word. */
const MILESTONE_ICON_MAX = 4;
/** A reward big enough to matter, small enough not to rewrite the leaderboard. */
const MAX_MILESTONE_REWARD = 1_000_000;

/**
 * Category keys share the milestone shape: lowercase and hyphenated. The key is
 * what a panel button carries in its custom id, so it stays short, typable and
 * stable — a guild renames the `name` beside it instead.
 */
const TICKET_KEY = /^[a-z0-9]+(?:[.:-][a-z0-9]+)*$/;
const TICKET_NAME_MAX = 80;
/** Discord truncates a select-menu option description at 100 characters. */
const TICKET_DESCRIPTION_MAX = 100;
/** Emoji come from Discord's picker; the cap only stops someone pasting a novel. */
const TICKET_EMOJI_MAX = 64;
/** More roles than this on one category means the ping is no longer a ping. */
const MAX_TICKET_ROLE_IDS = 25;
/** Menu positions are a small ordering hint, not an index into anything. */
const MAX_TICKET_POSITION = 999;
/** Discord's own channel-name cap, before placeholder expansion. */
const TICKET_TEMPLATE_MAX = 100;
const TICKET_OPENING_MESSAGE_MAX = 2_000;
/** Discord modals take five inputs, which is why the model caps at five. */
const MAX_TICKET_QUESTIONS = 5;
const TICKET_QUESTION_LABEL_MAX = 45;
const TICKET_QUESTION_PLACEHOLDER_MAX = 100;
const TICKET_QUESTION_MAX_LENGTH = 4_000;
const MAX_TICKET_MEMBER_LIMIT = 25;
/** Discord allows 50 channels in a category; a higher total limit is a lie. */
const MAX_TICKET_TOTAL_LIMIT = 50;
/** Discord's slow-mode ceiling, six hours. */
const MAX_TICKET_SLOWMODE_SECONDS = 21_600;
const MAX_TICKET_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;
const TICKET_PANEL_NAME_MAX = 80;
const TICKET_PANEL_TITLE_MAX = 120;
/** A select menu takes 25 options; a button row takes five. Both are Discord's. */
const MAX_PANEL_SELECT_CATEGORIES = 25;
const MAX_PANEL_BUTTON_CATEGORIES = 5;
const TICKET_TAG_NAME_MAX = 40;
const TICKET_TAG_CONTENT_MAX = 2_000;
/** Discord's embed footer cap. */
const TICKET_FOOTER_MAX = 2_048;
/** A month of silence is already far past "stale"; beyond it the clock is noise. */
const MAX_TICKET_MINUTES = 60 * 24 * 30;
const VIEW_COLOR_NAMES: readonly ViewColor[] = ["NEUTRAL", "INFO", "SUCCESS", "WARNING", "DANGER"];
const PANEL_STYLES: readonly TicketPanelStyle[] = ["BUTTONS", "SELECT"];
/**
 * Images are rendered by Discord's client from a URL we hand it. https only, so
 * a stored panel can never turn into a cleartext fetch on a member's machine.
 */
const HTTPS_URL = /^https:\/\/\S{1,480}$/;
/** `HH:MM`, 24-hour, which is what the working-hours editor writes. */
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Filter-rule bounds. The pattern cap is generous for a word and mean for a
 * regex, which is the intent: a pattern is compiled and run against every
 * relayed message, so a pathological one is a cost in the hot path rather than
 * a storage problem.
 */
const WORDLIST_PATTERN_MAX = 200;
const WORDLIST_NOTE_MAX = 500;
/** Severity is a staff-facing weight, not a score with arithmetic behind it. */
const MAX_WORD_SEVERITY = 10;
const WORD_MATCH_TYPES: readonly WordMatchType[] = ["EXACT", "SUBSTRING", "REGEX", "WILDCARD"];
const WORD_ACTIONS: readonly WordAction[] = ["FLAG", "REPLACE", "BLOCK", "SHADOW_MUTE"];

/** A ladder longer than this is a sign somebody is editing it by mistake. */
const MAX_ESCALATION_RUNGS = 10;
const MAX_ESCALATION_WARNS = 100;
/** Matches the clamp `parseEscalationPolicy` applies when reading it back. */
const MAX_ESCALATION_WINDOW_DAYS = 365;

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
/**
 * A cap on one attendance submission. Generous enough for any event a Hypixel
 * guild can hold and small enough that a malformed body cannot ask the database
 * to write a novel.
 */
const MAX_ATTENDEES = 500;
const MAX_CAPACITY = 1_000;

/**
 * The metrics an event can be scored on, mirroring `EVENT_METRICS` in
 * `@sbr/jobs`.
 *
 * Mirrored rather than imported for the same reason `EVENT_TYPES` is: the panel
 * does not depend on the worker package, and a metric the capture never writes
 * would leave a leaderboard permanently empty with nothing to point at. The
 * mirror is checked by the tracker's own tests, which use the real list.
 */
const EVENT_METRICS: readonly string[] = [
  "skyblockLevel",
  "networth",
  "skillAverage",
  "catacombsLevel",
  "slayerXp",
  "senitherWeight",
];

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
   * Link this guild to a Hypixel guild, by name or by id. Blank unlinks.
   *
   * Until this is set, roster sync and guild scan have nothing to work on and
   * skip every run, so most of the panel stays empty — which makes this the
   * first write a new deployment needs and the one that must not be fragile.
   *
   * Hence the fallback: an id is stored even when Hypixel cannot confirm it,
   * with a note saying so. A name is not, because resolving one *is* the API
   * call — there is no id to store, and inventing one would be worse than
   * telling the admin to paste it.
   */
  async setHypixelGuild(session: PanelSession | null, guildId: string, input: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "config.hypixel", async () => {
      if (input !== null && typeof input !== "string") {
        return invalid("send a Hypixel guild name or id, or null to unlink");
      }
      const query = (input ?? "").trim();
      if (query === "") {
        const result = await this.d.config.setHypixelGuild(guildId, null);
        return { result, change: { hypixelGuildId: null, verified: false } };
      }

      const byId = HYPIXEL_GUILD_ID.test(query);
      if (!byId && query.length > HYPIXEL_GUILD_NAME_MAX) {
        return invalid(`a guild name is at most ${HYPIXEL_GUILD_NAME_MAX} characters`);
      }
      const lookup = this.d.hypixel;
      if (!lookup) return unavailable("Hypixel lookups aren't available in this deployment");

      const found = await lookupHypixelGuild(lookup, query, byId ? "id" : "name");
      if (found.kind === "missing") {
        return invalid(byId ? "Hypixel has no guild with that id" : "Hypixel has no guild by that name");
      }
      if (found.kind === "unreachable") {
        if (!byId) {
          return unavailable(
            "Hypixel isn't answering, so a name can't be turned into an id right now — paste the guild's 24-character id instead",
          );
        }
        // Lowercased so the stored id matches what Hypixel returns, and so the
        // same guild pasted in two cases can't defeat the unique constraint.
        const id = query.toLowerCase();
        const result = await this.d.config.setHypixelGuild(guildId, id);
        return {
          result,
          change: { hypixelGuildId: id, verified: false },
          note: "Linked, but Hypixel wasn't reachable to confirm that guild exists.",
        };
      }

      const result = await this.d.config.setHypixelGuild(guildId, found.id);
      return {
        result,
        change: { hypixelGuildId: found.id, verified: true },
        ...(found.name === null ? {} : { note: `Linked to ${found.name}.` }),
      };
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
      // `minWeight` and `minNetworth` were read here, as a tri-state so that
      // toggling applications open would not wipe a guild's entry bar. Neither
      // is a bar any more — the scam check is the only entry requirement — so
      // recruitment is now the single switch it reads as. Both are still
      // accepted in the body and ignored, because an older panel tab left open
      // will keep sending them and a rejection there helps nobody.
      const settings: RecruitmentSettings = { open: body["open"] };
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

      // Presentation is optional on the way in and absent rather than defaulted
      // on the way out: a panel build that predates tiers must be able to edit a
      // Platinum's XP without silently demoting it to Bronze.
      const tier = body["tier"];
      if (tier !== undefined && !isAchievementTier(tier)) {
        return invalid(`tier must be one of ${ACHIEVEMENT_TIERS.join(", ")}`);
      }
      const rawIcon = body["icon"];
      if (rawIcon !== undefined && rawIcon !== null && typeof rawIcon !== "string") {
        return invalid("icon must be a short string, or null");
      }
      // Trimmed to nothing means "no icon", not an icon made of spaces. The cap
      // is characters rather than bytes because one emoji is several bytes and
      // the limit being enforced is visual width in an embed field name.
      const icon =
        rawIcon === undefined ? undefined : typeof rawIcon === "string" && rawIcon.trim().length > 0 ? rawIcon.trim() : null;
      if (icon !== undefined && icon !== null && [...icon].length > MILESTONE_ICON_MAX) {
        return invalid(`icon must be at most ${MILESTONE_ICON_MAX} characters`);
      }
      const hidden = body["hidden"];
      if (hidden !== undefined && typeof hidden !== "boolean") return invalid("hidden must be a boolean");

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
        ...(tier === undefined ? {} : { tier }),
        ...(icon === undefined ? {} : { icon }),
        ...(hidden === undefined ? {} : { hidden }),
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

  // ───────────────────────────── tickets ─────────────────────────────

  /**
   * Per-guild ticket behaviour: colours, archiving, the auto-close clock.
   *
   * Saved whole rather than field by field because the fields interact — a
   * stale clock with no auto-close never closes anything, and an auto-close
   * with no stale clock only ever fires off a close request. Reading them
   * together is the only way the page can say which of those a guild has.
   */
  async saveTicketSettings(session: PanelSession | null, guildId: string, input: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "ticket.settings.save", async () => {
      const tickets = this.d.tickets;
      if (tickets === undefined) return unavailable("Tickets are not enabled on this deployment");
      if (typeof input !== "object" || input === null) return invalid("body must be an object");
      const body = input as Record<string, unknown>;

      if (typeof body["archiveEnabled"] !== "boolean") return invalid("archiveEnabled must be a boolean");
      if (typeof body["closeButton"] !== "boolean") return invalid("closeButton must be a boolean");
      if (typeof body["claimButton"] !== "boolean") return invalid("claimButton must be a boolean");

      const logChannelId = body["logChannelId"] ?? null;
      if (logChannelId !== null && (typeof logChannelId !== "string" || !SNOWFLAKE.test(logChannelId))) {
        return invalid("logChannelId must be a Discord channel id, or null");
      }
      const blocklistRoleIds = roleIdList(body["blocklistRoleIds"]);
      if (blocklistRoleIds === null) {
        return invalid(`blocklistRoleIds must be up to ${MAX_TICKET_ROLE_IDS} Discord role ids`);
      }
      const primaryColor = viewColor(body["primaryColor"]);
      const successColor = viewColor(body["successColor"]);
      const errorColor = viewColor(body["errorColor"]);
      if (primaryColor === null || successColor === null || errorColor === null) {
        return invalid(`colours must be one of ${VIEW_COLOR_NAMES.join(", ")}`);
      }
      const footer = body["footer"] ?? null;
      if (footer !== null && (typeof footer !== "string" || footer.length > TICKET_FOOTER_MAX)) {
        return invalid(`footer must be under ${TICKET_FOOTER_MAX} characters, or null`);
      }
      // Null is a real value here and means "no clock", which is why it is not
      // folded into zero: a zero-minute stale window would mark every ticket
      // stale the moment it was opened.
      const staleAfterMinutes = body["staleAfterMinutes"] ?? null;
      if (staleAfterMinutes !== null && !isCount(staleAfterMinutes, MAX_TICKET_MINUTES)) {
        return invalid(`staleAfterMinutes must be a whole number up to ${MAX_TICKET_MINUTES}, or null`);
      }
      if (!isCount(body["autoCloseAfterMinutes"], MAX_TICKET_MINUTES)) {
        return invalid(`autoCloseAfterMinutes must be a whole number up to ${MAX_TICKET_MINUTES}`);
      }
      const workingHours = parseWorkingHours(body["workingHours"]);
      if (workingHours === null) {
        return invalid('workingHours must map "0"–"6" to {open, close} times as HH:MM');
      }

      const settings: TicketSettingsInput = {
        archiveEnabled: body["archiveEnabled"],
        logChannelId: logChannelId as string | null,
        blocklistRoleIds,
        primaryColor,
        successColor,
        errorColor,
        footer: footer as string | null,
        staleAfterMinutes: staleAfterMinutes as number | null,
        autoCloseAfterMinutes: body["autoCloseAfterMinutes"],
        closeButton: body["closeButton"],
        claimButton: body["claimButton"],
        workingHours,
      };
      try {
        await tickets.saveSettings(guildId, settings);
      } catch (error) {
        return { error: { kind: "SERVICE_ERROR", detail: describe(error) } };
      }
      // Recorded in full: none of it is private, and "who turned archiving off"
      // is precisely the question an audit trail is kept for.
      return { result: { ok: true }, change: { ...settings, blocklistRoleIds: [...blocklistRoleIds] } };
    });
  }

  /**
   * Create or update one ticket category, by key.
   *
   * There are no built-ins layered underneath, unlike milestones: the five
   * former enum values are seeded as ordinary rows at install, so a guild that
   * deleted one has deleted it and a guild that renamed one has renamed it. A
   * later release adding a category is a seed, not a shadow.
   */
  async upsertTicketCategory(session: PanelSession | null, guildId: string, input: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "ticket.category.upsert", async () => {
      const tickets = this.d.tickets;
      if (tickets === undefined) return unavailable("Tickets are not enabled on this deployment");
      if (typeof input !== "object" || input === null) return invalid("body must be an object");
      const body = input as Record<string, unknown>;

      const key = body["key"];
      if (typeof key !== "string" || !TICKET_KEY.test(key)) {
        return invalid("key must be lowercase words joined by - . or :");
      }
      const name = body["name"];
      if (typeof name !== "string" || name.trim().length === 0 || name.length > TICKET_NAME_MAX) {
        return invalid(`name must be 1–${TICKET_NAME_MAX} characters`);
      }
      const description = body["description"];
      if (typeof description !== "string" || description.length > TICKET_DESCRIPTION_MAX) {
        return invalid(`description must be under ${TICKET_DESCRIPTION_MAX} characters`);
      }
      const emoji = body["emoji"] ?? null;
      if (emoji !== null && (typeof emoji !== "string" || emoji.length > TICKET_EMOJI_MAX)) {
        return invalid(`emoji must be under ${TICKET_EMOJI_MAX} characters, or null`);
      }
      if (!isCount(body["position"], MAX_TICKET_POSITION)) {
        return invalid(`position must be a whole number up to ${MAX_TICKET_POSITION}`);
      }
      if (typeof body["enabled"] !== "boolean") return invalid("enabled must be a boolean");
      if (typeof body["claiming"] !== "boolean") return invalid("claiming must be a boolean");
      if (typeof body["requireTopic"] !== "boolean") return invalid("requireTopic must be a boolean");

      const template = body["channelNameTemplate"];
      if (typeof template !== "string" || template.trim().length === 0 || template.length > TICKET_TEMPLATE_MAX) {
        return invalid(`channelNameTemplate must be 1–${TICKET_TEMPLATE_MAX} characters`);
      }
      const parentChannelId = body["parentChannelId"] ?? null;
      if (parentChannelId !== null && (typeof parentChannelId !== "string" || !SNOWFLAKE.test(parentChannelId))) {
        return invalid("parentChannelId must be a Discord channel id, or null");
      }
      const staffRoleIds = roleIdList(body["staffRoleIds"]);
      const requiredRoleIds = roleIdList(body["requiredRoleIds"]);
      const pingRoleIds = roleIdList(body["pingRoleIds"]);
      if (staffRoleIds === null || requiredRoleIds === null || pingRoleIds === null) {
        return invalid(`role lists must each hold up to ${MAX_TICKET_ROLE_IDS} Discord role ids`);
      }
      const openingMessage = body["openingMessage"];
      if (typeof openingMessage !== "string" || openingMessage.length > TICKET_OPENING_MESSAGE_MAX) {
        return invalid(`openingMessage must be under ${TICKET_OPENING_MESSAGE_MAX} characters`);
      }
      const image = body["image"] ?? null;
      if (image !== null && (typeof image !== "string" || !HTTPS_URL.test(image))) {
        return invalid("image must be an https URL, or null");
      }
      const cooldownSeconds = body["cooldownSeconds"] ?? null;
      if (cooldownSeconds !== null && !isCount(cooldownSeconds, MAX_TICKET_COOLDOWN_SECONDS)) {
        return invalid(`cooldownSeconds must be a whole number up to ${MAX_TICKET_COOLDOWN_SECONDS}, or null`);
      }
      const slowModeSeconds = body["slowModeSeconds"] ?? null;
      if (slowModeSeconds !== null && !isCount(slowModeSeconds, MAX_TICKET_SLOWMODE_SECONDS)) {
        return invalid(`slowModeSeconds must be a whole number up to ${MAX_TICKET_SLOWMODE_SECONDS}, or null`);
      }
      // Both limits are floored at one: a category nobody may open a ticket in
      // is a disabled category, and `enabled` already says that out loud.
      const memberLimit = body["memberLimit"];
      if (!isCount(memberLimit, MAX_TICKET_MEMBER_LIMIT) || memberLimit < 1) {
        return invalid(`memberLimit must be 1–${MAX_TICKET_MEMBER_LIMIT}`);
      }
      const totalLimit = body["totalLimit"];
      if (!isCount(totalLimit, MAX_TICKET_TOTAL_LIMIT) || totalLimit < 1) {
        // Discord's own ceiling, not ours: a category holds 50 channels.
        return invalid(`totalLimit must be 1–${MAX_TICKET_TOTAL_LIMIT}`);
      }
      const questions = parseQuestions(body["questions"]);
      if (questions === null) {
        return invalid(`questions must be up to ${MAX_TICKET_QUESTIONS} well-formed modal inputs`);
      }

      const category: TicketCategoryInput = {
        key,
        name: name.trim(),
        description,
        emoji: emoji as string | null,
        position: body["position"],
        enabled: body["enabled"],
        channelNameTemplate: template.trim(),
        parentChannelId: parentChannelId as string | null,
        // Duplicate role ids would ping the same people twice; deduped here
        // rather than at the repository, so the audit records what was stored.
        staffRoleIds: [...new Set(staffRoleIds)],
        requiredRoleIds: [...new Set(requiredRoleIds)],
        pingRoleIds: [...new Set(pingRoleIds)],
        openingMessage,
        image: image as string | null,
        claiming: body["claiming"],
        cooldownSeconds: cooldownSeconds as number | null,
        memberLimit,
        totalLimit,
        slowModeSeconds: slowModeSeconds as number | null,
        requireTopic: body["requireTopic"],
        questions,
      };
      try {
        await tickets.upsertCategory(guildId, category);
      } catch (error) {
        return { error: { kind: "SERVICE_ERROR", detail: describe(error) } };
      }
      // Recorded in full: a category is a name, some role ids and the wording
      // members see — nothing private in it, and "who pointed appeals at this
      // channel" is the question the trail is for.
      return {
        result: { ok: true },
        change: {
          ...category,
          staffRoleIds: [...category.staffRoleIds],
          requiredRoleIds: [...category.requiredRoleIds],
          pingRoleIds: [...category.pingRoleIds],
          questions: category.questions.map((question) => ({ ...question })),
        },
      };
    });
  }

  /**
   * Drop a category.
   *
   * Tickets already opened under it keep their history: their `categoryId` goes
   * null rather than the rows going with it, so a closed appeal is still
   * readable after the appeal category is retired. To stop offering one without
   * losing the menu entry, store it with `enabled: false` instead.
   */
  async removeTicketCategory(session: PanelSession | null, guildId: string, key: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "ticket.category.remove", async () => {
      const tickets = this.d.tickets;
      if (tickets === undefined) return unavailable("Tickets are not enabled on this deployment");
      if (typeof key !== "string" || !TICKET_KEY.test(key)) return invalid("key must be a ticket category key");

      let removed: boolean;
      try {
        removed = await tickets.removeCategory(guildId, key);
      } catch (error) {
        return { error: { kind: "SERVICE_ERROR", detail: describe(error) } };
      }
      // A key with no row is not an error: two admins on the same page is the
      // ordinary case, and the second one deserves the same "it's gone".
      return { result: { ok: true }, change: { key, removed } };
    });
  }

  /**
   * Compose a panel, or edit one that already exists.
   *
   * The category count decides the style Discord will accept, so it is checked
   * here rather than at publish time: a panel that cannot be rendered should
   * fail while the admin is looking at the form, not silently later.
   */
  async upsertTicketPanel(session: PanelSession | null, guildId: string, input: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "ticket.panel.upsert", async () => {
      const tickets = this.d.tickets;
      if (tickets === undefined) return unavailable("Tickets are not enabled on this deployment");
      if (typeof input !== "object" || input === null) return invalid("body must be an object");
      const body = input as Record<string, unknown>;

      const id = body["id"] ?? null;
      if (id !== null && (typeof id !== "string" || !ENTITY_ID.test(id))) {
        return invalid("id must be a panel id, or null to create one");
      }
      const name = body["name"];
      if (typeof name !== "string" || name.trim().length === 0 || name.length > TICKET_PANEL_NAME_MAX) {
        return invalid(`name must be 1–${TICKET_PANEL_NAME_MAX} characters`);
      }
      const channelId = body["channelId"] ?? null;
      if (channelId !== null && (typeof channelId !== "string" || !SNOWFLAKE.test(channelId))) {
        return invalid("channelId must be a Discord channel id, or null");
      }
      const title = body["title"];
      if (typeof title !== "string" || title.trim().length === 0 || title.length > TICKET_PANEL_TITLE_MAX) {
        return invalid(`title must be 1–${TICKET_PANEL_TITLE_MAX} characters`);
      }
      const description = body["description"] ?? null;
      if (description !== null && (typeof description !== "string" || description.length > DESCRIPTION_MAX)) {
        return invalid(`description must be under ${DESCRIPTION_MAX} characters, or null`);
      }
      const image = body["image"] ?? null;
      if (image !== null && (typeof image !== "string" || !HTTPS_URL.test(image))) {
        return invalid("image must be an https URL, or null");
      }
      const thumbnail = body["thumbnail"] ?? null;
      if (thumbnail !== null && (typeof thumbnail !== "string" || !HTTPS_URL.test(thumbnail))) {
        return invalid("thumbnail must be an https URL, or null");
      }
      const style = body["style"];
      if (typeof style !== "string" || !PANEL_STYLES.includes(style as TicketPanelStyle)) {
        return invalid(`style must be one of ${PANEL_STYLES.join(", ")}`);
      }
      const categoryKeys = body["categoryKeys"];
      if (
        !Array.isArray(categoryKeys) ||
        categoryKeys.length === 0 ||
        categoryKeys.some((entry) => typeof entry !== "string" || !TICKET_KEY.test(entry))
      ) {
        return invalid("categoryKeys must be a non-empty list of category keys");
      }
      // Order is content, not presentation — the buttons appear in the order
      // given — so duplicates are rejected rather than deduped behind the
      // admin's back, which would silently reorder what they typed.
      const keys = categoryKeys as readonly string[];
      if (new Set(keys).size !== keys.length) return invalid("categoryKeys must not repeat a category");
      const cap = style === "BUTTONS" ? MAX_PANEL_BUTTON_CATEGORIES : MAX_PANEL_SELECT_CATEGORIES;
      if (keys.length > cap) {
        // Discord's caps, stated as Discord's: five buttons to a row, 25
        // options to a select. Truncating instead would drop a category the
        // admin chose and never say which.
        return invalid(`a ${style === "BUTTONS" ? "button" : "select"} panel holds at most ${cap} categories`);
      }

      const panel: TicketPanelInput = {
        name: name.trim(),
        channelId: channelId as string | null,
        title: title.trim(),
        description: description as string | null,
        image: image as string | null,
        thumbnail: thumbnail as string | null,
        style: style as TicketPanelStyle,
        categoryKeys: keys,
      };
      try {
        await tickets.upsertPanel(guildId, panel, (id as string | null) ?? undefined);
      } catch (error) {
        return { error: { kind: "SERVICE_ERROR", detail: describe(error) } };
      }
      return { result: { ok: true }, change: { id, ...panel, categoryKeys: [...panel.categoryKeys] } };
    });
  }

  /** Delete a panel. The message it posted is left in the channel to be tidied by hand. */
  async removeTicketPanel(session: PanelSession | null, guildId: string, id: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "ticket.panel.remove", async () => {
      const tickets = this.d.tickets;
      if (tickets === undefined) return unavailable("Tickets are not enabled on this deployment");
      if (typeof id !== "string" || !ENTITY_ID.test(id)) return invalid("id must be a panel id");

      let removed: boolean;
      try {
        removed = await tickets.removePanel(guildId, id);
      } catch (error) {
        return { error: { kind: "SERVICE_ERROR", detail: describe(error) } };
      }
      return { result: { ok: true }, change: { id, removed } };
    });
  }

  /**
   * Post a panel into its channel, or edit the message it posted before.
   *
   * The panel process has no gateway connection, so this hands the work to the
   * bridge rather than doing it here. With no bridge wired it refuses: a panel
   * that reports "published" without a message in the channel is the exact
   * failure this rebuild exists to remove.
   */
  async publishTicketPanel(session: PanelSession | null, guildId: string, id: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "ticket.panel.publish", async (actorDiscordId) => {
      const tickets = this.d.tickets;
      if (tickets === undefined) return unavailable("Tickets are not enabled on this deployment");
      const effects = this.d.ticketEffects;
      if (effects === undefined) return unavailable("No bot is connected to post the panel");
      if (typeof id !== "string" || !ENTITY_ID.test(id)) return invalid("id must be a panel id");

      // Checked here rather than in the bridge because this is where a human is
      // waiting for an answer: a panel with no channel would otherwise fail
      // somewhere nobody is looking.
      const panels = await tickets.listPanels(guildId);
      const panel = panels.find((row) => row.id === id);
      if (panel === undefined) return invalid("no such panel");
      if (panel.channelId === null) return invalid("give the panel a channel before publishing it");

      try {
        await effects.publishPanel(guildId, id, actorDiscordId);
      } catch (error) {
        return { error: { kind: "SERVICE_ERROR", detail: describe(error) } };
      }
      return { result: { ok: true }, change: { id, channelId: panel.channelId } };
    });
  }

  /** Add a canned reply, or edit one. Identified by name, which is never edited. */
  async upsertTicketTag(session: PanelSession | null, guildId: string, input: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "ticket.tag.upsert", async () => {
      const tickets = this.d.tickets;
      if (tickets === undefined) return unavailable("Tickets are not enabled on this deployment");
      if (typeof input !== "object" || input === null) return invalid("body must be an object");
      const body = input as Record<string, unknown>;

      const name = body["name"];
      if (typeof name !== "string" || !TICKET_KEY.test(name) || name.length > TICKET_TAG_NAME_MAX) {
        return invalid(`name must be lowercase words joined by - . or :, under ${TICKET_TAG_NAME_MAX} characters`);
      }
      const content = body["content"];
      if (typeof content !== "string" || content.trim().length === 0 || content.length > TICKET_TAG_CONTENT_MAX) {
        return invalid(`content must be 1–${TICKET_TAG_CONTENT_MAX} characters`);
      }
      if (typeof body["enabled"] !== "boolean") return invalid("enabled must be a boolean");

      const autoPattern = body["autoPattern"] ?? null;
      if (autoPattern !== null) {
        if (typeof autoPattern !== "string" || autoPattern.length > WORDLIST_PATTERN_MAX) {
          return invalid(`autoPattern must be under ${WORDLIST_PATTERN_MAX} characters, or null`);
        }
        // Compiled here so a broken pattern is a form error rather than a
        // ticket channel where every message throws.
        try {
          new RegExp(autoPattern, "mi");
        } catch {
          return invalid("autoPattern must be a valid regular expression");
        }
      }

      const tag: TicketTagInput = {
        name,
        content,
        autoPattern: autoPattern as string | null,
        enabled: body["enabled"],
      };
      try {
        await tickets.upsertTag(guildId, tag);
      } catch (error) {
        return { error: { kind: "SERVICE_ERROR", detail: describe(error) } };
      }
      return { result: { ok: true }, change: { ...tag } };
    });
  }

  /** Drop a canned reply. */
  async removeTicketTag(session: PanelSession | null, guildId: string, name: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "ticket.tag.remove", async () => {
      const tickets = this.d.tickets;
      if (tickets === undefined) return unavailable("Tickets are not enabled on this deployment");
      if (typeof name !== "string" || !TICKET_KEY.test(name)) return invalid("name must be a tag name");

      let removed: boolean;
      try {
        removed = await tickets.removeTag(guildId, name);
      } catch (error) {
        return { error: { kind: "SERVICE_ERROR", detail: describe(error) } };
      }
      return { result: { ok: true }, change: { name, removed } };
    });
  }

  // ───────────────────────────── wordlist ─────────────────────────────

  /**
   * Add a filter rule, or edit one that already exists.
   *
   * One mutation rather than two, because it is one form: an admin fixing a
   * severity and an admin adding a word fill in identical fields, and the only
   * difference is whether an id came along. The id is what keeps an edit an
   * edit — remove-and-re-add would reorder the list under whoever was reading
   * it and orphan the rule id sitting in an older bridge log line.
   */
  async upsertWordlistRule(session: PanelSession | null, guildId: string, input: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "wordlist.upsert", async (actorDiscordId) => {
      const wordlist = this.d.wordlist;
      if (wordlist === undefined) return unavailable("The chat filter is not enabled on this deployment");
      if (typeof input !== "object" || input === null) return invalid("body must be an object");
      const body = input as Record<string, unknown>;

      const rawId = body["id"] ?? null;
      if (rawId !== null && (typeof rawId !== "string" || !ENTITY_ID.test(rawId))) {
        return invalid("id must be a rule id, or null to add a new rule");
      }
      const id = rawId as string | null;

      const rawPattern = body["pattern"];
      if (typeof rawPattern !== "string" || rawPattern.trim().length === 0 || rawPattern.length > WORDLIST_PATTERN_MAX) {
        return invalid(`pattern must be 1–${WORDLIST_PATTERN_MAX} characters`);
      }
      // Only the outer whitespace: a substring rule for "free nitro" is two words
      // on purpose, and trimming inside it would quietly change what it catches.
      const pattern = rawPattern.trim();

      const matchType = body["matchType"];
      if (typeof matchType !== "string" || !WORD_MATCH_TYPES.includes(matchType as WordMatchType)) {
        return invalid(`matchType must be one of ${WORD_MATCH_TYPES.join(", ")}`);
      }
      const action = body["action"];
      if (typeof action !== "string" || !WORD_ACTIONS.includes(action as WordAction)) {
        return invalid(`action must be one of ${WORD_ACTIONS.join(", ")}`);
      }
      const severity = body["severity"];
      if (!isCount(severity, MAX_WORD_SEVERITY) || severity < 1) {
        return invalid(`severity must be a whole number from 1 to ${MAX_WORD_SEVERITY}`);
      }
      // Absent and null differ here. `WordlistRuleDTO` does not carry the note,
      // so the page editing a rule has never seen one — if an omitted field
      // meant "clear it", every edit from the panel would quietly delete the
      // note a staffer typed into `/wordlist-add`. Omitted leaves it alone;
      // an explicit null is the only thing that clears it.
      const note = body["note"];
      if (note !== undefined && note !== null && (typeof note !== "string" || note.length > WORDLIST_NOTE_MAX)) {
        return invalid(`note must be under ${WORDLIST_NOTE_MAX} characters, null to clear it, or omitted`);
      }
      const enabled = body["enabled"];
      if (typeof enabled !== "boolean") return invalid("enabled must be a boolean");

      // The pattern is deliberately absent from the audit record. A filter list
      // is the one piece of guild config whose contents *are* the slurs and scam
      // URLs it exists to catch, and a trail that reproduces every one of them
      // is a second copy of the thing nobody wanted written down. Which rule
      // changed, to what settings, and by whom is all still here.
      const change: Record<string, unknown> = {
        id,
        matchType,
        action,
        severity,
        enabled,
        patternLength: pattern.length,
      };

      try {
        if (id === null) {
          const added = await wordlist.add({
            guildId,
            pattern,
            matchType: matchType as WordMatchType,
            action: action as WordAction,
            severity,
            addedByDiscordId: actorDiscordId,
            note: (note ?? null) as string | null,
          });
          if (!added.ok) return { error: wordlistRefusal(added.error) };
          // A new rule is stored live; honour a form that asked for otherwise
          // rather than leaving it enforcing for the seconds until someone
          // notices the toggle didn't take.
          if (!enabled) await wordlist.update(guildId, added.value.id, { enabled: false });
          return { result: { ok: true }, change: { ...change, id: added.value.id } };
        }

        const patch: WordlistRuleUpdate = {
          pattern,
          matchType: matchType as WordMatchType,
          action: action as WordAction,
          severity,
          enabled,
          ...(note === undefined ? {} : { note: note as string | null }),
        };
        const updated = await wordlist.update(guildId, id, patch);
        if (!updated.ok) return { error: wordlistRefusal(updated.error) };
        // Scoped by guild in the repository, so this also covers a rule id
        // pasted in from somewhere else: it simply does not exist here.
        if (updated.value === null) return invalid("no rule in this guild has that id");
        return { result: { ok: true }, change };
      } catch (error) {
        return { error: { kind: "SERVICE_ERROR", detail: describe(error) } };
      }
    });
  }

  /**
   * Delete a filter rule outright.
   *
   * To stop a rule firing but keep the record of it, save it disabled instead —
   * this is the irreversible one.
   */
  async deleteWordlistRule(session: PanelSession | null, guildId: string, id: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "wordlist.delete", async () => {
      const wordlist = this.d.wordlist;
      if (wordlist === undefined) return unavailable("The chat filter is not enabled on this deployment");
      if (typeof id !== "string" || !ENTITY_ID.test(id)) return invalid("id must be a rule id");

      let removed: boolean;
      try {
        const result = await wordlist.remove(guildId, id);
        if (!result.ok) return { error: { kind: "SERVICE_ERROR", detail: describe(result.error) } };
        // Nothing matched is not an error, as with milestones and ticket types:
        // two admins on the same page both pressing delete should both succeed.
        removed = result.value !== null;
      } catch (error) {
        return { error: { kind: "SERVICE_ERROR", detail: describe(error) } };
      }
      // The pattern is left out of the trail here for the reason given above.
      return { result: { ok: true }, change: { id, removed } };
    });
  }

  /**
   * Save the auto-warn escalation ladder (ADMIN_BOT.md §5.1).
   *
   * Written through the settings KV rather than a table of its own: it is one
   * small document per guild, read on every warning and rewritten about once a
   * year. Only the guild's own rungs are stored — the built-ins are layered
   * underneath at read time, so a rung added by a later release still reaches a
   * guild that customised a different one.
   */
  async setModerationDefaults(session: PanelSession | null, guildId: string, input: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "moderation.defaults", async () => {
      if (typeof input !== "object" || input === null) return invalid("body must be an object");
      const body = input as Record<string, unknown>;

      const enabled = body["enabled"];
      if (typeof enabled !== "boolean") return invalid("enabled must be a boolean");
      const windowDays = body["windowDays"];
      if (!isCount(windowDays, MAX_ESCALATION_WINDOW_DAYS) || windowDays < 1) {
        return invalid(`windowDays must be a whole number from 1 to ${MAX_ESCALATION_WINDOW_DAYS}`);
      }
      const rawRungs = body["rungs"];
      if (!Array.isArray(rawRungs) || rawRungs.length > MAX_ESCALATION_RUNGS) {
        return invalid(`rungs must be a list of up to ${MAX_ESCALATION_RUNGS} steps`);
      }

      const rungs: { warns: number; action: EscalationAction; durationSeconds: number | null }[] = [];
      const seen = new Set<number>();
      for (const raw of rawRungs) {
        if (typeof raw !== "object" || raw === null) return invalid("each rung must be an object");
        const rung = raw as Record<string, unknown>;

        const warns = rung["warns"];
        if (!isCount(warns, MAX_ESCALATION_WARNS) || warns < 1) {
          return invalid(`each rung's warns must be a whole number from 1 to ${MAX_ESCALATION_WARNS}`);
        }
        // Two rungs at one count is a ladder with an unanswerable step: the
        // later one would silently win, which is not what the form showed.
        if (seen.has(warns)) return invalid(`two rungs both fire at ${warns} warnings`);
        seen.add(warns);

        const action = rung["action"];
        if (action !== "MUTE" && action !== "BAN") return invalid("each rung's action must be MUTE or BAN");

        const rawDuration = rung["durationSeconds"] ?? null;
        if (rawDuration !== null && (!isCount(rawDuration, MAX_DURATION_SECONDS) || rawDuration < 1)) {
          return invalid(`durationSeconds must be a whole number of seconds under ${MAX_DURATION_SECONDS}, or null`);
        }
        const durationSeconds = rawDuration as number | null;
        // Refused here rather than dropped on the way back in: `parsePolicy`
        // would discard this rung silently, and an admin who saved a ladder
        // should not have to notice later that one step of it never fires.
        if (action === "MUTE" && durationSeconds === null) {
          return invalid("a mute rung needs a duration — the mute path refuses an endless one");
        }
        rungs.push({ warns, action, durationSeconds });
      }

      // Stored sorted, so a hand-read of the setting is a ladder in order.
      rungs.sort((a, b) => a.warns - b.warns);
      const policy = { enabled, windowDays, rungs };
      const result = await this.d.config.setSetting(guildId, ESCALATION_SETTING_KEY, policy);
      return { result, change: { enabled, windowDays, rungs: rungs.map((r) => ({ ...r })) } };
    });
  }

  /**
   * Save the Discord→in-game punishment mapping.
   *
   * Stored as overrides layered over the shipped defaults, exactly like the
   * escalation ladder: a guild that only switched WARN off still picks up a row
   * added by a later release, and a guild that never opened this page behaves
   * the way the defaults describe.
   *
   * The game action is validated against a closed list rather than accepted as
   * text. A free-form command line would be a configurable way to demote the
   * whole guild, and this endpoint is reachable by anyone the server owner has
   * made an admin.
   */
  async setRelaySync(session: PanelSession | null, guildId: string, input: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "moderation.relay-sync", async () => {
      if (typeof input !== "object" || input === null) return invalid("body must be an object");
      const body = input as Record<string, unknown>;

      const enabled = body["enabled"];
      if (typeof enabled !== "boolean") return invalid("enabled must be a boolean");

      const rawRows = body["rows"];
      if (!Array.isArray(rawRows) || rawRows.length > RELAY_DISCORD_ACTIONS.length) {
        return invalid(`rows must be a list of up to ${RELAY_DISCORD_ACTIONS.length} mappings`);
      }

      const rows: RelaySyncRow[] = [];
      const seen = new Set<string>();
      for (const raw of rawRows) {
        if (typeof raw !== "object" || raw === null) return invalid("each row must be an object");
        const row = raw as Record<string, unknown>;

        const discordAction = row["discordAction"];
        if (typeof discordAction !== "string" || !RELAY_DISCORD_ACTIONS.includes(discordAction as RelayDiscordAction)) {
          return invalid(`discordAction must be one of ${RELAY_DISCORD_ACTIONS.join(", ")}`);
        }
        // Two rows for one action is an unanswerable mapping: whichever the
        // parser reached last would win, which is not what the page showed.
        if (seen.has(discordAction)) return invalid(`${discordAction} is mapped twice`);
        seen.add(discordAction);

        const gameAction = row["gameAction"];
        if (typeof gameAction !== "string" || !RELAY_GAME_ACTIONS.includes(gameAction as RelayGameAction)) {
          return invalid(`gameAction must be one of ${RELAY_GAME_ACTIONS.join(", ")}`);
        }

        const durationMode = row["durationMode"];
        if (durationMode !== "same" && durationMode !== "fixed") {
          return invalid("durationMode must be 'same' or 'fixed'");
        }

        const rawFixed = row["fixedSeconds"] ?? null;
        if (rawFixed !== null && (!isCount(rawFixed, MAX_GAME_MUTE_SECONDS) || rawFixed < 1)) {
          return invalid(`fixedSeconds must be a whole number of seconds from 1 to ${MAX_GAME_MUTE_SECONDS}, or null`);
        }
        const fixedSeconds = rawFixed as number | null;
        // Refused rather than silently dropped, for the ladder's reason: the
        // mapping would parse back with no duration and simply never fire.
        if (durationMode === "fixed" && gameAction === "g mute" && fixedSeconds === null) {
          return invalid("a fixed-duration mute needs a duration");
        }

        const rowEnabled = row["enabled"];
        if (typeof rowEnabled !== "boolean") return invalid("each row's enabled must be a boolean");

        rows.push({
          discordAction: discordAction as RelayDiscordAction,
          gameAction: gameAction as RelayGameAction,
          durationMode,
          fixedSeconds,
          enabled: rowEnabled,
        });
      }

      const policy = { enabled, rows };
      const result = await this.d.config.setSetting(guildId, RELAY_SYNC_SETTING_KEY, policy);
      return { result, change: { enabled, rows: rows.map((r) => ({ ...r })) } };
    });
  }

  /**
   * Run a message past the automod policy and report what would have happened.
   *
   * The whole point of this endpoint is that it runs *the* evaluator, not a
   * description of it: the same `evaluateAutomod` the relay and the Discord
   * handler call, against the guild's stored policy and its real wordlist. A
   * test box that approximated the engine would be worse than none, because it
   * would build confidence in rules nobody had actually tried.
   *
   * Nothing is written and nobody is punished. Windowed triggers — spam and
   * repeat — read from operator-supplied counts instead of Redis, so an
   * operator can ask "what happens on the fifth message in ten seconds" without
   * sending five messages, and so testing cannot move the real counters that
   * decide whether a member gets muted.
   *
   * The audit row records the outcome and never the text. Somebody testing a
   * slur rule has to paste the slur, and writing it into the audit trail would
   * make this feature the thing that put it there permanently.
   */
  async testAutomod(session: PanelSession | null, guildId: string, input: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "automod.test", async () => {
      if (typeof input !== "object" || input === null) return invalid("body must be an object");
      const body = input as Record<string, unknown>;

      const text = body["text"];
      if (typeof text !== "string" || text.trim().length === 0) return invalid("text is required");
      if (text.length > MAX_AUTOMOD_TEST_LENGTH) {
        return invalid(`text must be ${MAX_AUTOMOD_TEST_LENGTH} characters or fewer`);
      }

      const surface = body["surface"];
      if (surface !== "DISCORD" && surface !== "GUILD_CHAT") {
        return invalid("surface must be DISCORD or GUILD_CHAT");
      }

      const rawMentions = body["mentionCount"] ?? 0;
      if (!isCount(rawMentions, MAX_AUTOMOD_TEST_MENTIONS)) {
        return invalid(`mentionCount must be a whole number from 0 to ${MAX_AUTOMOD_TEST_MENTIONS}`);
      }

      // Counter stubs, keyed by rule id exactly as the real store keys them.
      const counters: Record<string, number> = {};
      const rawCounters = body["counters"] ?? {};
      if (typeof rawCounters !== "object" || rawCounters === null || Array.isArray(rawCounters)) {
        return invalid("counters must be an object of ruleId → count");
      }
      for (const [ruleId, value] of Object.entries(rawCounters as Record<string, unknown>)) {
        if (!isCount(value, MAX_AUTOMOD_TEST_COUNTER)) {
          return invalid(`counters.${ruleId} must be a whole number from 0 to ${MAX_AUTOMOD_TEST_COUNTER}`);
        }
        counters[ruleId] = value as number;
      }

      const policy = parseAutomod(await this.d.config.getSetting(guildId, AUTOMOD_SETTING_KEY));
      // The wordlist is optional in the same way it is for the Filter page: a
      // deployment without it still has every other trigger, and a `wordlist`
      // rule simply matches nothing rather than refusing the test.
      const listed = this.d.wordlist ? await this.d.wordlist.list(guildId) : null;
      const wordlist = listed !== null && listed.ok ? listed.value : [];

      const decision = evaluateAutomod(policy, {
        text,
        surface,
        // Exemptions are not simulated. An operator testing a rule wants to know
        // whether the rule matches; asking them to also model their own roles
        // would make the answer depend on a form field rather than on the rule.
        authorRoleIds: [],
        authorCapabilities: [],
        mentionCount: rawMentions as number,
        counters,
        wordlist,
      });

      const note =
        decision.action === "ALLOW"
          ? policy.enabled
            ? "No rule matched — this message would be delivered."
            : "No rule matched. Automod is switched off, so nothing would fire in any case."
          : `${describeAutomodAction(decision.action, decision.durationSeconds)}${
              decision.deleteMessage ? ", message deleted" : ""
            } — ${decision.matched.map((m) => `${m.ruleName} (${m.detail})`).join("; ")}${
              policy.enabled ? "" : ". Automod is switched off, so this would not actually fire."
            }`;

      return {
        result: { ok: true },
        change: {
          surface,
          textLength: text.length,
          action: decision.action,
          deleted: decision.deleteMessage,
          rules: decision.matched.map((m) => m.ruleId),
        },
        note,
      };
    });
  }

  /**
   * Add or replace one automod rule.
   *
   * A rule at a time, not a policy at a time. Two admins on the page at once
   * editing different rules is ordinary; making the unit of the write the whole
   * policy would mean the second save silently reverted the first's rule to
   * whatever their browser last loaded.
   *
   * Validation here is strict where `parseAutomod` is lenient, and the two are
   * doing different jobs: the parser is reading a row that is already stored and
   * must not throw away a whole policy over one bad field, while this is the
   * gate that decides what gets stored in the first place. A rule that would
   * parse back into something other than what the operator typed is refused.
   */
  async upsertAutomodRule(
    session: PanelSession | null,
    guildId: string,
    input: unknown,
  ): Promise<MutationResult> {
    return this.run(session, guildId, "automod.rule.upsert", async () => {
      const parsed = readAutomodRule(input);
      if ("error" in parsed) return invalid(parsed.error);
      const rule = parsed.rule;

      const policy = parseAutomod(await this.d.config.getSetting(guildId, AUTOMOD_SETTING_KEY));
      const rules = policy.rules.slice();
      const at = rules.findIndex((r) => r.id === rule.id);
      const replacing = at >= 0;
      if (replacing) rules[at] = rule;
      else {
        if (rules.length >= MAX_AUTOMOD_RULES) {
          return invalid(`a guild may hold at most ${MAX_AUTOMOD_RULES} automod rules`);
        }
        rules.push(rule);
      }

      const result = await this.d.config.setSetting(guildId, AUTOMOD_SETTING_KEY, {
        enabled: policy.enabled,
        rules,
      });
      return {
        result,
        change: { id: rule.id, name: rule.name, trigger: rule.trigger.kind, action: rule.action.type, replacing },
        note: replacing ? `Updated “${rule.name}”.` : `Added “${rule.name}”.`,
      };
    });
  }

  /** Delete one rule by id. A rule that was not there is reported, not invented. */
  async removeAutomodRule(
    session: PanelSession | null,
    guildId: string,
    input: unknown,
  ): Promise<MutationResult> {
    return this.run(session, guildId, "automod.rule.remove", async () => {
      if (typeof input !== "object" || input === null) return invalid("body must be an object");
      const id = (input as Record<string, unknown>)["id"];
      if (typeof id !== "string" || id.trim().length === 0) return invalid("id is required");

      const policy = parseAutomod(await this.d.config.getSetting(guildId, AUTOMOD_SETTING_KEY));
      const rules = policy.rules.filter((r) => r.id !== id);
      if (rules.length === policy.rules.length) {
        return { result: { ok: true }, change: { id, removed: false }, note: "That rule is already gone." };
      }

      const result = await this.d.config.setSetting(guildId, AUTOMOD_SETTING_KEY, {
        enabled: policy.enabled,
        rules,
      });
      return { result, change: { id, removed: true }, note: "Rule removed." };
    });
  }

  /**
   * The master switch, on its own so that switching automod off is one click
   * that cannot half-succeed — which is the state an operator wants it in at
   * exactly the moment something is firing that should not be.
   */
  async setAutomodEnabled(
    session: PanelSession | null,
    guildId: string,
    input: unknown,
  ): Promise<MutationResult> {
    return this.run(session, guildId, "automod.enable", async () => {
      if (typeof input !== "object" || input === null) return invalid("body must be an object");
      const enabled = (input as Record<string, unknown>)["enabled"];
      if (typeof enabled !== "boolean") return invalid("enabled must be a boolean");

      const policy = parseAutomod(await this.d.config.getSetting(guildId, AUTOMOD_SETTING_KEY));
      const result = await this.d.config.setSetting(guildId, AUTOMOD_SETTING_KEY, {
        enabled,
        rules: policy.rules,
      });
      return {
        result,
        change: { enabled, rules: policy.rules.length },
        note: enabled
          ? `Automod is on — ${policy.rules.filter((r) => r.enabled).length} rule(s) active.`
          : "Automod is off. Your rules are kept.",
      };
    });
  }

  /**
   * How long a member waits between commands, and between relayed messages.
   *
   * The relay figure is a comfort setting layered *on top of* flood control,
   * never a replacement for it: the hard per-user window that protects the
   * bridge account from Hypixel's own limit is not reachable from here, by
   * design, because a guild that set it to zero would be rate-limiting the bot
   * rather than themselves.
   */
  async setCooldowns(session: PanelSession | null, guildId: string, input: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "config.cooldowns", async () => {
      if (typeof input !== "object" || input === null) return invalid("body must be an object");
      const body = input as Record<string, unknown>;

      const rawDefault = body["commandDefaultSeconds"] ?? null;
      if (rawDefault !== null && !isCount(rawDefault, MAX_COOLDOWN_SECONDS)) {
        return invalid(
          `commandDefaultSeconds must be a whole number from 0 to ${MAX_COOLDOWN_SECONDS}, or null to leave each command on its own`,
        );
      }

      const rawRelay = body["relaySeconds"] ?? 0;
      if (!isCount(rawRelay, MAX_COOLDOWN_SECONDS)) {
        return invalid(`relaySeconds must be a whole number from 0 to ${MAX_COOLDOWN_SECONDS}`);
      }

      const rawPer = body["perCommand"] ?? {};
      if (typeof rawPer !== "object" || rawPer === null || Array.isArray(rawPer)) {
        return invalid("perCommand must be an object of command → seconds");
      }
      const entries = Object.entries(rawPer as Record<string, unknown>);
      if (entries.length > MAX_COOLDOWN_OVERRIDES) {
        return invalid(`perCommand may hold at most ${MAX_COOLDOWN_OVERRIDES} overrides`);
      }
      const perCommand: Record<string, number> = {};
      for (const [command, value] of entries) {
        if (!COMMAND_NAME_RE.test(command)) return invalid(`“${command}” is not a command name`);
        if (!isCount(value, MAX_COOLDOWN_SECONDS)) {
          return invalid(`perCommand.${command} must be a whole number from 0 to ${MAX_COOLDOWN_SECONDS}`);
        }
        perCommand[command] = value as number;
      }

      const policy = {
        commandDefaultSeconds: rawDefault as number | null,
        perCommand,
        relaySeconds: rawRelay as number,
      };
      const result = await this.d.config.setSetting(guildId, COOLDOWN_SETTING_KEY, policy);
      return { result, change: { ...policy, perCommand: { ...perCommand } } };
    });
  }

  // ──────────────────────── permissions ─────────────────────────

  /**
   * Replace the Discord roles bound to one platform level.
   *
   * A whole set per call rather than add/remove pairs: the page edits a
   * multi-select, and an add-and-remove protocol would leave a half-applied
   * binding on the floor if the second call failed.
   */
  async setRoleBinding(session: PanelSession | null, guildId: string, input: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "roles.binding", async () => {
      const body = asObject(input);
      if (body === null) return invalid("body must be an object");

      const role = body["role"];
      if (!isMemberRole(role)) return invalid(`role must be one of ${ROLES.join(", ")}`);

      const raw = body["discordRoleIds"] ?? [];
      if (!Array.isArray(raw)) return invalid("discordRoleIds must be a list of Discord role ids");
      if (raw.length > MAX_ROLE_BINDINGS) {
        return invalid(`a level can be bound to at most ${MAX_ROLE_BINDINGS} Discord roles`);
      }
      const ids: string[] = [];
      for (const id of raw) {
        if (typeof id !== "string" || !SNOWFLAKE.test(id)) return invalid("discordRoleIds must all be Discord role ids");
        if (!ids.includes(id)) ids.push(id);
      }

      const result = await this.d.config.setRoleBinding(guildId, role, ids);
      return { result, change: { role, discordRoleIds: [...ids] } };
    });
  }

  /**
   * Map an in-game guild rank to a level, or clear the mapping.
   *
   * Read-modify-write of the one policy document, like every other write on this
   * page. The alternative — a column per dimension — would make "what is this
   * guild's permission model" four reads that can disagree with each other.
   */
  async setRankMapping(session: PanelSession | null, guildId: string, input: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "roles.rank", async () => {
      const body = asObject(input);
      if (body === null) return invalid("body must be an object");

      const rawRank = body["rank"];
      if (typeof rawRank !== "string") return invalid("rank must be the in-game rank's name");
      const rank = normalizeRank(rawRank);
      if (rank.length === 0 || rank.length > MAX_RANK_NAME) {
        return invalid(`a rank name must be 1–${MAX_RANK_NAME} characters`);
      }

      // null clears; anything else has to be a level.
      const role = body["role"] ?? null;
      if (role !== null && !isMemberRole(role)) return invalid(`role must be one of ${ROLES.join(", ")}, or null`);

      return this.writePolicy(guildId, { rank, role }, (policy) => {
        const guildRanks = { ...policy.guildRanks };
        if (role === null) delete guildRanks[rank];
        else guildRanks[rank] = role;
        if (Object.keys(guildRanks).length > MAX_RANK_MAPPINGS) {
          return `a guild can map at most ${MAX_RANK_MAPPINGS} in-game ranks`;
        }
        return { ...policy, guildRanks };
      });
    });
  }

  /** Set the lowest level that holds one bridge capability. */
  async setCapabilityFloor(session: PanelSession | null, guildId: string, input: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "roles.capability", async () => {
      const body = asObject(input);
      if (body === null) return invalid("body must be an object");

      const capability = body["capability"];
      if (typeof capability !== "string" || !(CAPABILITIES as readonly string[]).includes(capability)) {
        return invalid(`capability must be one of ${CAPABILITIES.join(", ")}`);
      }
      const role = body["role"];
      if (!isMemberRole(role)) return invalid(`role must be one of ${ROLES.join(", ")}`);

      return this.writePolicy(guildId, { capability, role }, (policy) => ({
        ...policy,
        capabilities: { ...policy.capabilities, [capability as BridgeCapability]: role },
      }));
    });
  }

  /**
   * Override the level a named command needs, or clear the override.
   *
   * Clearing stores nothing rather than storing the handler's current default:
   * a command whose compiled-in floor is later raised must not stay lowered by a
   * policy written against the old one.
   */
  async setCommandFloor(session: PanelSession | null, guildId: string, input: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "roles.command", async () => {
      const body = asObject(input);
      if (body === null) return invalid("body must be an object");

      const rawCommand = body["command"];
      if (typeof rawCommand !== "string") return invalid("command must be a command name");
      // Normalized before it is checked, not after: a name is stored in one
      // shape, so `/Warn` and `warn` have to be the same override rather than
      // one override and one rejection.
      const command = rawCommand.trim().toLowerCase().replace(/^\//, "");
      if (!COMMAND_NAME_RE.test(command)) return invalid("command must be a command name");

      const role = body["role"] ?? null;
      if (role !== null && !isMemberRole(role)) return invalid(`role must be one of ${ROLES.join(", ")}, or null`);

      return this.writePolicy(guildId, { command, role }, (policy) => {
        const commands = { ...policy.commands };
        if (role === null) delete commands[command];
        else commands[command] = role;
        if (Object.keys(commands).length > MAX_COMMAND_OVERRIDES) {
          return `a guild can override at most ${MAX_COMMAND_OVERRIDES} commands`;
        }
        return { ...policy, commands };
      });
    });
  }

  /**
   * Grant or deny one capability to one subject, overriding the level's floor.
   *
   * `allow: false` is not the same as deleting the row and the API keeps them
   * apart, because the resolver does: a deny beats every grant and every floor,
   * so it is the strongest statement available here and has to be asked for
   * explicitly rather than arrived at by clearing something.
   */
  async setPermissionException(
    session: PanelSession | null,
    guildId: string,
    input: unknown,
  ): Promise<MutationResult> {
    return this.run(session, guildId, "roles.exception", async () => {
      const body = asObject(input);
      if (body === null) return invalid("body must be an object");

      const subjectType = body["subjectType"];
      if (!isSubjectKind(subjectType)) {
        return invalid("subjectType must be DISCORD_ROLE, DISCORD_USER or GUILD_RANK");
      }
      const rawSubject = body["subjectId"];
      if (typeof rawSubject !== "string") return invalid("subjectId is required");
      const subjectId = rawSubject.trim();
      if (subjectType === "GUILD_RANK") {
        if (subjectId.length === 0 || subjectId.length > MAX_RANK_NAME) {
          return invalid(`a rank name must be 1–${MAX_RANK_NAME} characters`);
        }
      } else if (!SNOWFLAKE.test(subjectId)) {
        return invalid("subjectId must be a Discord id for role and user subjects");
      }

      const capability = body["capability"];
      if (typeof capability !== "string" || !(CAPABILITIES as readonly string[]).includes(capability)) {
        return invalid(`capability must be one of ${CAPABILITIES.join(", ")}`);
      }
      const allow = body["allow"];
      if (typeof allow !== "boolean") return invalid("allow must be true (grant) or false (deny)");

      const store = this.d.permissionExceptions;
      if (!store) return unavailable("Per-person exceptions aren't available in this deployment");

      await store.set(guildId, subjectType, subjectId, capability, allow);
      return { result: { ok: true }, change: { subjectType, subjectId, capability, allow } };
    });
  }

  /** Drop one exception, restoring whatever the subject's level says. */
  async removePermissionException(
    session: PanelSession | null,
    guildId: string,
    input: unknown,
  ): Promise<MutationResult> {
    return this.run(session, guildId, "roles.exception.remove", async () => {
      const body = asObject(input);
      if (body === null) return invalid("body must be an object");
      const id = body["id"];
      if (typeof id !== "string" || id.length === 0) return invalid("id is required");

      const store = this.d.permissionExceptions;
      if (!store) return unavailable("Per-person exceptions aren't available in this deployment");

      // A gone row is reported rather than passed off as a deletion: the id came
      // from a page that may be minutes stale, and "removed" about something
      // another admin already removed is a small lie with a confusing sequel.
      if (!(await store.remove(guildId, id))) return invalid("that exception no longer exists");
      return { result: { ok: true }, change: { id } };
    });
  }

  /**
   * Read the stored policy, apply one edit, validate the whole result, write it.
   *
   * The validation is of the *result*, not the patch, and it is the strict
   * validator rather than the tolerant reader — so a document that a previous
   * release wrote and this one would silently drop fields from is refused here
   * instead of being quietly rewritten into something smaller.
   */
  private async writePolicy(
    guildId: string,
    change: Record<string, unknown>,
    edit: (policy: RolePolicy) => RolePolicy | string,
  ): Promise<Step> {
    const current = parseRolePolicy(await this.d.config.getSetting<unknown>(guildId, ROLE_POLICY_SETTING_KEY));
    const next = edit(current);
    if (typeof next === "string") return invalid(next);

    const complaint = validateRolePolicy(next);
    if (complaint !== null) return invalid(complaint);

    // The reader hands back a policy with every default filled in, so writing
    // `next` verbatim would freeze today's defaults into the guild's document
    // the first time anyone maps a rank — and a later change to the platform
    // floor would then silently skip every guild that had ever saved anything.
    // Only the floors that actually differ are stored, for the same reason a
    // cleared command override stores nothing.
    const capabilities: Record<string, MemberRole> = {};
    for (const [capability, role] of Object.entries(next.capabilities)) {
      if (DEFAULT_CAPABILITY_FLOOR[capability as BridgeCapability] !== role) capabilities[capability] = role;
    }

    const result = await this.d.config.setSetting(guildId, ROLE_POLICY_SETTING_KEY, { ...next, capabilities });
    return { result, change };
  }

  // ─────────────────────────── health ───────────────────────────

  /**
   * Start a scheduled worker by hand.
   *
   * Nothing is written here and nothing is awaited: the request is published and
   * the worker fleet queues it. That is why the success note says *requested*
   * rather than *ran* — the Health page's last-run column is what turns a
   * request into a fact, and a button that claimed more than it knows would be
   * the first thing an operator stopped believing.
   */
  async runJob(session: PanelSession | null, guildId: string, input: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "health.run-job", async (actorDiscordId) => {
      if (typeof input !== "object" || input === null) return invalid("body must be an object");
      const jobName = (input as Record<string, unknown>)["jobName"];
      if (typeof jobName !== "string" || jobName.length === 0) return invalid("jobName is required");

      const jobs = this.d.jobs;
      if (!jobs) {
        return { error: { kind: "SERVICE_ERROR", detail: "this deployment has no worker fleet to ask" } };
      }
      if (!jobs.runnable.includes(jobName)) {
        // Named rather than generic: the panel offers the button, so a name it
        // will not accept means the two halves disagree, and the operator is the
        // one who has to notice.
        return invalid(`“${jobName}” is not a job that can be started by hand`);
      }

      // A second gate, per job and per guild rather than per person: the point
      // is to bound how often the work happens, and two admins each inside their
      // own two-second window is exactly how a snapshot pass gets run four times
      // in a minute. Deliberately not scoped to the actor for that reason.
      const gate = await this.d.limiter.consume(manualJobKey(guildId, jobName), MANUAL_JOB_COOLDOWN_MS);
      if (!gate.allowed) {
        return {
          error: {
            kind: "RATE_LIMITED" as const,
            detail: `${jobName} was started very recently — give it a minute to finish`,
            ...(gate.retryAfterMs === undefined ? {} : { retryAfterMs: gate.retryAfterMs }),
          },
        };
      }

      try {
        await jobs.trigger({ jobName, guildId, actorDiscordId });
      } catch (error) {
        return {
          error: {
            kind: "SERVICE_ERROR" as const,
            detail: error instanceof Error ? error.message : "the request could not be sent",
          },
        };
      }

      return {
        result: { ok: true } as const,
        change: { jobName },
        note: "Requested. If the workers are running it will start within a moment — the last-run column is what confirms it.",
      };
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

      const result = await this.d.community.closeTicket(
        ticketId,
        staffActor(actorDiscordId),
        note.length === 0 ? null : note,
      );
      return { result, change: { ticketId, reason: note || null } };
    });
  }

  /**
   * Take a ticket, so the queue shows who is answering it.
   *
   * The service refuses a second claimant and a category with claiming switched
   * off; neither is re-checked here, because a rule enforced in two places
   * drifts and the one in `@sbr/tickets` is the one the Discord buttons use too.
   */
  async claimTicket(session: PanelSession | null, guildId: string, ticketId: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "ticket.claim", async (actorDiscordId) => {
      if (typeof ticketId !== "string" || !ENTITY_ID.test(ticketId)) {
        return invalid("ticketId must be a ticket id");
      }
      const result = await this.d.community.claimTicket(ticketId, staffActor(actorDiscordId));
      return { result, change: { ticketId } };
    });
  }

  /** Hand a ticket to another staffer. */
  async transferTicket(
    session: PanelSession | null,
    guildId: string,
    ticketId: unknown,
    toDiscordId: unknown,
  ): Promise<MutationResult> {
    return this.run(session, guildId, "ticket.transfer", async (actorDiscordId) => {
      if (typeof ticketId !== "string" || !ENTITY_ID.test(ticketId)) {
        return invalid("ticketId must be a ticket id");
      }
      if (typeof toDiscordId !== "string" || !SNOWFLAKE.test(toDiscordId)) {
        return invalid("toDiscordId must be a Discord user id");
      }
      const result = await this.d.community.transferTicket(ticketId, staffActor(actorDiscordId), toDiscordId);
      return { result, change: { ticketId, toDiscordId } };
    });
  }

  /**
   * Send a closed ticket's transcript to its opener again.
   *
   * Exists because the first DM can fail against a closed DM channel, and the
   * panel shows that failure rather than swallowing it. Refuses on a ticket
   * whose transcript was never rendered — there is nothing to send, and saying
   * so beats a DM that silently never arrives.
   */
  async resendTicketTranscript(
    session: PanelSession | null,
    guildId: string,
    ticketId: unknown,
  ): Promise<MutationResult> {
    return this.run(session, guildId, "ticket.transcript.resend", async (actorDiscordId) => {
      const effects = this.d.ticketEffects;
      if (effects === undefined) return unavailable("No bot is connected to send the transcript");
      if (typeof ticketId !== "string" || !ENTITY_ID.test(ticketId)) {
        return invalid("ticketId must be a ticket id");
      }
      const found = await this.d.community.getTicket(ticketId);
      if (!found.ok) return { result: found, change: { ticketId } };
      const ticket = found.value;
      if (ticket === null || ticket.guildId !== guildId) return invalid("no such ticket");
      if (!ticket.transcriptReady) return invalid("this ticket has no transcript yet");

      try {
        await effects.resendTranscript(guildId, ticketId, actorDiscordId);
      } catch (error) {
        return { error: { kind: "SERVICE_ERROR", detail: describe(error) } };
      }
      return { result: { ok: true }, change: { ticketId, number: ticket.number } };
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
   * Change an event that has not finished yet.
   *
   * Only the keys present in the body are sent on, so the page can submit the
   * one section the operator opened. `isStaff` is true because reaching this
   * mutation already required the Officer tier: the host rule inside
   * `CommunityService` is there for command callers, and re-applying it here
   * would mean an officer could not fix a colleague's typo.
   */
  async updateEvent(session: PanelSession | null, guildId: string, input: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "event.update", async (actorDiscordId) => {
      if (typeof input !== "object" || input === null) return invalid("body must be an object");
      const body = input as Record<string, unknown>;

      const eventId = body["eventId"];
      if (typeof eventId !== "string" || !ENTITY_ID.test(eventId)) return invalid("eventId must be an event id");

      const found = await this.d.community.getEvent(eventId);
      if (!found.ok) return { result: found, change: { eventId } };
      // Checked here rather than left to the service: the service knows about
      // events, not about which server is asking, and an id from another guild
      // must not be editable by pasting it into this one's page.
      if (found.value === null || found.value.guildId !== guildId) return invalid("no such event");

      const edit: Record<string, unknown> = { eventId, actorDiscordId, isStaff: true };

      if (body["title"] !== undefined) {
        const title = typeof body["title"] === "string" ? body["title"].trim() : "";
        if (title.length === 0) return invalid("a title is required");
        if (title.length > EVENT_TITLE_MAX) return invalid(`title must be under ${EVENT_TITLE_MAX} characters`);
        edit["title"] = title;
      }

      if (body["description"] !== undefined) {
        const raw = typeof body["description"] === "string" ? body["description"].trim() : "";
        if (raw.length > DESCRIPTION_MAX) return invalid(`description must be under ${DESCRIPTION_MAX} characters`);
        edit["description"] = raw.length === 0 ? null : raw;
      }

      if (body["startsAt"] !== undefined) {
        const startsAt = body["startsAt"];
        if (typeof startsAt !== "string" || Number.isNaN(Date.parse(startsAt))) {
          return invalid("startsAt must be a date and time");
        }
        edit["startsAt"] = new Date(startsAt).toISOString();
      }

      if (body["capacity"] !== undefined) {
        const raw = body["capacity"];
        if (raw !== null) {
          if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_CAPACITY) {
            return invalid(`capacity must be a whole number between 1 and ${MAX_CAPACITY}`);
          }
        }
        edit["capacity"] = raw;
      }

      if (body["trackedMetrics"] !== undefined) {
        const raw = body["trackedMetrics"];
        if (!Array.isArray(raw) || raw.some((metric) => typeof metric !== "string")) {
          return invalid("trackedMetrics must be a list of metric names");
        }
        const unknown = (raw as string[]).filter((metric) => !EVENT_METRICS.includes(metric));
        if (unknown.length > 0) return invalid(`unknown metric: ${unknown.join(", ")}`);
        edit["trackedMetrics"] = raw as string[];
      }

      if (body["pollIntervalMinutes"] !== undefined) {
        const raw = body["pollIntervalMinutes"];
        if (typeof raw !== "number" || !Number.isInteger(raw)) return invalid("pollIntervalMinutes must be a number");
        edit["pollIntervalMinutes"] = raw;
      }

      if (body["tracksProgression"] !== undefined) {
        if (typeof body["tracksProgression"] !== "boolean") return invalid("tracksProgression must be true or false");
        edit["tracksProgression"] = body["tracksProgression"];
      }

      const result = await this.d.community.updateEvent(edit as unknown as EventEdit);
      // The actor and the staff flag are how the write was authorised, not what
      // changed, and the audit trail records the actor of its own accord.
      const { actorDiscordId: _actor, isStaff: _staff, ...changed } = edit;
      return { result, change: changed };
    });
  }

  /**
   * Mark an event as run.
   *
   * Deliberately manual. The scheduler cannot know an event finished — it knows
   * only that its start time has passed — and closing one automatically would
   * write a result card in the middle of a run that went long.
   */
  async completeEvent(session: PanelSession | null, guildId: string, eventId: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "event.complete", async (actorDiscordId) => {
      if (typeof eventId !== "string" || !ENTITY_ID.test(eventId)) {
        return invalid("eventId must be an event id");
      }
      const found = await this.d.community.getEvent(eventId);
      if (!found.ok) return { result: found, change: { eventId } };
      if (found.value === null || found.value.guildId !== guildId) return invalid("no such event");

      const result = await this.d.community.completeEvent(eventId, actorDiscordId, true);
      return { result, change: { eventId } };
    });
  }

  /**
   * Record who actually turned up.
   *
   * The list replaces the hand-marked one wholesale, because the page submits
   * the ticked boxes rather than a diff — what is on screen is what is stored.
   * Rows the tracker wrote are untouched by this: the poller watched the event
   * and the person ticking boxes is remembering it, so the observation wins.
   */
  async markAttendance(session: PanelSession | null, guildId: string, input: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "event.attendance", async (actorDiscordId) => {
      if (typeof input !== "object" || input === null) return invalid("body must be an object");
      const body = input as Record<string, unknown>;

      const eventId = body["eventId"];
      if (typeof eventId !== "string" || !ENTITY_ID.test(eventId)) return invalid("eventId must be an event id");

      const raw = body["discordIds"];
      if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) {
        return invalid("discordIds must be a list of Discord ids");
      }
      const discordIds = raw as string[];
      if (discordIds.length > MAX_ATTENDEES) return invalid(`at most ${MAX_ATTENDEES} people can be marked at once`);
      const malformed = discordIds.filter((id) => !SNOWFLAKE.test(id));
      if (malformed.length > 0) return invalid(`not a Discord id: ${malformed[0]}`);

      const found = await this.d.community.getEvent(eventId);
      if (!found.ok) return { result: found, change: { eventId } };
      if (found.value === null || found.value.guildId !== guildId) return invalid("no such event");

      const result = await this.d.community.markAttendance({
        eventId,
        actorDiscordId,
        isStaff: true,
        discordIds,
      });
      return { result, change: { eventId, marked: discordIds.length } };
    });
  }

  /**
   * Redraw the tracker board now, rather than waiting for the half-hourly pass.
   *
   * The button exists because the pass is the slowest thing about the feature:
   * an organiser who has just corrected the metric list wants to see the board
   * agree with it, and half an hour of a wrong board is half an hour of members
   * asking why their score is missing.
   */
  async publishEventBoard(session: PanelSession | null, guildId: string, eventId: unknown): Promise<MutationResult> {
    return this.run(session, guildId, "event.board.publish", async (actorDiscordId) => {
      const effects = this.d.eventEffects;
      if (effects === undefined) return unavailable("No bot is connected to post the board");
      if (typeof eventId !== "string" || !ENTITY_ID.test(eventId)) {
        return invalid("eventId must be an event id");
      }
      const found = await this.d.community.getEvent(eventId);
      if (!found.ok) return { result: found, change: { eventId } };
      if (found.value === null || found.value.guildId !== guildId) return invalid("no such event");

      try {
        await effects.publishBoard(guildId, eventId, actorDiscordId);
      } catch (error) {
        return { error: { kind: "SERVICE_ERROR", detail: describe(error) } };
      }
      return { result: { ok: true }, change: { eventId } };
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

    return { access, ok: true, error: null, ...(step.note === undefined ? {} : { note: step.note }) };
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
      /** Carried to `MutationResult.note` when the write succeeds. */
      readonly note?: string;
    };

function invalid(detail: string): Step {
  return { error: { kind: "INVALID_INPUT", detail } };
}

/**
 * Bounds on the automod test box. Generous enough for anything a member could
 * actually send — Discord's own limit is 2,000 — and finite so the endpoint
 * cannot be used to run a regex over a megabyte of text.
 */
const MAX_AUTOMOD_TEST_LENGTH = 2_000;
const MAX_AUTOMOD_TEST_MENTIONS = 200;
const MAX_AUTOMOD_TEST_COUNTER = 10_000;

/** The verdict in words, for the line the operator reads back. */
function describeAutomodAction(action: "FLAG" | "WARN" | "MUTE", durationSeconds: number | null): string {
  if (action === "FLAG") return "Flagged for staff";
  if (action === "WARN") return "Warned";
  return durationSeconds === null ? "Muted indefinitely" : `Muted for ${formatSeconds(durationSeconds)}`;
}

/**
 * Bounds on the policy itself. A guild with two hundred rules has a performance
 * problem it cannot see, since every rule runs on every message on both
 * surfaces; the cap is where an operator finds that out from a refusal rather
 * than from a slow bridge.
 */
const MAX_AUTOMOD_RULES = 40;
const MAX_AUTOMOD_RULE_NAME = 60;
const MAX_AUTOMOD_PATTERN = 300;
const MAX_AUTOMOD_ALLOWLIST = 50;
const MAX_AUTOMOD_WINDOW_SECONDS = 3_600;
/** A day. Longer than this is a ban dressed as a mute, and should be issued as one. */
const MAX_AUTOMOD_MUTE_SECONDS = 86_400;
const MAX_AUTOMOD_EXEMPT_ROLES = 25;

const MAX_COOLDOWN_OVERRIDES = 60;
/** Discord's own rule for a command name, which is also what our registry uses. */
const COMMAND_NAME_RE = /^[a-z0-9_-]{1,32}$/;

/**
 * Bounds on the permission model.
 *
 * All four are far above what a guild has and far below what would make
 * resolution slow: every bound Discord role is compared against the member's on
 * each permission question, and the whole policy is parsed on each read.
 */
const MAX_ROLE_BINDINGS = 25;
const MAX_RANK_MAPPINGS = 50;
const MAX_RANK_NAME = 64;
const MAX_COMMAND_OVERRIDES = 100;

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

function isSubjectKind(value: unknown): value is PermSubjectKind {
  return value === "DISCORD_ROLE" || value === "DISCORD_USER" || value === "GUILD_RANK";
}

const AUTOMOD_SURFACES: readonly ModerationSurface[] = ["DISCORD", "GUILD_CHAT"];
const BRIDGE_CAPABILITIES = Object.values(BridgeCapability);

/**
 * Validate one rule off the wire.
 *
 * Returns the rule or the sentence to show. Every branch refuses rather than
 * repairs: a rule quietly corrected on save is a rule the operator believes says
 * something it does not, and this one deletes messages and mutes people.
 */
function readAutomodRule(input: unknown): { rule: AutomodRule } | { error: string } {
  if (typeof input !== "object" || input === null) return { error: "body must be an object" };
  const body = input as Record<string, unknown>;

  const id = body["id"];
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return { error: "id must be 1–64 characters of letters, digits, dash or underscore" };
  }

  const name = body["name"];
  if (typeof name !== "string" || name.trim().length === 0) return { error: "name is required" };
  if (name.length > MAX_AUTOMOD_RULE_NAME) {
    return { error: `name must be ${MAX_AUTOMOD_RULE_NAME} characters or fewer` };
  }

  const enabled = body["enabled"];
  if (typeof enabled !== "boolean") return { error: "enabled must be a boolean" };

  const rawSurfaces = body["surfaces"];
  if (!Array.isArray(rawSurfaces) || rawSurfaces.length === 0) {
    return { error: "pick at least one surface" };
  }
  const surfaces: ModerationSurface[] = [];
  for (const s of rawSurfaces) {
    if (s !== "DISCORD" && s !== "GUILD_CHAT") {
      return { error: `surfaces must be drawn from ${AUTOMOD_SURFACES.join(", ")}` };
    }
    if (!surfaces.includes(s)) surfaces.push(s);
  }

  const trigger = readAutomodTrigger(body["trigger"]);
  if ("error" in trigger) return trigger;

  const rawExempt = body["exempt"] ?? {};
  if (typeof rawExempt !== "object" || rawExempt === null || Array.isArray(rawExempt)) {
    return { error: "exempt must be an object" };
  }
  const exemptBody = rawExempt as Record<string, unknown>;
  const rawRoles = exemptBody["roleIds"] ?? [];
  if (!Array.isArray(rawRoles) || rawRoles.length > MAX_AUTOMOD_EXEMPT_ROLES) {
    return { error: `exempt.roleIds must be a list of up to ${MAX_AUTOMOD_EXEMPT_ROLES} role ids` };
  }
  const roleIds: string[] = [];
  for (const role of rawRoles) {
    if (typeof role !== "string" || !SNOWFLAKE.test(role)) {
      return { error: "exempt.roleIds must all be Discord role ids" };
    }
    if (!roleIds.includes(role)) roleIds.push(role);
  }
  const rawCapability = exemptBody["capability"] ?? null;
  if (rawCapability !== null && !BRIDGE_CAPABILITIES.includes(rawCapability as BridgeCapability)) {
    return { error: `exempt.capability must be null or one of ${BRIDGE_CAPABILITIES.join(", ")}` };
  }

  const rawAction = body["action"];
  if (typeof rawAction !== "object" || rawAction === null) return { error: "action is required" };
  const actionBody = rawAction as Record<string, unknown>;
  const type = actionBody["type"];
  if (typeof type !== "string" || !AUTOMOD_ACTION_TYPES.includes(type as AutomodActionType)) {
    return { error: `action.type must be one of ${AUTOMOD_ACTION_TYPES.join(", ")}` };
  }
  const deleteMessage = actionBody["deleteMessage"];
  if (typeof deleteMessage !== "boolean") return { error: "action.deleteMessage must be a boolean" };

  const rawDuration = actionBody["durationSeconds"] ?? null;
  if (type !== "MUTE" && rawDuration !== null) {
    // Refused rather than dropped: a duration on a FLAG means the operator
    // believes they configured a timed action, and they did not.
    return { error: "only a mute carries a duration" };
  }
  if (rawDuration !== null && (!isCount(rawDuration, MAX_AUTOMOD_MUTE_SECONDS) || rawDuration < 1)) {
    return {
      error: `action.durationSeconds must be from 1 to ${MAX_AUTOMOD_MUTE_SECONDS} seconds, or null for an open-ended mute`,
    };
  }

  // FLAG records and notifies. A FLAG that also does nothing to the message is
  // a rule with no effect at all, which is worth saying out loud once rather
  // than letting somebody wonder why nothing happens.
  if (type === "FLAG" && !deleteMessage && trigger.trigger.kind === "wordlist") {
    // The wordlist already flags on its own; this pairing is the one that
    // genuinely duplicates existing behaviour.
    return { error: "a flag-only wordlist rule duplicates the chat filter — give it an action or delete the message" };
  }

  return {
    rule: {
      id,
      name: name.trim(),
      enabled,
      surfaces,
      trigger: trigger.trigger,
      exempt: { roleIds, capability: (rawCapability as BridgeCapability | null) ?? null },
      action: { type: type as AutomodActionType, deleteMessage, durationSeconds: rawDuration as number | null },
    },
  };
}

function readAutomodTrigger(input: unknown): { trigger: AutomodTrigger } | { error: string } {
  if (typeof input !== "object" || input === null) return { error: "trigger is required" };
  const t = input as Record<string, unknown>;
  const kind = t["kind"];
  if (typeof kind !== "string" || !AUTOMOD_TRIGGER_KINDS.includes(kind as AutomodTriggerKind)) {
    return { error: `trigger.kind must be one of ${AUTOMOD_TRIGGER_KINDS.join(", ")}` };
  }

  const window = (): { seconds: number } | { error: string } => {
    const value = t["windowSeconds"];
    if (!isCount(value, MAX_AUTOMOD_WINDOW_SECONDS) || (value as number) < 1) {
      return { error: `windowSeconds must be from 1 to ${MAX_AUTOMOD_WINDOW_SECONDS}` };
    }
    return { seconds: value as number };
  };

  switch (kind) {
    case "wordlist":
      return { trigger: { kind: "wordlist" } };
    case "invites":
      return { trigger: { kind: "invites" } };
    case "regex": {
      const pattern = t["pattern"];
      if (typeof pattern !== "string" || pattern.trim().length === 0) return { error: "trigger.pattern is required" };
      if (pattern.length > MAX_AUTOMOD_PATTERN) {
        return { error: `trigger.pattern must be ${MAX_AUTOMOD_PATTERN} characters or fewer` };
      }
      const flags = t["flags"] ?? "";
      if (typeof flags !== "string" || !/^[gimsuy]*$/.test(flags)) {
        return { error: "trigger.flags may only contain g, i, m, s, u or y" };
      }
      try {
        new RegExp(pattern, flags.includes("i") ? flags : `${flags}i`);
      } catch {
        // The one place a refusal is doing real work: an unparseable pattern
        // saved here would drop the whole rule the next time the policy loaded.
        return { error: "that is not a valid regular expression" };
      }
      return { trigger: { kind: "regex", pattern, flags } };
    }
    case "spam": {
      const messages = t["messages"];
      if (!isCount(messages, 100) || (messages as number) < 2) {
        return { error: "trigger.messages must be from 2 to 100" };
      }
      const w = window();
      if ("error" in w) return w;
      return { trigger: { kind: "spam", messages: messages as number, windowSeconds: w.seconds } };
    }
    case "repeat": {
      const times = t["times"];
      if (!isCount(times, 100) || (times as number) < 2) return { error: "trigger.times must be from 2 to 100" };
      const w = window();
      if ("error" in w) return w;
      return { trigger: { kind: "repeat", times: times as number, windowSeconds: w.seconds } };
    }
    case "mentions": {
      const max = t["max"];
      if (!isCount(max, 100) || (max as number) < 1) return { error: "trigger.max must be from 1 to 100" };
      return { trigger: { kind: "mentions", max: max as number } };
    }
    case "caps": {
      const percent = t["percent"];
      // Below half, ordinary emphatic typing trips it; the floor is there so a
      // rule cannot be saved that fires on almost everything.
      if (!isCount(percent, 100) || (percent as number) < 50) {
        return { error: "trigger.percent must be from 50 to 100" };
      }
      const minLength = t["minLength"];
      if (!isCount(minLength, 500) || (minLength as number) < 4) {
        return { error: "trigger.minLength must be from 4 to 500" };
      }
      return { trigger: { kind: "caps", percent: percent as number, minLength: minLength as number } };
    }
    default: {
      const raw = t["allowlist"] ?? [];
      if (!Array.isArray(raw) || raw.length > MAX_AUTOMOD_ALLOWLIST) {
        return { error: `trigger.allowlist must be a list of up to ${MAX_AUTOMOD_ALLOWLIST} hostnames` };
      }
      const allowlist: string[] = [];
      for (const host of raw) {
        if (typeof host !== "string" || !/^[a-z0-9.-]{3,253}$/i.test(host) || !host.includes(".")) {
          return { error: `“${String(host)}” is not a hostname` };
        }
        const lower = host.toLowerCase();
        if (!allowlist.includes(lower)) allowlist.push(lower);
      }
      return { trigger: { kind: "links", allowlist } };
    }
  }
}

/** Whole units, largest that divides exactly — the same rule the relay's own formatter uses. */
function formatSeconds(seconds: number): string {
  const s = Math.max(1, Math.floor(seconds));
  if (s % 86_400 === 0) return `${s / 86_400}d`;
  if (s % 3_600 === 0) return `${s / 3_600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
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

/**
 * A refused filter rule, in words the person editing the form can act on.
 *
 * INVALID_INPUT rather than SERVICE_ERROR for both: an unparseable regex and a
 * pattern that already exists are things the admin typed, and the form is where
 * they get fixed. The service's own `detail` carries the regex engine's
 * complaint, which is more useful than anything this layer could paraphrase.
 */
function wordlistRefusal(error: WordlistError): MutationError {
  return error.kind === "DUPLICATE"
    ? { kind: "INVALID_INPUT", detail: "this guild already has a rule with that pattern and match type" }
    : { kind: "INVALID_INPUT", detail: error.detail };
}

/** What asking Hypixel about a guild can tell us, once the noise is collapsed. */
type GuildLookupOutcome =
  | { readonly kind: "found"; readonly id: string; readonly name: string | null }
  | { readonly kind: "missing" }
  | { readonly kind: "unreachable" };

/**
 * Resolve a guild, separating "Hypixel says there is no such guild" from "we
 * could not ask Hypixel". The distinction is the whole design of the link flow:
 * the first is a typo the admin should fix, the second must not stop onboarding.
 */
async function lookupHypixelGuild(
  lookup: HypixelGuildLookup,
  query: string,
  by: "id" | "name",
): Promise<GuildLookupOutcome> {
  try {
    const found = await lookup.getGuild(query, by);
    if (found.ok) return { kind: "found", id: found.value.data.id, name: found.value.data.name };
    // Only a successful response with no guild in it is a definitive no. A
    // disabled key or a spent rate limit is silence, and reading silence as
    // "that guild doesn't exist" would refuse a correct id during an outage.
    return found.error.state === "MISSING_PROFILE" ? { kind: "missing" } : { kind: "unreachable" };
  } catch (error) {
    // HypixelUnavailableError is thrown rather than returned. Anything else is a
    // real fault and must not be laundered into an outage.
    if (isUpstreamUnavailable(error)) return { kind: "unreachable" };
    throw error;
  }
}

/** A whole number in `[0, max]` — the shape every XP limit shares. */
function isCount(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

/**
 * A list of Discord role ids, or null when it is not one.
 *
 * Null rather than an exception because every caller turns it straight into the
 * same `invalid(...)`, and null keeps that decision at the call site where the
 * field name is still in scope.
 */
function roleIdList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_TICKET_ROLE_IDS) return null;
  if (value.some((entry) => typeof entry !== "string" || !SNOWFLAKE.test(entry))) return null;
  return value as readonly string[];
}

/**
 * The actor a ticket transition is carried out as.
 *
 * `isStaff` is unconditionally true here and that is not a shortcut: every
 * mutation reaching this function is gated at MODERATOR or above by
 * `MUTATION_TIERS`, so anyone whose call got this far *is* staff. The flag
 * exists for the Discord side, where a member clicking a button on their own
 * ticket is not.
 */
function staffActor(discordId: string): TicketActor {
  return { discordId, isStaff: true };
}

function viewColor(value: unknown): ViewColor | null {
  return typeof value === "string" && VIEW_COLOR_NAMES.includes(value as ViewColor) ? (value as ViewColor) : null;
}

/**
 * Working hours as the editor writes them: `"0"`–`"6"`, Sunday first, each an
 * open and a close time.
 *
 * An absent day means closed all day, which is why a missing key is accepted
 * and an empty object is a valid answer rather than an error — "closed all
 * week" is a real configuration, distinct from "never configured".
 */
function parseWorkingHours(value: unknown): TicketWorkingHoursDTO | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, { open: string; close: string }> = {};
  for (const [day, window] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[0-6]$/.test(day)) return null;
    if (typeof window !== "object" || window === null) return null;
    const { open, close } = window as Record<string, unknown>;
    if (typeof open !== "string" || !CLOCK_TIME.test(open)) return null;
    if (typeof close !== "string" || !CLOCK_TIME.test(close)) return null;
    out[day] = { open, close };
  }
  return out;
}

/**
 * The questions a category asks before the ticket opens.
 *
 * Capped at five because a Discord modal takes five inputs; a sixth would be
 * silently dropped at render time, which is the kind of quiet loss this layer
 * exists to turn into a visible refusal.
 */
function parseQuestions(value: unknown): readonly TicketQuestionDTO[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_TICKET_QUESTIONS) return null;
  const out: TicketQuestionDTO[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const row = entry as Record<string, unknown>;
    const id = row["id"];
    if (typeof id !== "string" || !TICKET_KEY.test(id) || seen.has(id)) return null;
    seen.add(id);
    const label = row["label"];
    if (typeof label !== "string" || label.trim().length === 0 || label.length > TICKET_QUESTION_LABEL_MAX) {
      return null;
    }
    const placeholder = row["placeholder"] ?? null;
    if (
      placeholder !== null &&
      (typeof placeholder !== "string" || placeholder.length > TICKET_QUESTION_PLACEHOLDER_MAX)
    ) {
      return null;
    }
    const style = row["style"];
    if (style !== "SHORT" && style !== "PARAGRAPH") return null;
    if (typeof row["required"] !== "boolean") return null;
    const maxLength = row["maxLength"] ?? null;
    if (maxLength !== null && (!isCount(maxLength, TICKET_QUESTION_MAX_LENGTH) || maxLength < 1)) return null;
    out.push({
      id,
      label: label.trim(),
      placeholder: placeholder as string | null,
      style,
      required: row["required"],
      maxLength: maxLength as number | null,
    });
  }
  return out;
}

/** Domain errors are tagged unions or Errors; either way the audit wants a word. */
function describe(error: unknown): string {
  if (error && typeof error === "object" && "kind" in error && typeof error.kind === "string") {
    return error.kind;
  }
  if (error instanceof Error) return error.message;
  return "unknown";
}

// ── screening policy validation ─────────────────────────────────────────────

const SCREENING_FLAGS = [
  "enabled",
  "autoAccept",
  "denyOnScammer",
  "reviewOnScammerUnknown",
  "denyOnPriorExpulsion",
  "reviewOnUnreadable",
] as const;

/**
 * The stat bars this used to validate — `minSkyblockLevel`, `minSkillAverage`,
 * `minCatacombs`, `minSenitherWeight`, `minAccountAgeDays`, `maxInactiveDays`
 * and the `minNetworth` coin string — are gone, along with their shared ceiling
 * and their digit-string parser. Screening reports the account rather than
 * grading it, so the only things left to validate are the switches and counts.
 */

const SCREENING_COUNTS = {
  repeatWindowDays: { min: 1, max: 365 },
  maxAttemptsInWindow: { min: 1, max: 100 },
  /** A risk score, so its range is the score's range. */
  reviewAtRisk: { min: 0, max: 100 },
} as const;

const SCREENING_KEYS: readonly string[] = [...SCREENING_FLAGS, ...Object.keys(SCREENING_COUNTS)];

/**
 * The retired bars, still accepted and discarded.
 *
 * The strict-write rule below rejects an unknown key, which is right for a typo
 * but wrong for a field we removed: a panel tab opened before the deploy still
 * posts the old shape, and answering that with "unknown field" reads as a bug
 * rather than as a setting that no longer exists. Named explicitly so the list
 * is a record of what was removed rather than a hole in the validation.
 */
const RETIRED_KEYS: readonly string[] = [
  "minSkyblockLevel",
  "minSkillAverage",
  "minCatacombs",
  "minSenitherWeight",
  "minAccountAgeDays",
  "maxInactiveDays",
  "minNetworth",
];

/**
 * Validate a screening policy payload. Returns the policy, or the message to
 * show the admin — never a half-applied policy.
 */
function readScreeningPolicy(input: unknown): ScreeningPolicy | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "body must be an object";
  const body = input as Record<string, unknown>;

  const unknownKeys = Object.keys(body).filter((k) => !SCREENING_KEYS.includes(k) && !RETIRED_KEYS.includes(k));
  if (unknownKeys.length > 0) return `unknown field(s): ${unknownKeys.join(", ")}`;

  const flags: Record<string, boolean> = {};
  for (const key of SCREENING_FLAGS) {
    const value = body[key];
    if (typeof value !== "boolean") return `${key} must be a boolean`;
    flags[key] = value;
  }

  const counts: Record<string, number> = {};
  for (const [key, range] of Object.entries(SCREENING_COUNTS)) {
    const value = body[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max) {
      return `${key} must be a whole number between ${range.min} and ${range.max}`;
    }
    counts[key] = value;
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
    repeatWindowDays: counts["repeatWindowDays"]!,
    maxAttemptsInWindow: counts["maxAttemptsInWindow"]!,
    reviewAtRisk: counts["reviewAtRisk"]!,
  };
}

// `threshold()` and its ABSENT/INVALID sentinels lived here, reading the
// tri-state recruitment bars. Recruitment is one boolean now, so there is no
// tri-state left to read.
