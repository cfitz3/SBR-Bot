/**
 * The read port the panel pages resolve against.
 *
 * Declared here rather than imported from `@sbr/db` so panel-core stays free of
 * a database dependency and each page can be tested against a plain object.
 * `panelRepository` satisfies this structurally.
 */
import type { TicketDTO } from "@sbr/shared-types";
import type { PreviewMember } from "@sbr/roles";

export interface GuildCard {
  readonly id: string;
  readonly name: string;
  readonly discordGuildId: string;
  readonly hypixelGuildId: string | null;
  readonly memberCount: number;
}

export interface OverviewCounts {
  readonly memberCount: number;
  readonly activeMemberCount: number;
  readonly linkedMemberCount: number;
  readonly verifiedMemberCount: number;
  readonly openTicketCount: number;
  readonly openInfractionCount: number;
  readonly activeActionCount: number;
  readonly upcomingEventCount: number;
  readonly recentJoinCount: number;
  readonly recentLeaveCount: number;
}

/**
 * Membership as two rosters, never one blended number.
 *
 * The Discord server and the in-game guild are different populations with
 * different join events, and averaging them produces a figure that describes
 * neither. Joins and leaves are therefore reported per side, and each side
 * carries the clock of the scan that produced it: a count with no `scannedAt`
 * cannot be told apart from a count that is three days stale.
 */
export interface MembershipStats {
  readonly discordMemberCount: number;
  readonly guildMemberCount: number;
  readonly linkedCount: number;
  /** `GuildMember.joinedAt` / `.leftAt` inside the window. */
  readonly discordJoins: number;
  readonly discordLeaves: number;
  /** Summed `GuildScan.joined` / `.left` deltas inside the window. */
  readonly gameJoins: number;
  readonly gameLeaves: number;
  readonly windowDays: number;
  readonly scannedAt: { readonly discord: string | null; readonly hypixel: string | null };
}

/** Which table an activity entry came from — the client renders an icon per kind. */
export type ActivityKind = "MODERATION" | "SCREENING" | "MILESTONE" | "EVENT" | "ROSTER";

/**
 * One line in the merged activity feed.
 *
 * Already rendered to a sentence by the read, because the five sources have no
 * common shape and a client that formatted each kind itself would be five
 * formatters drifting from the five that already exist elsewhere.
 */
export interface ActivityEntry {
  readonly kind: ActivityKind;
  readonly at: string;
  readonly title: string;
  readonly detail: string | null;
  readonly tone: "info" | "good" | "warn" | "bad";
}

/**
 * One join attempt as screening recorded it.
 *
 * `scammer` stays three-valued all the way to the browser (listed / clear /
 * could not find out). Collapsing the null into false is how an outage becomes
 * an all-clear, which is the one mistake this whole record exists to prevent.
 */
export interface JoinAttempt {
  readonly id: string;
  readonly uuid: string;
  readonly ign: string;
  readonly discordId: string | null;
  readonly requestedAt: string;
  readonly verdict: string;
  readonly outcome: string;
  readonly riskScore: number;
  readonly reasons: readonly string[];
  readonly scammer: boolean | null;
  readonly scammerReason: string | null;
  /** The stat block at the moment of the request. Null means unreadable, not zero. */
  readonly networth: number | null;
  readonly skillAverage: number | null;
  readonly catacombsLevel: number | null;
  readonly senitherWeight: number | null;
  readonly skyblockLevel: number | null;
}

export interface LinkedMember {
  readonly discordId: string;
  readonly username: string | null;
  readonly role: string;
  readonly status: string;
  readonly guildRank: string | null;
  readonly lastSeenAt: string | null;
  readonly ign: string | null;
  readonly uuid: string | null;
  readonly verification: "VERIFIED" | "PENDING" | "UNLINKED";
}

/**
 * One person in the member directory, from either side or both.
 *
 * A row exists if Discord knows them, if the in-game guild knows them, or if
 * both do — so `discordId` and `uuid` are independently nullable and at least
 * one is always set. That is the whole point: the old read could only describe
 * people who had a Discord membership row, which made "who is in the guild but
 * not in the server" unanswerable.
 */
