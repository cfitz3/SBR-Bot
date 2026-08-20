/**
 * PanelService — authorizes a guild-scoped page request, then resolves its view
 * model from the shared services. Every load returns the AccessDecision so the
 * route can render the right allowed/denied state.
 *
 * Reads only. Writes go through the same domain services the bots use (the panel
 * "commands, it doesn't bypass"), so nothing here mutates.
 */
import { CONFIG_CHANNEL_SLOTS, rankOfRole, type MemberRole } from "@sbr/shared-types";
import {
  parseAutomod,
  parseEscalationPolicy,
  parseRelaySync,
  punishmentState,
  AUTOMOD_SETTING_KEY,
  ESCALATION_SETTING_KEY,
  RELAY_SYNC_SETTING_KEY,
  type AutomodPolicy,
  type EscalationPolicy,
  type PunishmentState,
  type RelaySyncPolicy,
} from "@sbr/moderation";
import type {
  AuditQuery,
  CommunityService,
  GuildConfigService,
  GuildRuntimeConfig,
  InfractionDTO,
  MilestoneDefinitionDTO,
  MilestoneDefinitionService,
  TicketCategoryDTO,
  TicketConfigService,
  TicketDTO,
  TicketPanelDTO,
  TicketSettingsDTO,
  TicketTagDTO,
  WordlistRuleDTO,
  WordlistService,
  ModerationActionDTO,
  ModerationService,
  RsvpEntryDTO,
  XpService,
  XpSource,
  XpSourcePolicyDTO,
} from "@sbr/shared-types";
import {
  parsePolicy,
  serializePolicy,
  SCREENING_POLICY_KEY,
  type ScreeningPolicyView,
} from "@sbr/screening";
import {
  CAPABILITIES,
  COOLDOWN_SETTING_KEY,
  DEFAULT_CAPABILITY_FLOOR,
  ROLES,
  ROLE_POLICY_SETTING_KEY,
  capabilityFloor,
  commandFloor,
  parseCooldowns,
  parseRoleBindings,
  parseRolePolicy,
  type CooldownPolicy,
} from "@sbr/guild-config";
import type { Logger } from "@sbr/observability";
import { authorize, type AccessDecision, type PanelSession, type RoleResolver } from "./access.js";
import type { DirectoryKind, DirectorySource, DirectoryVM } from "./directory.js";
import { shapeAnalytics, type MetricChart } from "./series.js";
import type {
  ActivityEntry,
  CommandCatalog,
  PermissionException,
  PermissionExceptionStore,
  CommandUsageStat,
  MessageTotals,
  ActiveMember,
  DailyPoint,
  DirectoryMemberRow,
  DirectorySide,
  GuildCard,
  HeartbeatReader,
  JobHealth,
  JoinAttempt,
  MembershipStats,
  PanelEvent,
  EventStandingRow,
  PanelReads,
  RollupPeriod,
  RollupPoint,
  ServiceHeartbeat,
} from "./reads.js";

/**
 * How old a job's last success may be before the panel calls it STALE.
 *
 * These are roughly three times the scheduled cadence (WORKERS.md §1), not the
 * cadence itself: a single missed tick is normal operation and flagging it would
 * train staff to ignore the badge, which is worse than not having one.
 */
export const STALE_AFTER_MS: Readonly<Record<string, number>> = {
  "bazaar-refresh": 6 * 60_000,
  "ah-sweep": 15 * 60_000,
  "ah-ended-ingest": 5 * 60_000,
  "resources-refresh": 3 * 86_400_000,
  "profile-snapshot": 3 * 60 * 60_000,
  "guild-roster-sync": 90 * 60_000,
  "analytics-ingest": 5 * 60_000,
  "analytics-rollup": 3 * 60 * 60_000,
  "event-transition": 15 * 60_000,
  "config-cache-invalidation": 30 * 60_000,
  "inactivity-scan": 3 * 86_400_000,
  "xp-aggregate": 9 * 60 * 60_000,
};

/** Ticket statuses that are still someone's problem. */
const OPEN_TICKET_STATUSES: ReadonlySet<string> = new Set(["OPEN", "PENDING"]);

export interface OverviewVM {
  readonly memberCount: number;
  readonly activeMemberCount: number;
  readonly linkedMemberCount: number;
  readonly verifiedMemberCount: number;
  readonly recentJoinCount: number;
  readonly recentLeaveCount: number;
  /** Things waiting on a human. */
  readonly openTicketCount: number;
  readonly openInfractionCount: number;
  readonly activeActionCount: number;
  readonly upcomingEventCount: number;
  readonly bridgeSuspended: boolean;
  readonly lastSnapshotAt: string | null;
  /**
   * The two rosters and their movement, reported separately. `memberCount`
   * above is the Discord side alone and stays for the tiles that have always
   * meant that; this is what the membership tab reads.
   */
  readonly membership: MembershipStats;
  /** Newest-first merged feed of what the platform did in this guild. */
  readonly activity: readonly ActivityEntry[];
  /** Recent join attempts with the stat block screening saw at the time. */
  readonly joinAttempts: readonly JoinAttempt[];
}

/**
 * A logged action with its state resolved.
 *
 * The state is computed here rather than in the browser because it is a
 * domain rule — `active` and `expiresAt` disagreeing means different things
 * for different action types — and a second copy of that rule in the client
 * would be one that drifts from the one `/audit` renders.
 */
export interface ModerationActionVM extends ModerationActionDTO {
  readonly state: PunishmentState;
}

export interface WordlistVM {
  /** False when the deployment runs without the filter service wired. */
  readonly installed: boolean;
  readonly rules: readonly WordlistRuleDTO[];
  /** Resolved, not raw: built-in rungs layered under whatever the guild stored. */
  readonly escalation: EscalationPolicy;
  /**
   * What a Discord punishment does in guild chat. Resolved the same way the
   * ladder is, so a row this release added shows up for a guild that customised
   * a different one.
   */
  readonly relaySync: RelaySyncPolicy;
}

