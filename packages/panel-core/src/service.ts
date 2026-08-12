/**
 * PanelService — authorizes a guild-scoped page request, then resolves its view
 * model from the shared services. Every load returns the AccessDecision so the
 * route can render the right allowed/denied state.
 *
 * Reads only. Writes go through the same domain services the bots use (the panel
 * "commands, it doesn't bypass"), so nothing here mutates.
 */
import { CONFIG_CHANNEL_SLOTS, rankOfRole } from "@sbr/shared-types";
import {
  parseEscalationPolicy,
  punishmentState,
  ESCALATION_SETTING_KEY,
  type EscalationPolicy,
  type PunishmentState,
} from "@sbr/moderation";
import type {
  AuditQuery,
  CommunityService,
  GuildConfigService,
  GuildRuntimeConfig,
  InfractionDTO,
  MilestoneDefinitionDTO,
  MilestoneDefinitionService,
  TicketConfigService,
  TicketPanelConfigDTO,
  TicketTypeDTO,
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
import type { Logger } from "@sbr/observability";
import { authorize, type AccessDecision, type PanelSession, type RoleResolver } from "./access.js";
import { shapeAnalytics, type MetricChart } from "./series.js";
import type {
  CommandUsageStat,
  GuildCard,
  HeartbeatReader,
  JobHealth,
  LinkedMember,
  PanelEvent,
  PanelReads,
  PanelTicket,
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
}

export interface ModerationVM {
  readonly target: string;
  readonly infractionCount: number;
  readonly infractions: readonly InfractionDTO[];
  readonly actions: readonly ModerationActionVM[];
  /**
   * The punishments being served right now, guild-wide when no target is named.
   * Separate from `actions` because the log answers "what has happened" and this
   * answers "what is in force" — the same rows read for two different questions,
   * and only the second one is expiry-aware.
   */
  readonly inForce: readonly ModerationActionDTO[];
}

export interface SelectorVM {
  readonly guilds: readonly GuildCard[];
}

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
}

/** One person's response to one event, with the name resolved for display. */
export interface EventRsvp {
  readonly discordId: string;
  readonly username: string | null;
  readonly state: string;
  readonly respondedAt: string;
}

export interface EventAttendance {
  readonly eventId: string;
  readonly going: readonly EventRsvp[];
  readonly maybe: readonly EventRsvp[];
  readonly declined: readonly EventRsvp[];
  readonly waitlist: readonly EventRsvp[];
}

export interface EventsVM {
  readonly events: readonly PanelEvent[];
  /** The event whose roster is attached, or "" when none was asked for. */
  readonly selected: string;
  /** Null when nothing is selected, or when the event vanished between reads. */
  readonly attendance: EventAttendance | null;
}

export interface MembersVM {
  readonly members: readonly LinkedMember[];
  readonly unlinkedCount: number;
  readonly pendingCount: number;
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
  readonly roleMappings: Readonly<Record<string, string>>;
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
   * Every type in effect — the built-ins with the guild's own rows layered over
   * them, each flagged with which it is, so the client knows an edit to a
   * built-in is a create rather than an update.
   */
  readonly types: readonly TicketTypeDTO[];
  /** Panel content, filled in with defaults when it has never been configured. */
  readonly panel: TicketPanelConfigDTO | null;
  /**
   * Tickets still waiting on a human, newest first.
   *
   * Read even when no ticket-config service is wired: the queue comes from the
   * guild's own rows, and a deployment that stopped offering new ticket types
   * still has the open ones somebody has to answer.
   */
  readonly open: readonly PanelTicket[];
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
  readonly jobs: readonly (JobHealth & { readonly stale: boolean })[];
  readonly services: readonly ServiceHealthVM[];
}