export interface DirectoryMemberRow {
  readonly discordId: string | null;
  readonly username: string | null;
  readonly nickname: string | null;
  readonly uuid: string | null;
  readonly ign: string | null;
  readonly guildRank: string | null;
  /** True when a VERIFIED link joins the two sides of this row. */
  readonly linked: boolean;
  /** Platform role, or null for an in-game-only row that has no membership. */
  readonly role: string | null;
  /** ACTIVE / LEFT on the Discord side; null for in-game-only rows. */
  readonly status: string | null;
  readonly weeklyGexp: number | null;
  readonly lastSeenAt: string | null;
}

export type DirectorySide = "all" | "discord" | "game" | "unlinked";

export interface DirectoryQuery {
  /** Matches username, nickname, IGN **and** id — the "not just ID" requirement. */
  readonly q: string;
  readonly side: DirectorySide;
  readonly limit: number;
}

export interface DirectoryPage {
  readonly rows: readonly DirectoryMemberRow[];
  /** Totals for the guild, unaffected by `q` — they describe the roster, not the search. */
  readonly discordCount: number;
  readonly guildCount: number;
  readonly linkedCount: number;
  /** True when more rows matched than `limit` returned. */
  readonly truncated: boolean;
}

export interface RollupPoint {
  readonly metric: string;
  readonly bucketStart: string;
  readonly count: number;
  readonly dims: unknown;
}

export interface CommandUsageStat {
  readonly command: string;
  readonly count: number;
  readonly successCount: number;
  readonly avgLatencyMs: number | null;
}

/**
 * Message volume over a window, split by where it was said.
 *
 * Two numbers, never one. Discord messages are counted for every message in the
 * server; guild-chat lines are counted as the relay carries them. They describe
 * different populations on different surfaces, and a single "messages" figure
 * would be the same mistake the Overview's two rosters exist to avoid.
 */
export interface MessageTotals {
  readonly discordMessages: number;
  readonly guildChatMessages: number;
  readonly commandsUsed: number;
  /** People with at least one counted message in the window, either side. */
  readonly activeMembers: number;
  readonly days: number;
}

/**
 * One member's activity across both surfaces.
 *
 * `gexp` is null rather than 0 when the member has no linked Minecraft account:
 * "did not earn any" and "we have no way to know" are different answers, and
 * the panel's rule is never to print a zero where the truth is unknown.
 */
export interface ActiveMember {
  readonly discordId: string | null;
  readonly username: string | null;
  readonly uuid: string | null;
  readonly ign: string | null;
  readonly discordMessages: number;
  readonly guildChatMessages: number;
  readonly commandsUsed: number;
  readonly presenceSamples: number;
  readonly gexp: number | null;
  /** Days inside the window with GEXP above zero — the in-game playtime proxy. */
  readonly activeDays: number | null;
}

/** One day of a series. `day` is a date, not a timestamp: `YYYY-MM-DD`. */
export interface DailyPoint {
  readonly day: string;
  readonly value: number;
}

export interface PanelEvent {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly type: string;
  readonly status: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly capacity: number | null;
  readonly hostDiscordId: string | null;
  readonly going: number;
  readonly maybe: number;
  readonly declined: number;
  /** What the tracker scores. Empty means the event is run but not scored. */
  readonly trackedMetrics: readonly string[];
  readonly pollIntervalMinutes: number;
  readonly tracksProgression: boolean;
  /** Where the tracker board was published, and when it was last redrawn. */
  readonly channelId: string | null;
  readonly messageId: string | null;
  readonly boardUpdatedAt: string | null;
}

/**
 * One member's gain on one metric, as the board would rank it.
 *
 * `delta` rather than `current` for the same reason the board shows gains: a
 * leaderboard of readings would rank whoever arrived richest, not whoever did
 * the most during the event.
 */
export interface EventStandingRow {
  readonly discordId: string;
  readonly uuid: string;
  readonly metric: string;
  readonly delta: number;
}