export interface ModerationVM {
  readonly target: string;
  readonly infractionCount: number;
  readonly infractions: readonly InfractionDTO[];
  /**
   * The guild's latest infractions regardless of target — what the page shows
   * before anybody has been looked up. Always present, so a moderator arriving
   * at the page sees the week's activity rather than an empty box asking them
   * to already know whose id to type.
   */
  readonly recentInfractions: readonly InfractionDTO[];
  readonly actions: readonly ModerationActionVM[];
  /**
   * The punishments being served right now, guild-wide when no target is named.
   * Separate from `actions` because the log answers "what has happened" and this
   * answers "what is in force" — the same rows read for two different questions,
   * and only the second one is expiry-aware.
   */
  readonly inForce: readonly ModerationActionDTO[];
  /**
   * Whether this session may edit the configuration sections — the automod
   * rules, the filter, the ladder, the mapping table and the cooldowns. The
   * page is Moderator so the people who work the queue can reach it; the
   * sections below it are Admin, and the answer is computed per-load rather
   * than by raising the whole page's tier and shutting moderators out of their
   * own history view. Same shape the tickets page already uses.
   */
  readonly canConfigure: boolean;
  /** The chat filter, the escalation ladder and the in-game mapping table. */
  readonly filter: WordlistVM;
  /** Resolved automod policy — defaults layered under whatever the guild stored. */
  readonly automod: AutomodPolicy;
  readonly cooldowns: CooldownPolicy;
}

export interface SelectorVM {
  readonly guilds: readonly GuildCard[];
}

/**
 * How far apart two presence samples are, in minutes.
 *
 * Pinned to the `guild-scan` cadence in `apps/workers/src/schedule.ts`, which is
 * the only thing positioned to observe who is online. Note that as of this
 * writing **nothing calls `XpService.recordPresence`**, so the counter is always
 * zero and the Analytics page says "not sampled yet" rather than rendering a
 * plausible-looking nothing. Wiring the scan to call it is what turns this
 * constant into a real number; until then it documents the intended unit.
 */
export const PRESENCE_SAMPLE_INTERVAL_MINUTES = 360;

export interface AnalyticsVM {
  readonly period: RollupPeriod;
  readonly since: string;
  /** Exclusive-ish end of the window: the clock reading the query was resolved at. */
  readonly until: string;
  /** Raw rows, kept for the CSV export and for API callers doing their own maths. */
  readonly rollups: readonly RollupPoint[];
  /** The same rows zero-filled and grouped into drawable series. */
  readonly charts: readonly MetricChart[];
  readonly topCommands: readonly CommandUsageStat[];
  /** Message volume over the window, Discord and guild chat kept apart. */
  readonly messages: MessageTotals;
  readonly topMembers: readonly ActiveMember[];
  readonly gexp: readonly DailyPoint[];
  /**
   * Playtime, stated as the estimate it is.
   *
   * Neither surface measures time. Discord presence is *sampled* by the guild
   * scan, so hours are samples × the scan interval; the in-game figure is a
   * count of days with any GEXP at all. The interval travels with the number so
   * the page can say what it is rather than printing an unexplained "hours".
   */
  readonly playtime: {
    readonly presenceSamples: number;
    readonly sampleIntervalMinutes: number;
    readonly gameActiveDays: number;
  };
}

/** One person's response to one event, with the name resolved for display. */
export interface EventRsvp {
  readonly discordId: string;
  readonly username: string | null;
  readonly state: string;
  readonly respondedAt: string;
}

/**
 * One person recorded as having turned up.
 *
 * Deliberately not an `EventRsvp`: attendance is not a response, and somebody
 * can appear here without ever having answered — a walk-in the host marked, or
 * a member the tracker scored who never touched the buttons.
 */
export interface EventAttendee {
  readonly discordId: string;
  readonly username: string | null;
  /** TRACKED is the poller's observation; MARKED is somebody's judgement. */
  readonly source: "TRACKED" | "MARKED";
  readonly recordedBy: string | null;
  readonly recordedAt: string;
}

export interface EventAttendance {
  readonly eventId: string;
  readonly going: readonly EventRsvp[];
  readonly maybe: readonly EventRsvp[];
  readonly declined: readonly EventRsvp[];
  readonly waitlist: readonly EventRsvp[];
  /**
   * Who actually turned up. Empty until the event completes or a host marks
   * somebody, and never inferred from `going` — the whole point of the list is
   * that saying you will come and coming are different events.
   */
  readonly attended: readonly EventAttendee[];
}

/** One member's place on one metric's board, with a name where there is one. */
export interface EventStanding {
  readonly discordId: string;
  readonly username: string | null;
  readonly delta: number;
}

/**
 * One tracked metric's board. A metric with no rows is still present: "nobody
 * has gained anything yet" and "this metric is not being scored" are different
 * facts, and an absent block would blur them.
 */
export interface EventMetricStandings {
  readonly metric: string;
  readonly entries: readonly EventStanding[];
}

export interface EventsVM {
  readonly events: readonly PanelEvent[];
  /** The event whose roster is attached, or "" when none was asked for. */
  readonly selected: string;
  /** Null when nothing is selected, or when the event vanished between reads. */
  readonly attendance: EventAttendance | null;
  /**
   * The open event's live scores, in the order the organiser listed the
   * metrics — the first is the one the Discord board sorts by. Empty when
   * nothing is selected or the event scores nothing.
   */
  readonly standings: readonly EventMetricStandings[];
  /**
   * People who said they are coming but have no verified Minecraft account.
   *
   * The tracker cannot score them — it has nothing to poll — so they would
   * otherwise simply be missing from the board with no explanation. Naming them
   * here is what turns a silent gap into something staff can fix.
   */
  readonly unlinked: readonly EventRsvp[];
}

/** What one roster read yields: the roster itself, and the two things derived from it. */
interface EventDetail {
  readonly attendance: EventAttendance;
  readonly names: ReadonlyMap<string, string | null>;
  readonly unlinked: readonly EventRsvp[];
}

