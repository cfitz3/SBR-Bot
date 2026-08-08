/**
 * PanelService — authorizes a guild-scoped page request, then resolves its view
 * model from the shared services. Every load returns the AccessDecision so the
 * route can render the right allowed/denied state.
 *
 * Reads only. Writes go through the same domain services the bots use (the panel
 * "commands, it doesn't bypass"), so nothing here mutates.
 */
import type {
  AuditQuery,
  CommunityService,
  GuildConfigService,
  GuildRuntimeConfig,
  InfractionDTO,
  ModerationActionDTO,
  ModerationService,
  RsvpEntryDTO,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { authorize, type AccessDecision, type PanelSession, type RoleResolver } from "./access.js";
import { shapeAnalytics, type MetricChart } from "./series.js";
import type {
  CommandUsageStat,
  Freshness,
  GuildCard,
  HeartbeatReader,
  JobHealth,
  LinkedMember,
  PanelApplication,
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
};

/** The jobs whose freshness the Overview strip summarises. */
const OVERVIEW_JOBS = ["bazaar-refresh", "ah-sweep", "profile-snapshot", "guild-roster-sync"] as const;

export interface FreshnessVM extends Freshness {
  readonly stale: boolean;
  readonly ageMs: number | null;
}

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
  readonly pendingApplicationCount: number;
  readonly upcomingEventCount: number;
  readonly bridgeSuspended: boolean;
  readonly lastSnapshotAt: string | null;
  readonly freshness: readonly FreshnessVM[];
}

export interface ModerationVM {
  readonly target: string;
  readonly infractionCount: number;
  readonly infractions: readonly InfractionDTO[];
  readonly actions: readonly ModerationActionDTO[];
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

export interface RecruitmentVM {
  readonly applications: readonly PanelApplication[];
  readonly tickets: readonly PanelTicket[];
  readonly recruitmentOpen: boolean;
  readonly minWeight: number | null;
  readonly minNetworth: number | null;
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

export interface SettingsVM {
  readonly config: GuildRuntimeConfig | null;
}

export interface MappingVM {
  readonly roleMappings: Readonly<Record<string, string>>;
  readonly channels: Readonly<Record<string, string | null>>;
  readonly features: Readonly<Record<string, boolean>>;
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
  /** Optional: without it the Health page shows jobs only, not live processes. */
  readonly heartbeats?: HeartbeatReader;
  readonly logger: Logger;
}

/** Age of a job's last success, and whether that exceeds its stale threshold. */
function gradeFreshness(row: Freshness, now: number): FreshnessVM {
  if (row.lastSuccessAt === null) {
    // Never succeeded is stale by definition — a job that has not run once is
    // exactly the case a freshness badge exists to surface.
    return { ...row, ageMs: null, stale: true };
  }
  const ageMs = now - Date.parse(row.lastSuccessAt);
  const threshold = STALE_AFTER_MS[row.job] ?? 60 * 60_000;
  return { ...row, ageMs, stale: ageMs > threshold };
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

    const [counts, freshness, lastSnapshotAt, config] = await Promise.all([
      this.d.reads.overviewCounts(guildId),
      this.d.reads.jobFreshness(OVERVIEW_JOBS),
      this.d.reads.lastSnapshotAt(guildId),
      this.d.config.get(guildId),
    ]);

    const now = Date.now();
    const data: OverviewVM = {
      ...counts,
      bridgeSuspended: config.ok ? (config.value?.bridgeSuspended ?? false) : false,
      lastSnapshotAt,
      freshness: freshness.map((f) => gradeFreshness(f, now)),
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

    const query: AuditQuery = { guildId, limit: 50, ...(targetDiscordId ? { targetDiscordId } : {}) };
    const [infractions, actions] = await Promise.all([
      this.d.moderation.listInfractions(guildId, targetDiscordId),
      this.d.moderation.listActions(query),
    ]);

    const list = infractions.ok ? infractions.value : [];
    const data: ModerationVM = {
      target: targetDiscordId,
      infractionCount: list.length,
      infractions: list,
      actions: actions.ok ? actions.value : [],
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

  // ─────────────────────────── recruitment + tickets ───────────────────────────

  async loadRecruitment(
    session: PanelSession | null,
    guildId: string,
  ): Promise<PageResult<RecruitmentVM>> {
    const access = await authorize(session, guildId, "recruitment", this.d.roles);
    if (!access.allowed) return this.denied(access, "recruitment", guildId);

    const [applications, tickets, config] = await Promise.all([
      this.d.reads.listApplications(guildId),
      this.d.reads.listTickets(guildId),
      this.d.config.get(guildId),
    ]);

    const cfg = config.ok ? config.value : null;
    return {
      access,
      data: {
        applications,
        tickets,
        recruitmentOpen: cfg?.applicationsOpen ?? false,
        minWeight: cfg?.minWeight ?? null,
        minNetworth: cfg?.minNetworth ?? null,
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

    const config = await this.d.config.get(guildId);
    return { access, data: { config: config.ok ? config.value : null } };
  }

  async loadMapping(session: PanelSession | null, guildId: string): Promise<PageResult<MappingVM>> {
    const access = await authorize(session, guildId, "mapping", this.d.roles);
    if (!access.allowed) return this.denied(access, "mapping", guildId);

    const config = await this.d.config.get(guildId);
    const cfg = config.ok ? config.value : null;
    return {
      access,
      data: {
        roleMappings: cfg?.roleMappings ?? {},
        channels: {
          bridge: cfg?.bridgeChannelId ?? null,
          staff: cfg?.staffChannelId ?? null,
          log: cfg?.logChannelId ?? null,
          applications: cfg?.applicationsChannelId ?? null,
          events: cfg?.eventsChannelId ?? null,
        },
        features: cfg?.features ?? {},
      },
    };
  }

  // ─────────────────────────── health ───────────────────────────

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