// The ticket row used to be flattened into a `PanelTicket` shape declared here.
// It is `TicketDTO` from `@sbr/shared-types` now: the queue, the Discord side
// and the transcript viewer all need the same row, and a second shape meant the
// panel silently lost `number`, `claimedBy` and the close-request state.

export interface JobHealth {
  readonly type: string;
  readonly lastRunAt: string | null;
  readonly lastStatus: string | null;
  readonly durationMs: number | null;
  readonly error: string | null;
  readonly failuresLastDay: number;
}

/** One process's last self-report, as the Redis heartbeat adapter stores it. */
export interface ServiceHeartbeat {
  readonly service: string;
  readonly instance: string;
  readonly at: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Port: liveness of the other processes.
 *
 * Separate from `PanelReads` because it is a different store with different
 * truth conditions — job health is durable history in Postgres, this is a
 * seconds-old view of what is running right now, and an outage of one should not
 * blank the other.
 */
export interface HeartbeatReader {
  list(): Promise<readonly ServiceHeartbeat[]>;
}

/**
 * One guild command and what became of it.
 *
 * Declared here rather than imported from `@sbr/redis` for the usual reason
 * every port in this file is: the panel renders a shape, not a store, and a
 * panel that imports a Redis type cannot be tested without one.
 */
export interface RelayCommandRecord {
  readonly at: string;
  readonly command: string;
  readonly correlationId: string;
  /**
   * The wire vocabulary, deliberately not narrowed to a union here. A row
   * written by a newer build with an outcome this one has never heard of should
   * render as itself, not vanish from the strip that exists to show it.
   */
  readonly outcome: string;
  readonly detail: string;
}

/**
 * Port: the last few guild commands the bridge was asked to type.
 *
 * Optional everywhere it is used. Absent means the relay strip says it cannot
 * see the relay — which is the honest rendering, and materially different from
 * showing an empty list that reads as "nothing has been sent".
 */
export interface RelayLogReader {
  list(guildId: string, limit: number): Promise<readonly RelayCommandRecord[]>;
}

export type RollupPeriod = "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";

export type PermSubjectKind = "DISCORD_ROLE" | "DISCORD_USER" | "GUILD_RANK";

/** One stored exception to the guild's capability floors. */
export interface PermissionException {
  readonly id: string;
  readonly subjectType: PermSubjectKind;
  readonly subjectId: string;
  readonly capability: string;
  readonly allow: boolean;
  readonly createdAt: string;
}

/**
 * Port: the `BridgePermission` rows behind the Permissions page's exceptions.
 *
 * Its own port rather than four more methods on `PanelReads` because it is the
 * only read the panel does that is also a write — the page lists, adds and
 * removes the same rows, and splitting that across two interfaces would put the
 * halves of one screen in two places.
 */
export interface PermissionExceptionStore {
  list(guildId: string): Promise<readonly PermissionException[]>;
  set(
    guildId: string,
    subjectType: PermSubjectKind,
    subjectId: string,
    capability: string,
    allow: boolean,
  ): Promise<void>;
  remove(guildId: string, id: string): Promise<boolean>;
}

/** One staff command, as the Permissions page needs to describe it. */
export interface CommandCatalogEntry {
  readonly name: string;
  readonly description: string;
  /** The floor the handler itself declares — what an unconfigured guild gets. */
  readonly minRole: string;
}

/**
 * Port: the staff command table.
 *
 * Passed in rather than imported so panel-core keeps no dependency on the
 * dispatcher package. Absent means the page renders every other section and says
 * the command list is unavailable, which is the honest state for a panel
 * deployed without the bot's command layer.
 */
export interface CommandCatalog {
  list(): readonly CommandCatalogEntry[];
}

export interface PanelReads {
  listGuildCards(guildIds: readonly string[]): Promise<readonly GuildCard[]>;
  overviewCounts(guildId: string, recentWindowDays?: number): Promise<OverviewCounts>;
  /** Both rosters and their movement over the window, each with its own clock. */
  membershipStats(guildId: string, windowDays?: number): Promise<MembershipStats>;
  /** The merged feed, newest first. Bounded per source, then interleaved. */
  listActivity(guildId: string, limit?: number): Promise<readonly ActivityEntry[]>;
  /** Recent `GuildJoinScreening` rows, newest first. */
  listJoinAttempts(guildId: string, limit?: number): Promise<readonly JoinAttempt[]>;
  lastSnapshotAt(guildId: string): Promise<string | null>;
  listLinkedMembers(guildId: string, limit?: number): Promise<readonly LinkedMember[]>;
  listDirectory(guildId: string, query: DirectoryQuery): Promise<DirectoryPage>;
  /** When each side of the directory was last written, for the staleness line. */
  directoryScannedAt(guildId: string): Promise<{ discord: string | null; hypixel: string | null }>;
  listRollups(input: {
    guildId: string;
    period: RollupPeriod;
    since: Date;
    metrics?: readonly string[];
  }): Promise<readonly RollupPoint[]>;
  topCommands(guildId: string, since: Date, limit?: number): Promise<readonly CommandUsageStat[]>;
  /** Summed `ActivityDaily` over the window. */
  messageTotals(guildId: string, since: Date): Promise<MessageTotals>;
  /**
   * The most active members across **both** surfaces, in one table.
   *
   * One read rather than a Discord list beside an in-game list, because the
   * question is "who is carrying this guild" and the two lists answer half of
   * it each. Ranked by total counted messages plus GEXP-active days, so someone
   * who only plays and someone who only talks can both appear.
   */
  topActiveMembers(guildId: string, since: Date, limit?: number): Promise<readonly ActiveMember[]>;
  /** Guild-wide GEXP per day, for the trend chart. */
  gexpSeries(guildId: string, days: number): Promise<readonly DailyPoint[]>;
  /** One member's row, for the individual view. Null when they have no rows. */
  memberActivity(guildId: string, discordId: string, since: Date): Promise<ActiveMember | null>;
  listEvents(guildId: string, limit?: number): Promise<readonly PanelEvent[]>;
  /**
   * Every recorded score for one event, best first within each metric.
   *
   * All metrics in one read rather than one call per metric: an event scores at
   * most a handful, and the page draws a column for each of them at once.
   */
  eventStandings(eventId: string, limit?: number): Promise<readonly EventStandingRow[]>;
  listTickets(guildId: string, limit?: number): Promise<readonly TicketDTO[]>;
  listJobHealth(): Promise<readonly JobHealth[]>;
  /**
   * How many of this guild's milestones are still waiting to be announced.
   *
   * Deliverability is not part of the question: the announcer only leaves a row
   * pending when it has nowhere to post it or the post failed, so a number here
   * beside an unbound `milestones` channel is the whole diagnosis.
   */
  pendingMilestones(guildId: string): Promise<number>;
}

/** One role the effector would not apply, and the reason staff need to fix it. */
export interface RoleRefusalVM {
  readonly roleId: string;
  readonly detail: string;
  /** ISO timestamp of the most recent refusal for this role; "" if unknown. */
  readonly at: string;
}

/**
 * What the Roles page needs that is neither a setting nor a database row the
 * panel already reads: the roster in resolver shape, and the reconciler's own
 * diagnostics.
 *
 * A port rather than direct imports because the two halves live in different
 * packages — the roster in Postgres, the dirty set and the refusals in Redis —
 * and panel-core depends on neither.
 */
export interface RolesInsight {
  /**
   * A page of the roster with everything `previewRoleChanges` needs, and the
   * roster total so the page can say whether it looked at all of it.
   */
  previewMembers(
    guildId: string,
    limit: number,
  ): Promise<{ readonly members: readonly PreviewMember[]; readonly total: number }>;
  pendingDirty(guildId: string): Promise<number>;
  refusals(guildId: string): Promise<readonly RoleRefusalVM[]>;
  clearRefusals(guildId: string): Promise<void>;
}

/**
 * How many members one dry run examines.
 *
 * Bounded because the preview is a synchronous page action and a guild can have
 * thousands of members. Above this the answer is honestly labelled a sample
 * rather than quietly truncated — `previewRoleChanges` carries the flag, and the
 * note says so.
 */
export const ROLE_PREVIEW_LIMIT = 500;