/**
 * Group the scores into one block per tracked metric.
 *
 * The order is the event's own metric order rather than the database's, because
 * the first metric is the one the Discord board ranks by and the panel showing
 * a different first column would make the two look like they disagree. Scores
 * on a metric no longer tracked are dropped from the blocks but not from the
 * database — untracking a metric is a change of what is shown, not a deletion.
 */
function standingsOf(
  metrics: readonly string[],
  scores: readonly EventStandingRow[],
  names: ReadonlyMap<string, string | null>,
): readonly EventMetricStandings[] {
  return metrics.map((metric) => ({
    metric,
    entries: scores
      .filter((score) => score.metric === metric)
      .map((score) => ({ discordId: score.discordId, username: names.get(score.discordId) ?? null, delta: score.delta })),
  }));
}

/**
 * The member directory: both rosters merged, not just the people who linked.
 *
 * There is no `pendingCount`. A "pending" link is a state nothing in
 * `packages/identity` ever writes — the verification either succeeds and the
 * link is VERIFIED or it does not and there is no link — so a tile counting it
 * was always zero and reading it as "awaiting verification" invited staff to
 * wait for something that was never going to arrive. Linked is a yes or a no.
 */
export interface MembersVM {
  readonly rows: readonly DirectoryMemberRow[];
  /** Roster totals, unaffected by the current search. */
  readonly discordCount: number;
  readonly guildCount: number;
  readonly linkedCount: number;
  /** More rows matched than were returned; the page says so rather than lying by omission. */
  readonly truncated: boolean;
  /** The current query, echoed so the client can render the state it asked for. */
  readonly q: string;
  readonly side: DirectorySide;
  /** When each roster was last scanned. Null means it never has been. */
  readonly scannedAt: { readonly discord: string | null; readonly hypixel: string | null };
}

/** Rows returned to one page load. Large enough that most guilds never page. */
export const DIRECTORY_PAGE_SIZE = 300;

export const DIRECTORY_SIDES: readonly DirectorySide[] = ["all", "discord", "game", "unlinked"];

export function isDirectorySide(value: unknown): value is DirectorySide {
  return typeof value === "string" && (DIRECTORY_SIDES as readonly string[]).includes(value);
}

/**
 * Everything the Settings page can change, in one read.
 *
 * It carries what used to be three pages — Settings, Mapping and XP — because
 * the split between them was never one an admin could predict: "which channel
 * does the bridge use" and "is the bridge suspended" are the same question asked
 * twice, and finding them on different tabs cost more than the shorter pages
 * saved. One VM also means one access decision and one round trip for what is
 * one page's worth of configuration.
 */
export interface SettingsVM {
  readonly config: GuildRuntimeConfig | null;
  /**
   * The join-screening policy, always populated: a guild that has never saved
   * one reads back the platform defaults, which are what screening is actually
   * using. Showing an empty form for "unset" would misdescribe a bot that is
   * already applying rules.
   *
   * Serialized (coins as a string) because it crosses the wire as JSON.
   */
  readonly screening: ScreeningPolicyView;
  /**
   * The guild's own record, for the fields that live on `Guild` rather than in
   * its config — currently just the Hypixel link. Null only if the record
   * vanished between the access check and this read.
   */
  readonly guild: GuildCard | null;
  /**
   * Every channel slot in the registry, an unbound one present as null rather
   * than missing, so the page renders a control for it instead of silently
   * omitting the slot nobody has bound yet.
   */
  readonly channels: Readonly<Record<string, string | null>>;
  readonly features: Readonly<Record<string, boolean>>;
  readonly xp: XpSettingsVM;
}

export interface XpSettingsVM {
  /** False when the deployment has no XP service at all — not "all sources off". */
  readonly installed: boolean;
  /**
   * One row per source, always all of them. An unconfigured source is rendered
   * as disabled with zero weight, which is exactly what the engine does with it.
   */
  readonly sources: readonly XpSourcePolicyDTO[];
}

/**
 * Every XP source, in the order the page lists them, so the form is stable
 * across guilds and across reloads. Mirrors the `XpSource` enum; a source
 * missing from this list would be invisible in the panel while still paying out.
 */
export const XP_SOURCE_ORDER: readonly XpSource[] = [
  "GEXP",
  "DISCORD_MESSAGE",
  "GUILD_CHAT_MESSAGE",
  "TENURE",
  "COMMAND_USAGE",
  "EVENT",
  "MILESTONE",
  "MANUAL",
];

export interface MilestonesVM {
  /** False when no definition service is wired; the page then says so. */
  readonly installed: boolean;
  /**
   * Every definition in effect — the built-in defaults with the guild's own
   * rows layered over them, each flagged with which it is. Defaults are
   * included so the page can show what is already being recognised without a
   * guild having to re-create it, and flagged so the client knows an edit to
   * one is a create rather than an update.
   */
  readonly definitions: readonly MilestoneDefinitionDTO[];
}

export interface TicketsVM {
  /** False when no ticket-config service is wired; the page then says so. */
  readonly installed: boolean;
  /**
   * Per-guild behaviour — colours, archiving, the auto-close clock. Filled in
   * with defaults when it has never been configured; null for a reader who may
   * work the queue but not configure it.
   */
  readonly settings: TicketSettingsDTO | null;
  /**
   * Every category the guild has, in menu order, disabled ones included and
   * flagged. There are no built-ins underneath: the five former enum values are
   * seeded as ordinary rows, so a guild that deleted one has deleted it.
   */
  readonly categories: readonly TicketCategoryDTO[];
  /** Every panel, published or not. Publishing is an explicit action. */
  readonly panels: readonly TicketPanelDTO[];
  /** Canned replies and their auto-response patterns. */
  readonly tags: readonly TicketTagDTO[];
  /**
   * Tickets still waiting on a human, newest first.
   *
   * Read even when no ticket-config service is wired: the queue comes from the
   * guild's own rows, and a deployment that stopped offering new ticket types
   * still has the open ones somebody has to answer.
   */
  readonly open: readonly TicketDTO[];
  /**
   * Whether this reader may edit the menu, as opposed to work the queue.
   *
   * Decided here because the tier table lives here: the client has no copy of it
   * and should not grow one. False hides the configuration cards; the mutations
   * behind them refuse independently, so this is presentation, not the gate.
   */
  readonly canConfigure: boolean;
}