export type PageResult<T> =
  | { readonly access: Extract<AccessDecision, { allowed: true }>; readonly data: T }
  | { readonly access: Extract<AccessDecision, { allowed: false }>; readonly data: null };

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

    const [counts, lastSnapshotAt, config] = await Promise.all([
      this.d.reads.overviewCounts(guildId),
      this.d.reads.lastSnapshotAt(guildId),
      this.d.config.get(guildId),
    ]);

    const data: OverviewVM = {
      ...counts,
      bridgeSuspended: config.ok ? (config.value?.bridgeSuspended ?? false) : false,
      lastSnapshotAt,
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
    const [infractions, actions, inForce] = await Promise.all([
      this.d.moderation.listInfractions(guildId, targetDiscordId),
      this.d.moderation.listActions(query),
      // Empty target means the whole guild, which is what the page shows before
      // anybody has been looked up.
      this.d.moderation.listInForce(guildId, targetDiscordId === "" ? null : targetDiscordId),
    ]);

    const list = infractions.ok ? infractions.value : [];
    const data: ModerationVM = {
      target: targetDiscordId,
      infractionCount: list.length,
      infractions: list,
      actions: (actions.ok ? actions.value : []).map((a) => ({ ...a, state: punishmentState(a, now) })),
      inForce: inForce.ok ? inForce.value : [],
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

    const [rollups, topCommands] = await Promise.all([
      this.d.reads.listRollups({
        guildId,
        period,
        since,
        ...(opts.metrics ? { metrics: opts.metrics } : {}),
      }),
      this.d.reads.topCommands(guildId, since),
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
    if (selected.length === 0 || !events.some((event) => event.id === selected)) {
      // An unknown id is treated as no selection rather than an error: the id
      // comes from the URL, and a stale link should show the list, not a fault.
      return { access, data: { events, selected: "", attendance: null } };
    }

    const attendance = await this.attendanceOf(guildId, selected);
    return { access, data: { events, selected, attendance } };
  }

  /**
   * One event's RSVPs with names attached.
   *
   * The roster stores Discord ids; the roster read supplies the usernames, so a
   * page whose whole job is "who is coming" shows people rather than snowflakes.
   * A member with no platform record still appears — unnamed is better than
   * missing from a list someone is about to count heads from.
   */
  private async attendanceOf(guildId: string, eventId: string): Promise<EventAttendance | null> {
    const [result, members] = await Promise.all([
      this.d.community.getAttendance(eventId),
      this.d.reads.listLinkedMembers(guildId),
    ]);
    if (!result.ok) return null;

    const names = new Map(members.map((member) => [member.discordId, member.username ?? null]));
    const roster = (entries: readonly RsvpEntryDTO[]): readonly EventRsvp[] =>
      entries.map((entry) => ({
        discordId: entry.discordId,
        username: names.get(entry.discordId) ?? null,
        state: entry.state,
        respondedAt: entry.respondedAt,
      }));

    const dto = result.value;
    return {
      eventId,
      going: roster(dto.going),
      maybe: roster(dto.maybe),
      declined: roster(dto.declined),
      waitlist: roster(dto.waitlist),
    };
  }

  // ─────────────────────────── linked members ───────────────────────────

  async loadMembers(session: PanelSession | null, guildId: string): Promise<PageResult<MembersVM>> {
    const access = await authorize(session, guildId, "members", this.d.roles);
    if (!access.allowed) return this.denied(access, "members", guildId);

    const members = await this.d.reads.listLinkedMembers(guildId);
    return {
      access,
      data: {
        members,
        unlinkedCount: members.filter((m) => m.verification === "UNLINKED").length,
        pendingCount: members.filter((m) => m.verification === "PENDING").length,
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
        roleMappings: cfg?.roleMappings ?? {},
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
      return { access, data: { installed: tickets !== undefined, types: [], panel: null, open, canConfigure } };
    }

    const [types, panel] = await Promise.all([tickets.listTypes(guildId), tickets.getPanel(guildId)]);
    return { access, data: { installed: true, types, panel, open, canConfigure } };
  }

  /**
   * The chat filter and the escalation ladder on one page.
   *
   * They are two halves of the same question — what the platform does about a
   * member without a staffer present — and splitting them would mean an admin
   * tuning the filter's severities had to open a different page to see what
   * those severities eventually add up to.
   */
  async loadWordlist(session: PanelSession | null, guildId: string): Promise<PageResult<WordlistVM>> {
    const access = await authorize(session, guildId, "wordlist", this.d.roles);
    if (!access.allowed) return this.denied(access, "wordlist", guildId);

    const wordlist = this.d.wordlist;
    // The escalation policy is readable either way: it is a setting, not a
    // service, and a deployment without the filter still escalates warnings.
    const stored = await this.d.config.getSetting<unknown>(guildId, ESCALATION_SETTING_KEY);
    const escalation = parseEscalationPolicy(stored);
    if (wordlist === undefined) return { access, data: { installed: false, rules: [], escalation } };

    const rules = await wordlist.list(guildId);
    return { access, data: { installed: true, rules: rules.ok ? rules.value : [], escalation } };
  }

  async loadHealth(session: PanelSession | null, guildId: string): Promise<PageResult<HealthVM>> {
    const access = await authorize(session, guildId, "health", this.d.roles);
    if (!access.allowed) return this.denied(access, "health", guildId);

    // Liveness failing must not blank the job table: an unreachable Redis is
    // itself something the reader wants to see the rest of the page during.
    const [jobs, beats] = await Promise.all([
      this.d.reads.listJobHealth(),
      this.d.heartbeats?.list().catch((error: unknown) => {
        this.log.warn("heartbeat read failed", {
          guildId,
          error: error instanceof Error ? error.message : "unknown",
        });
        return [] as const;
      }) ?? Promise.resolve([] as const),
    ]);

    const now = Date.now();
    return {
      access,
      data: {
        jobs: jobs.map((j) => {
          const threshold = STALE_AFTER_MS[j.type] ?? 60 * 60_000;
          const stale = j.lastRunAt === null || now - Date.parse(j.lastRunAt) > threshold;
          return { ...j, stale };
        }),
        services: gradeServices(beats, now),
      },
    };
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
