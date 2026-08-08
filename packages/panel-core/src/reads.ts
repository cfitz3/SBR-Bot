/**
 * The read port the panel pages resolve against.
 *
 * Declared here rather than imported from `@sbr/db` so panel-core stays free of
 * a database dependency and each page can be tested against a plain object.
 * `panelRepository` satisfies this structurally.
 */

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
  readonly pendingApplicationCount: number;
  readonly upcomingEventCount: number;
  readonly recentJoinCount: number;
  readonly recentLeaveCount: number;
}

export interface Freshness {
  readonly job: string;
  readonly lastSuccessAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastStatus: string | null;
  readonly durationMs: number | null;
  readonly error: string | null;
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

export interface PanelEvent {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly status: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly capacity: number | null;
  readonly hostDiscordId: string | null;
  readonly going: number;
  readonly maybe: number;
  readonly declined: number;
}

export interface PanelTicket {
  readonly id: string;
  readonly openerDiscordId: string;
  readonly assigneeDiscordId: string | null;
  readonly category: string;
  readonly status: string;
  readonly subject: string | null;
  readonly createdAt: string;
}

export interface PanelApplication {
  readonly id: string;
  readonly applicantDiscordId: string;
  readonly status: string;
  readonly reviewerDiscordId: string | null;
  readonly submittedAt: string | null;
  readonly decidedAt: string | null;
  readonly answers: unknown;
}

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

export type RollupPeriod = "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";

export interface PanelReads {
  listGuildCards(guildIds: readonly string[]): Promise<readonly GuildCard[]>;
  overviewCounts(guildId: string, recentWindowDays?: number): Promise<OverviewCounts>;
  jobFreshness(jobs: readonly string[]): Promise<readonly Freshness[]>;
  lastSnapshotAt(guildId: string): Promise<string | null>;
  listLinkedMembers(guildId: string, limit?: number): Promise<readonly LinkedMember[]>;
  listRollups(input: {
    guildId: string;
    period: RollupPeriod;
    since: Date;
    metrics?: readonly string[];
  }): Promise<readonly RollupPoint[]>;
  topCommands(guildId: string, since: Date, limit?: number): Promise<readonly CommandUsageStat[]>;
  listEvents(guildId: string, limit?: number): Promise<readonly PanelEvent[]>;
  listApplications(guildId: string, limit?: number): Promise<readonly PanelApplication[]>;
  listTickets(guildId: string, limit?: number): Promise<readonly PanelTicket[]>;
  listJobHealth(): Promise<readonly JobHealth[]>;
}