/**
 * The processes the Health page expects to find beating.
 *
 * Listed rather than discovered so a service that is *absent* can be reported as
 * DOWN. Deriving the list from whatever answered would make a dead bot look
 * identical to a bot that was never deployed — precisely the distinction someone
 * opens this page to make.
 */
export const EXPECTED_SERVICES = ["bridge-bot", "admin-bot", "workers", "web-panel"] as const;

/**
 * How late a beat may be before the service is called STALE.
 *
 * Longer than the beat interval (15s) and shorter than the key's TTL (45s), so
 * a process that is alive but wedged — still writing, falling behind — has a
 * window where it reads as degraded rather than flipping straight to DOWN.
 */
export const HEARTBEAT_STALE_MS = 30_000;

export interface ServiceInstanceVM {
  readonly instance: string;
  readonly ageMs: number;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ServiceHealthVM {
  readonly service: string;
  readonly status: "UP" | "STALE" | "DOWN";
  readonly instances: readonly ServiceInstanceVM[];
}

export interface HealthVM {
  /**
   * `runnable` is what the page's "Run now" button hangs off. It is carried per
   * row rather than as a separate list because the alternative — the client
   * holding its own copy of the allow-list — is the drift the allow-list exists
   * to prevent: a job the fleet stopped accepting would keep its button.
   */
  readonly jobs: readonly (JobHealth & { readonly stale: boolean; readonly runnable: boolean })[];
  readonly services: readonly ServiceHealthVM[];
  /**
   * Achievements the announcer is holding rather than posting.
   *
   * It lives on Health rather than on the Milestones page because it is not a
   * configuration question — the definitions are fine, the channel is missing —
   * and Health is where a reader already goes to ask what is not working.
   */
  readonly waiting: {
    readonly milestones: number;
    /** False when no `milestones` channel is bound, which is the usual cause. */
    readonly channelBound: boolean;
  };
}

export type PageResult<T> =
  | { readonly access: Extract<AccessDecision, { allowed: true }>; readonly data: T }
  | { readonly access: Extract<AccessDecision, { allowed: false }>; readonly data: null };

/**
 * Permissions — one page for the whole question of what a level *is*.
 *
 * Four sections, in the order the question is actually asked: who is at each
 * level, what each level may do on the bridge, what each level may run, and who
 * the answer is wrong about.
 *
 * Every row carries its platform default beside its current value, because the
 * useful question on this page is never "what does it say" but "what have we
 * changed" — an operator debugging a permission needs to see at a glance which
 * of thirty rows their guild actually touched.
 */
export interface PermissionsVM {
  /** The ladder, lowest first. The render order for every control here. */
  readonly roles: readonly string[];
  /** Level → the Discord roles that confer it, as stored. */
  readonly bindings: Readonly<Record<string, readonly string[]>>;
  /** In-game rank → level, sorted by name. Normalised keys, as stored. */
  readonly guildRanks: readonly { readonly rank: string; readonly role: string }[];
  readonly capabilities: readonly PermissionCapabilityVM[];
  /**
   * Every staff command with its floor. Empty when no catalog was supplied —
   * `commandsAvailable` is what says which of the two it is.
   */
  readonly commands: readonly PermissionCommandVM[];
  readonly commandsAvailable: boolean;
  readonly exceptions: readonly PermissionException[];
  readonly exceptionsAvailable: boolean;
}

export interface PermissionCapabilityVM {
  readonly capability: string;
  /** The level in force. */
  readonly role: string;
  /** What it would be if the guild had configured nothing. */
  readonly defaultRole: string;
}

export interface PermissionCommandVM {
  readonly name: string;
  readonly description: string;
  readonly role: string;
  readonly defaultRole: string;
  /** True when this guild has written an override, whatever its value. */
  readonly overridden: boolean;
}

export interface PanelServiceDeps {
  readonly roles: RoleResolver;
  readonly community: CommunityService;
  readonly moderation: ModerationService;
  readonly reads: PanelReads;
  readonly config: GuildConfigService;
  /**
   * Optional: a deployment can run with XP switched off entirely, and the page
   * then says so rather than showing seven disabled sources, which would read
   * as "configured off" instead of "not installed".
   */
  readonly xp?: XpService;
  /** Optional for the same reason as XP: absent means the page reports it. */
  readonly milestones?: MilestoneDefinitionService;
  /** Optional: absent means the Tickets page reports itself not installed. */
  readonly tickets?: TicketConfigService;
  /** Optional: absent means the Wordlist page reports itself not installed. */
  readonly wordlist?: WordlistService;
  /** Optional: without it the Health page shows jobs only, not live processes. */
  readonly heartbeats?: HeartbeatReader;
  /**
   * Optional: without it the Permissions page renders its levels, floors and
   * command table but reports that per-person exceptions are unavailable —
   * rather than showing an empty list, which would read as "none configured".
   */
  readonly permissionExceptions?: PermissionExceptionStore;
  /** Optional for the same reason: absent means no command table, said so. */
  readonly commands?: CommandCatalog;
  /**
   * Optional: absent means every picker reports itself unavailable and the
   * config pages fall back to raw-id entry. That is the deployment shape when
   * no INTERNAL_API_TOKEN is set, and it must stay a working panel.
   */
  readonly directory?: DirectorySource;
  /**
   * Job names this deployment will start on request. Passed in rather than
   * imported so panel-core keeps no dependency on the Redis package that owns
   * the bus; absent means no "Run now" buttons, which is the honest rendering
   * of a panel with no worker fleet to ask.
   */
  readonly runnableJobs?: readonly string[];
  readonly logger: Logger;
}

/**
 * Fold raw beats into one row per expected service.
 *
 * A service is graded on its *freshest* instance: with two bridge-bots running,
 * one wedged and one healthy, the bridge is up. The stale instance still appears
 * in the list, because "up, but one replica is lagging" is a real state and
 * summarising it away is how a half-broken deployment stays invisible.
 */
function gradeServices(
  beats: readonly ServiceHeartbeat[],
  now: number,
): readonly ServiceHealthVM[] {
  const byService = new Map<string, ServiceInstanceVM[]>();
  for (const beat of beats) {
    const ageMs = now - Date.parse(beat.at);
    const list = byService.get(beat.service) ?? [];
    // A beat stamped in the future means clock skew between processes, not a
    // negative age; clamping keeps that from reading as impossibly healthy.
    list.push({ instance: beat.instance, ageMs: Math.max(0, ageMs), details: beat.details });
    byService.set(beat.service, list);
  }

  // Expected services first and always present; anything else that reported in
  // is appended rather than dropped, so a new process is visible before this
  // list learns about it.
  const names = [...EXPECTED_SERVICES, ...[...byService.keys()].filter((s) => !EXPECTED_SERVICES.includes(s as never))];

  return names.map((service) => {
    const instances = (byService.get(service) ?? []).sort((a, b) => a.ageMs - b.ageMs);
    const freshest = instances[0];
    const status: ServiceHealthVM["status"] =
      freshest === undefined ? "DOWN" : freshest.ageMs > HEARTBEAT_STALE_MS ? "STALE" : "UP";
    return { service, status, instances };
  });
}

export class PanelService {
  private readonly d: PanelServiceDeps;
  private readonly log: Logger;

  constructor(deps: PanelServiceDeps) {
    this.d = deps;
    this.log = deps.logger.child({ service: "panel" });
  }

  // ─────────────────────────── selector (not guild-scoped) ───────────────────────────

  /**
   * The guild selector is the one page with no guild to authorize against; the
   * gate is simply "are you logged in", and the manageable set was already
   * resolved from Discord at login.
   */
  async loadSelector(session: PanelSession | null): Promise<PageResult<SelectorVM>> {
    if (!session) {
      return { access: { allowed: false, reason: "NOT_AUTHENTICATED" }, data: null };
    }
    const guilds = await this.d.reads.listGuildCards(session.manageableGuildIds);
    return { access: { allowed: true, role: "MEMBER" }, data: { guilds } };
  }

  // ─────────────────────────── overview ───────────────────────────

  async loadOverview(session: PanelSession | null, guildId: string): Promise<PageResult<OverviewVM>> {
    const access = await authorize(session, guildId, "overview", this.d.roles);
    if (!access.allowed) return this.denied(access, "overview", guildId);

    const [counts, lastSnapshotAt, config, membership, activity, joinAttempts] = await Promise.all([
      this.d.reads.overviewCounts(guildId),
      this.d.reads.lastSnapshotAt(guildId),
      this.d.config.get(guildId),
      this.d.reads.membershipStats(guildId),
      this.d.reads.listActivity(guildId, 40),
      this.d.reads.listJoinAttempts(guildId, 15),
    ]);

    const data: OverviewVM = {
      ...counts,
      bridgeSuspended: config.ok ? (config.value?.bridgeSuspended ?? false) : false,
      lastSnapshotAt,
      membership,
      activity,
      joinAttempts,
    };
    return { access, data };
  }

  // ─────────────────────────── moderation ───────────────────────────

  async loadModeration(
    session: PanelSession | null,
    guildId: string,
    targetDiscordId: string,
  ): Promise<PageResult<ModerationVM>> {
    const access = await authorize(session, guildId, "moderation", this.d.roles);
    if (!access.allowed) return this.denied(access, "moderation", guildId);

    const now = new Date();
    const query: AuditQuery = { guildId, limit: 50, ...(targetDiscordId ? { targetDiscordId } : {}) };
    // Only asked when somebody is named: with no target this would be a query
    // for the member whose id is the empty string, which is nobody.
    const targeted =
      targetDiscordId === "" ? null : this.d.moderation.listInfractions(guildId, targetDiscordId);
    const [infractions, recent, actions, inForce, filter, storedAutomod, storedCooldowns] = await Promise.all([
      targeted,
      this.d.moderation.listRecentInfractions(guildId, 50),
      this.d.moderation.listActions(query),
      // Empty target means the whole guild, which is what the page shows before
      // anybody has been looked up.
      this.d.moderation.listInForce(guildId, targetDiscordId === "" ? null : targetDiscordId),
      this.loadFilter(guildId),
      this.d.config.getSetting<unknown>(guildId, AUTOMOD_SETTING_KEY),
      this.d.config.getSetting<unknown>(guildId, COOLDOWN_SETTING_KEY),
    ]);

    const list = infractions !== null && infractions.ok ? infractions.value : [];
    const data: ModerationVM = {
      target: targetDiscordId,
      infractionCount: list.length,
      infractions: list,
      recentInfractions: recent.ok ? recent.value : [],
      actions: (actions.ok ? actions.value : []).map((a) => ({ ...a, state: punishmentState(a, now) })),
      inForce: inForce.ok ? inForce.value : [],
      canConfigure: rankOfRole(access.role) >= rankOfRole("ADMIN"),
      filter,
      automod: parseAutomod(storedAutomod),
      cooldowns: parseCooldowns(storedCooldowns),
    };
    return { access, data };
  }

  // ─────────────────────────── analytics ───────────────────────────

  async loadAnalytics(
    session: PanelSession | null,
    guildId: string,
    opts: { period?: RollupPeriod; rangeDays?: number; metrics?: readonly string[] } = {},
  ): Promise<PageResult<AnalyticsVM>> {
    const access = await authorize(session, guildId, "analytics", this.d.roles);
    if (!access.allowed) return this.denied(access, "analytics", guildId);

    const period = opts.period ?? "DAILY";
    // Clamped: an unbounded range on a chart endpoint is a table scan waiting
    // for someone to paste a large number into the query string.
    const rangeDays = Math.min(Math.max(opts.rangeDays ?? 30, 1), 365);
    const until = new Date();
    const since = new Date(until.getTime() - rangeDays * 86_400_000);

    const [rollups, topCommands, messages, topMembers, gexp] = await Promise.all([
      this.d.reads.listRollups({
        guildId,
        period,
        since,
        ...(opts.metrics ? { metrics: opts.metrics } : {}),
      }),
      this.d.reads.topCommands(guildId, since),
      this.d.reads.messageTotals(guildId, since),
      this.d.reads.topActiveMembers(guildId, since),
      this.d.reads.gexpSeries(guildId, rangeDays),
    ]);

    // Shaped here rather than in the browser so the raw rows stay the API's
    // contract while the client receives arrays it can draw without re-deriving
    // the bucket grid — and so the zero-filling is unit-tested server-side.
    const charts = shapeAnalytics(rollups, {
      period,
      since: since.toISOString(),
      until: until.toISOString(),
    });

    return {
      access,
      data: {
        period,
        since: since.toISOString(),
        until: until.toISOString(),
        rollups,
        charts,
        topCommands,
        messages,
        topMembers,
        gexp,
        playtime: {
          presenceSamples: topMembers.reduce((sum, m) => sum + m.presenceSamples, 0),
          sampleIntervalMinutes: PRESENCE_SAMPLE_INTERVAL_MINUTES,
          gameActiveDays: topMembers.reduce((sum, m) => sum + (m.activeDays ?? 0), 0),
        },
      },
    };
  }

  // ─────────────────────────── events ───────────────────────────

  /**
   * The events list, plus one event's roster when `eventId` names one.
   *
   * The roster travels on the same read rather than its own route, mirroring
   * Moderation's `?target=`: opening an event is a change of what you're looking
   * at, not a different page, and one round trip keeps the list and the roster
   * from disagreeing about the same event's counts.
   */
  async loadEvents(
    session: PanelSession | null,
    guildId: string,
    eventId = "",
  ): Promise<PageResult<EventsVM>> {
    const access = await authorize(session, guildId, "events", this.d.roles);
    if (!access.allowed) return this.denied(access, "events", guildId);

    const events = await this.d.reads.listEvents(guildId);
    const selected = eventId.trim();
    const open = events.find((event) => event.id === selected) ?? null;
    if (open === null) {
      // An unknown id is treated as no selection rather than an error: the id
      // comes from the URL, and a stale link should show the list, not a fault.
      return { access, data: { events, selected: "", attendance: null, standings: [], unlinked: [] } };
    }

    const [detail, scores] = await Promise.all([
      this.attendanceOf(guildId, selected),
      // Asked for whether or not the event scores anything: an event whose
      // metrics were cleared mid-run still has the scores it collected, and
      // hiding them would look like the tracker had lost them.
      this.d.reads.eventStandings(selected),
    ]);

    return {
      access,
      data: {
        events,
        selected,
        attendance: detail?.attendance ?? null,
        standings: standingsOf(open.trackedMetrics, scores, detail?.names ?? new Map()),
        unlinked: detail?.unlinked ?? [],
      },
    };
  }

  /**
   * One event's RSVPs with names attached, plus the two things computed from
   * the same roster read: who is unlinked, and the names the standings borrow.
   *
   * The roster stores Discord ids; the roster read supplies the usernames, so a
   * page whose whole job is "who is coming" shows people rather than snowflakes.
   * A member with no platform record still appears — unnamed is better than
   * missing from a list someone is about to count heads from.
   */
  private async attendanceOf(guildId: string, eventId: string): Promise<EventDetail | null> {
    const [result, members] = await Promise.all([
      this.d.community.getAttendance(eventId),
      this.d.reads.listLinkedMembers(guildId),
    ]);
    if (!result.ok) return null;

    const names = new Map(members.map((member) => [member.discordId, member.username ?? null]));
    // Verified, not merely present: an unverified row has no account the
    // tracker may poll, so counting it as linked would promise a score that
    // never arrives.
    const linked = new Set(
      members.filter((member) => member.verification === "VERIFIED" && member.uuid !== null)
        .map((member) => member.discordId),
    );
    const roster = (entries: readonly RsvpEntryDTO[]): readonly EventRsvp[] =>
      entries.map((entry) => ({
        discordId: entry.discordId,
        username: names.get(entry.discordId) ?? null,
        state: entry.state,
        respondedAt: entry.respondedAt,
      }));

    const dto = result.value;
    const going = roster(dto.going);
    return {
      attendance: {
        eventId,
        going,
        maybe: roster(dto.maybe),
        declined: roster(dto.declined),
        waitlist: roster(dto.waitlist),
        attended: dto.attended.map((entry) => ({
          discordId: entry.discordId,
          username: names.get(entry.discordId) ?? null,
          source: entry.source,
          recordedBy: entry.recordedBy,
          recordedAt: entry.recordedAt,
        })),
      },
      names,
      // Only the people who said they are coming: a "maybe" who never linked is
      // not a problem anybody has to fix before the event starts.
      unlinked: going.filter((entry) => !linked.has(entry.discordId)),
    };
  }

  // ─────────────────────────── linked members ───────────────────────────

  async loadMembers(
    session: PanelSession | null,
    guildId: string,
    query: { q?: string; side?: string } = {},
  ): Promise<PageResult<MembersVM>> {
    const access = await authorize(session, guildId, "members", this.d.roles);
    if (!access.allowed) return this.denied(access, "members", guildId);

    // An unrecognised side falls back to "all" rather than erroring: it arrives
    // from a URL a user can edit, and the honest response to a nonsense filter
    // is the unfiltered list, not a broken page.
    const side: DirectorySide = isDirectorySide(query.side) ? query.side : "all";
    const q = (query.q ?? "").slice(0, 100);

    const [page, scannedAt] = await Promise.all([
      this.d.reads.listDirectory(guildId, { q, side, limit: DIRECTORY_PAGE_SIZE }),
      this.d.reads.directoryScannedAt(guildId),
    ]);

    return {
      access,
      data: {
        rows: page.rows,
        discordCount: page.discordCount,
        guildCount: page.guildCount,
        linkedCount: page.linkedCount,
        truncated: page.truncated,
        q,
        side,
        scannedAt,
      },
    };
  }

  // ─────────────────────────── settings + mapping ───────────────────────────

  async loadSettings(session: PanelSession | null, guildId: string): Promise<PageResult<SettingsVM>> {
    const access = await authorize(session, guildId, "settings", this.d.roles);
    if (!access.allowed) return this.denied(access, "settings", guildId);

    const xp = this.d.xp;
    const [config, policy, cards, xpPolicy] = await Promise.all([
      this.d.config.get(guildId),
      this.d.config.getSetting<unknown>(guildId, SCREENING_POLICY_KEY),
      this.d.reads.listGuildCards([guildId]),
      xp === undefined ? Promise.resolve(null) : xp.policy(guildId),
    ]);

    const cfg = config.ok ? config.value : null;
    return {
      access,
      data: {
        config: cfg,
        guild: cards[0] ?? null,
        // Read through the same tolerant parser the bridge bot uses, so the
        // page shows what screening will actually do with the stored value
        // rather than a prettier version of what is in the row.
        screening: serializePolicy(parsePolicy(policy)),
        // Built from the slot registry over the canonical `channels` map, not
        // from the five legacy columns: every slot appears, and an unbound one
        // appears as null rather than being missing.
        channels: Object.fromEntries(
          CONFIG_CHANNEL_SLOTS.map((slot) => [slot, cfg?.channels[slot] ?? null] as const),
        ),
        features: cfg?.features ?? {},
        xp:
          xpPolicy === null
            ? { installed: false, sources: [] }
            : {
                installed: true,
                // Filled out to the full list here rather than in the client:
                // what an unconfigured source does is the engine's rule, and the
                // page should show that rule rather than a second guess at it.
                sources: XP_SOURCE_ORDER.map(
                  (source) =>
                    xpPolicy[source] ?? {
                      source,
                      enabled: false,
                      weight: 0,
                      dailyCap: null,
                      cooldownSec: 0,
                      minLength: 0,
                    },
                ),
              },
      },
    };
  }

  // ─────────────────────────── health ───────────────────────────

  /**
   * The milestone configuration page: what the guild recognises and pays for.
   *
   * Definitions only. Who has reached what is member-facing and stays in the
   * bots (`/milestones`), the same line the XP page draws between rules and
   * standings.
   */
  async loadMilestones(session: PanelSession | null, guildId: string): Promise<PageResult<MilestonesVM>> {
    const access = await authorize(session, guildId, "milestones", this.d.roles);
    if (!access.allowed) return this.denied(access, "milestones", guildId);

    const milestones = this.d.milestones;
    if (milestones === undefined) return { access, data: { installed: false, definitions: [] } };

    return { access, data: { installed: true, definitions: await milestones.list(guildId) } };
  }

  /**
   * The ticket configuration page: what a member may open, and the panel that
   * advertises it.
   *
   * Configuration only. The open tickets themselves — and whatever a member put
   * in one — stay in the bot, which is the same line every other page here
   * draws between rules and the people they apply to.
   */
  async loadTickets(session: PanelSession | null, guildId: string): Promise<PageResult<TicketsVM>> {
    const access = await authorize(session, guildId, "tickets", this.d.roles);
    if (!access.allowed) return this.denied(access, "tickets", guildId);

    const tickets = this.d.tickets;
    // The queue is read first and unconditionally: it comes from the guild's own
    // rows, not from the config service, so "ticketing isn't installed" must not
    // hide tickets that are already open and waiting on someone.
    const all = await this.d.reads.listTickets(guildId);
    const open = all.filter((ticket) => OPEN_TICKET_STATUSES.has(ticket.status));
    const canConfigure = rankOfRole(access.role) >= rankOfRole("ADMIN");

    if (tickets === undefined || !canConfigure) {
      return {
        access,
        data: {
          installed: tickets !== undefined,
          settings: null,
          categories: [],
          panels: [],
          tags: [],
          open,
          canConfigure,
        },
      };
    }

    const [settings, categories, panels, tags] = await Promise.all([
      tickets.getSettings(guildId),
      tickets.listCategories(guildId),
      tickets.listPanels(guildId),
      tickets.listTags(guildId),
    ]);
    return { access, data: { installed: true, settings, categories, panels, tags, open, canConfigure } };
  }

  /**
   * The chat filter and the escalation ladder on one page.
   *
   * They are two halves of the same question — what the platform does about a
   * member without a staffer present — and splitting them would mean an admin
   * tuning the filter's severities had to open a different page to see what
   * those severities eventually add up to.
   */
  /**
   * Kept as its own page id even though the nav entry is gone and the content
   * now renders inside Moderation. Removing a page id is a contract break for
   * anything driving the JSON API directly (§0), where removing a tab is not.
   */
  async loadWordlist(session: PanelSession | null, guildId: string): Promise<PageResult<WordlistVM>> {
    const access = await authorize(session, guildId, "wordlist", this.d.roles);
    if (!access.allowed) return this.denied(access, "wordlist", guildId);
    return { access, data: await this.loadFilter(guildId) };
  }

  /** The filter block, shared by the standalone page and the Moderation page. */
  private async loadFilter(guildId: string): Promise<WordlistVM> {
    const wordlist = this.d.wordlist;
    // The escalation policy is readable either way: it is a setting, not a
    // service, and a deployment without the filter still escalates warnings.
    const [storedEscalation, storedRelay] = await Promise.all([
      this.d.config.getSetting<unknown>(guildId, ESCALATION_SETTING_KEY),
      this.d.config.getSetting<unknown>(guildId, RELAY_SYNC_SETTING_KEY),
    ]);
    const escalation = parseEscalationPolicy(storedEscalation);
    const relaySync = parseRelaySync(storedRelay);
    if (wordlist === undefined) return { installed: false, rules: [], escalation, relaySync };

    const rules = await wordlist.list(guildId);
    return { installed: true, rules: rules.ok ? rules.value : [], escalation, relaySync };
  }

  /**
   * The permission model, assembled from the two stores that hold it.
   *
   * Bindings live on `GuildConfig.roleMappings` (where `/set-role` writes them)
   * and everything else in the `roles.policy` setting. Both are read through the
   * same tolerant parsers the bots resolve permissions with, so the page shows
   * what is actually in force rather than a tidier reading of the stored rows.
   */
  async loadPermissions(session: PanelSession | null, guildId: string): Promise<PageResult<PermissionsVM>> {
    const access = await authorize(session, guildId, "permissions", this.d.roles);
    if (!access.allowed) return this.denied(access, "permissions", guildId);

    const [config, stored, exceptions] = await Promise.all([
      this.d.config.get(guildId),
      this.d.config.getSetting<unknown>(guildId, ROLE_POLICY_SETTING_KEY),
      // An unreadable exception store must not blank the rest of the page: the
      // floors above it are the part most guilds ever configure.
      this.d.permissionExceptions?.list(guildId).catch((error: unknown) => {
        this.log.warn("permission exceptions unreadable", {
          guildId,
          error: error instanceof Error ? error.message : "unknown",
        });
        return null;
      }) ?? Promise.resolve(null),
    ]);

    const policy = parseRolePolicy(stored);
    const bindings = parseRoleBindings(config.ok ? config.value?.roleMappings : {});
    const catalog = this.d.commands?.list() ?? null;

    return {
      access,
      data: {
        roles: [...ROLES],
        bindings: Object.fromEntries(ROLES.map((role) => [role, bindings[role]] as const)),
        guildRanks: Object.entries(policy.guildRanks)
          .map(([rank, role]) => ({ rank, role: role as string }))
          .sort((a, b) => a.rank.localeCompare(b.rank)),
        capabilities: CAPABILITIES.map((capability) => ({
          capability,
          role: capabilityFloor(policy, capability),
          defaultRole: DEFAULT_CAPABILITY_FLOOR[capability],
        })),
        commands: (catalog ?? []).map((entry) => ({
          name: entry.name,
          description: entry.description,
          role: commandFloor(policy, entry.name, entry.minRole as MemberRole),
          defaultRole: entry.minRole,
          overridden: policy.commands[entry.name.trim().toLowerCase()] !== undefined,
        })),
        commandsAvailable: catalog !== null,
        exceptions: exceptions ?? [],
        exceptionsAvailable: exceptions !== null,
      },
    };
  }

  async loadHealth(session: PanelSession | null, guildId: string): Promise<PageResult<HealthVM>> {
    const access = await authorize(session, guildId, "health", this.d.roles);
    if (!access.allowed) return this.denied(access, "health", guildId);

    // Liveness failing must not blank the job table: an unreachable Redis is
    // itself something the reader wants to see the rest of the page during.
    const [jobs, beats, pendingMilestones, config] = await Promise.all([
      this.d.reads.listJobHealth(),
      this.d.heartbeats?.list().catch((error: unknown) => {
        this.log.warn("heartbeat read failed", {
          guildId,
          error: error instanceof Error ? error.message : "unknown",
        });
        return [] as const;
      }) ?? Promise.resolve([] as const),
      // A count that cannot be read is reported as zero rather than failing the
      // page: this is a hint, and the jobs table beside it is the reason to be
      // here.
      this.d.reads.pendingMilestones(guildId).catch(() => 0),
      this.d.config.get(guildId),
    ]);

    const now = Date.now();
    const runnable = this.d.runnableJobs ?? [];
    return {
      access,
      data: {
        jobs: jobs.map((j) => {
          const threshold = STALE_AFTER_MS[j.type] ?? 60 * 60_000;
          const stale = j.lastRunAt === null || now - Date.parse(j.lastRunAt) > threshold;
          // No list configured means no worker bus is wired, so nothing here can
          // be started by hand — false, not "assume yes", so the page does not
          // offer a button whose only outcome is an error.
          return { ...j, stale, runnable: runnable.includes(j.type) };
        }),
        services: gradeServices(beats, now),
        waiting: {
          milestones: pendingMilestones,
          channelBound:
            config.ok && config.value !== null && (config.value.channels.milestones ?? "") !== "",
        },
      },
    };
  }

  // ─────────────────────────── directory (backs the pickers) ───────────────────────────

  /**
   * A guild's channels, roles or members, for a picker control.
   *
   * Authorized like any other read — the two gates are the whole reason this
   * goes through the panel rather than the browser calling the bot — but it
   * never fails: an unreachable bot answers `available: false`, and the control
   * degrades to raw-id entry instead of the page erroring.
   */
  async loadDirectory(
    session: PanelSession | null,
    guildId: string,
    kind: DirectoryKind,
    q: string,
  ): Promise<PageResult<DirectoryVM>> {
    const access = await authorize(session, guildId, "directory", this.d.roles);
    if (!access.allowed) return this.denied(access, "directory", guildId);

    const source = this.d.directory;
    if (source === undefined) return { access, data: { kind, available: false, rows: [] } as DirectoryVM };

    switch (kind) {
      case "channels": {
        const { available, rows } = await source.channels(guildId, q);
        return { access, data: { kind: "channels", available, rows } };
      }
      case "roles": {
        const { available, rows } = await source.roles(guildId, q);
        return { access, data: { kind: "roles", available, rows } };
      }
      case "members": {
        const { available, rows } = await source.members(guildId, q);
        return { access, data: { kind: "members", available, rows } };
      }
    }
  }

  private denied<T>(
    access: Extract<AccessDecision, { allowed: false }>,
    page: string,
    guildId: string,
  ): PageResult<T> {
    this.log.warn("panel access denied", { page, guildId, reason: access.reason });
    return { access, data: null };
  }
}
