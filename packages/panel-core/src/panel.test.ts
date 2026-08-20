import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONFIG_CHANNEL_SLOTS,
  ok,
  type CommunityService,
  type GuildConfigService,
  type GuildRuntimeConfig,
  type MemberRole,
  type MilestoneDefinitionDTO,
  type MilestoneDefinitionService,
  type TicketConfigService,
  type TicketCategoryDTO,
  type WordlistService,
  type ModerationService,
  type XpService,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { authorize, type PanelSession, type RoleResolver } from "./access.js";
import type {
  CommandCatalog,
  DirectoryMemberRow,
  HeartbeatReader,
  JobHealth,
  PanelReads,
  PermissionException,
  PermissionExceptionStore,
  ServiceHeartbeat,
} from "./reads.js";
import {
  EXPECTED_SERVICES,
  HEARTBEAT_STALE_MS,
  PRESENCE_SAMPLE_INTERVAL_MINUTES,
  PanelService,
  XP_SOURCE_ORDER,
} from "./service.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

const roles = (map: Record<string, MemberRole>): RoleResolver => ({
  async getRole(_g, id) { return map[id] ?? "MEMBER"; },
});

const session = (over: Partial<PanelSession> = {}): PanelSession => ({
  discordId: "111",
  manageableGuildIds: ["g1"],
  ...over,
});

// ── access control ──

test("unauthenticated requests are denied", async () => {
  const d = await authorize(null, "g1", "overview", roles({}));
  assert.deepEqual(d, { allowed: false, reason: "NOT_AUTHENTICATED" });
});

test("guilds outside the manageable set are denied", async () => {
  const d = await authorize(session({ manageableGuildIds: ["other"] }), "g1", "overview", roles({ "111": "ADMIN" }));
  assert.deepEqual(d, { allowed: false, reason: "NOT_MANAGEABLE" });
});

test("a MEMBER cannot reach the overview", async () => {
  const d = await authorize(session(), "g1", "overview", roles({ "111": "MEMBER" }));
  assert.deepEqual(d, { allowed: false, reason: "INSUFFICIENT_ROLE" });
});

test("a MODERATOR can reach the overview", async () => {
  const d = await authorize(session(), "g1", "overview", roles({ "111": "MODERATOR" }));
  assert.equal(d.allowed, true);
});

test("settings requires ADMIN: OFFICER denied, ADMIN allowed", async () => {
  const officer = await authorize(session(), "g1", "settings", roles({ "111": "OFFICER" }));
  assert.equal(officer.allowed, false);
  const admin = await authorize(session(), "g1", "settings", roles({ "111": "ADMIN" }));
  assert.equal(admin.allowed, true);
});

// ── page data ──

function community(counts: { members: number; events: number; apps: number }): CommunityService {
  const arr = (n: number) => Array.from({ length: n }, (_v, i) => i);
  // The panel only reads counts; the rest of CommunityService is asserted
  // against in packages/community, so the stub declares just what it uses.
  const partial: Partial<CommunityService> = {
    async listMembers() { return ok(arr(counts.members) as never); },
    async listUpcomingEvents() { return ok(arr(counts.events) as never); },
    async listApplications() { return ok(arr(counts.apps) as never); },
    async setMemberRole() { throw new Error("unused"); },
  };
  return partial as CommunityService;
}

const moderation = (n: number): ModerationService => ({
  async recordInfraction(i) { return ok({ ...i, id: "x", createdAt: "t" }); },
  async applyAction() { throw new Error("unused"); },
  async listActions() { return ok([]); },
  async listInForce() { return ok([]); },
  async sweepExpired() { return ok(0); },
  // The guild-wide feed the Moderation page shows with nobody selected. Empty
  // by default: the tests that care about it supply their own rows.
  async listRecentInfractions() { return ok([]); },
  async listInfractions() {
    return ok(
      Array.from({ length: n }, (_v, i) => ({
        id: `i${i}`, guildId: "g1", targetDiscordId: "t", type: "SPAM" as const,
        severity: "LOW" as const, reason: "x", createdAt: "t",
      })),
    );
  },
});

const COUNTS = {
  memberCount: 3, activeMemberCount: 3, linkedMemberCount: 2, verifiedMemberCount: 1,
  openTicketCount: 4, openInfractionCount: 5, activeActionCount: 1,
  upcomingEventCount: 1, recentJoinCount: 0, recentLeaveCount: 0,
} as const;

/** Two rosters that disagree, so a test can tell which side a number came from. */
const MEMBERSHIP = {
  discordMemberCount: 3, guildMemberCount: 5, linkedCount: 2,
  discordJoins: 1, discordLeaves: 0, gameJoins: 4, gameLeaves: 2,
  windowDays: 7, scannedAt: { discord: "2026-08-07T10:00:00.000Z", hypixel: null },
} as const;

const ACTIVITY = [
  { kind: "SCREENING", at: "2026-08-07T11:00:00.000Z", title: "Notch asked to join", detail: "accept · joined · risk 4", tone: "good" },
  { kind: "MODERATION", at: "2026-08-07T09:00:00.000Z", title: "MUTE — 222", detail: "spam — by 111", tone: "bad" },
] as const;

/**
 * One of each scam-check state, including the one that matters most: `null`,
 * meaning the check could not be run. A page that renders it as "clear" is the
 * failure this record exists to prevent.
 */
const JOIN_ATTEMPTS = [
  {
    id: "s1", uuid: "u1", ign: "Notch", discordId: null, requestedAt: "2026-08-07T11:00:00.000Z",
    verdict: "ACCEPT", outcome: "JOINED", riskScore: 4, reasons: [],
    scammer: false, scammerReason: null,
    networth: 1_000_000_000, skillAverage: 42.5, catacombsLevel: 30.2, senitherWeight: 5000, skyblockLevel: 210,
  },
  {
    id: "s2", uuid: "u2", ign: "Herobrine", discordId: "333", requestedAt: "2026-08-06T11:00:00.000Z",
    verdict: "REVIEW", outcome: "PENDING", riskScore: 55, reasons: ["SCAMMER_LOOKUP_FAILED"],
    scammer: null, scammerReason: null,
    networth: null, skillAverage: null, catacombsLevel: null, senitherWeight: null, skyblockLevel: null,
  },
] as const;

const MESSAGE_TOTALS = {
  discordMessages: 900, guildChatMessages: 300, commandsUsed: 40, activeMembers: 2, days: 30,
} as const;

/**
 * The three shapes a row can take, so a test can tell null from zero: a linked
 * member with both surfaces, an unlinked Discord member whose GEXP is *unknown*,
 * and a game-only member with no Discord counters at all.
 */
const ACTIVE_MEMBERS = [
  { discordId: "1", username: "a", uuid: "u", ign: "A", discordMessages: 800, guildChatMessages: 200, commandsUsed: 30, presenceSamples: 0, gexp: 5_000, activeDays: 6 },
  { discordId: "2", username: "b", uuid: null, ign: null, discordMessages: 100, guildChatMessages: 100, commandsUsed: 10, presenceSamples: 0, gexp: null, activeDays: null },
  { discordId: null, username: null, uuid: "w", ign: "C", discordMessages: 0, guildChatMessages: 0, commandsUsed: 0, presenceSamples: 0, gexp: 9_000, activeDays: 12 },
] as const;

const GEXP_SERIES = [
  { day: "2026-08-06", value: 4_000 },
  { day: "2026-08-07", value: 10_000 },
] as const;

/** One of each shape the merge can produce: linked, Discord-only, game-only. */
const DIRECTORY_ROWS: readonly DirectoryMemberRow[] = [
  { discordId: "1", username: "a", nickname: null, uuid: "u", ign: "A", guildRank: null, linked: true, role: "MEMBER", status: "ACTIVE", weeklyGexp: 10, lastSeenAt: null },
  { discordId: "2", username: "b", nickname: null, uuid: null, ign: null, guildRank: null, linked: false, role: "MEMBER", status: "ACTIVE", weeklyGexp: null, lastSeenAt: null },
  { discordId: null, username: null, nickname: null, uuid: "w", ign: "C", guildRank: "Member", linked: false, role: null, status: null, weeklyGexp: 5, lastSeenAt: null },
];

function reads(over: Partial<PanelReads> = {}): PanelReads {
  const base: PanelReads = {
    async listGuildCards(ids) {
      return ids.map((id) => ({
        id, name: `Guild ${id}`, discordGuildId: `d-${id}`, hypixelGuildId: null, memberCount: 3,
      }));
    },
    async overviewCounts() { return COUNTS; },
    async membershipStats() { return MEMBERSHIP; },
    async listActivity() { return ACTIVITY; },
    async listJoinAttempts() { return JOIN_ATTEMPTS; },
    async lastSnapshotAt() { return null; },
    async listLinkedMembers() {
      return [
        { discordId: "1", username: "a", role: "MEMBER", status: "ACTIVE", guildRank: null, lastSeenAt: null, ign: "A", uuid: "u", verification: "VERIFIED" },
        { discordId: "2", username: "b", role: "MEMBER", status: "ACTIVE", guildRank: null, lastSeenAt: null, ign: null, uuid: null, verification: "UNLINKED" },
        { discordId: "3", username: "c", role: "MEMBER", status: "ACTIVE", guildRank: null, lastSeenAt: null, ign: "C", uuid: "v", verification: "PENDING" },
      ];
    },
    // Mirrors the repository's own filter semantics so a test can assert on the
    // tabs without a database: "discord only" means absent from the game side,
    // not merely present on the Discord one.
    async listDirectory(_guildId, query) {
      const all = DIRECTORY_ROWS;
      const needle = query.q.trim().toLowerCase();
      const rows = all.filter((row) => {
        const sideOk =
          query.side === "discord" ? row.discordId !== null && !row.linked
          : query.side === "game" ? row.uuid !== null && row.discordId === null
          : query.side === "unlinked" ? !row.linked
          : true;
        if (!sideOk) return false;
        if (needle.length === 0) return true;
        return [row.username, row.ign].some((f) => (f ?? "").toLowerCase().includes(needle));
      });
      return {
        rows: rows.slice(0, query.limit),
        discordCount: all.filter((r) => r.discordId !== null).length,
        guildCount: all.filter((r) => r.uuid !== null).length,
        linkedCount: all.filter((r) => r.linked).length,
        truncated: rows.length > query.limit,
      };
    },
    async directoryScannedAt() { return { discord: null, hypixel: null }; },
    async listRollups() { return []; },
    async topCommands() { return []; },
    async messageTotals() { return MESSAGE_TOTALS; },
    async topActiveMembers() { return ACTIVE_MEMBERS; },
    async gexpSeries() { return GEXP_SERIES; },
    async memberActivity() { return ACTIVE_MEMBERS[0] ?? null; },
    async listEvents() { return []; },
    async eventStandings() { return []; },
    async listTickets() { return []; },
    async listJobHealth() { return []; },
  };
  return { ...base, ...over };
}

const configService = (over: Partial<GuildRuntimeConfig> = {}): GuildConfigService => {
  const partial: Partial<GuildConfigService> = {
    async get() {
      return ok({
        guildId: "g1", channels: {}, prefixes: ["!"], timezone: "UTC",
        applicationsOpen: true, bridgeSuspended: false, features: {}, roleMappings: {}, ...over,
      });
    },
    // No stored settings: the Settings page has to work for a guild that has
    // never saved a screening policy, which is every guild on day one.
    async getSetting() {
      return null;
    },
  };
  return partial as GuildConfigService;
};

function svc(
  over: {
    roles?: RoleResolver;
    community?: CommunityService;
    moderation?: ModerationService;
    reads?: PanelReads;
    config?: GuildConfigService;
    heartbeats?: HeartbeatReader;
    xp?: XpService;
    milestones?: MilestoneDefinitionService;
    tickets?: TicketConfigService;
    wordlist?: WordlistService;
    permissionExceptions?: PermissionExceptionStore;
    commands?: CommandCatalog;
  } = {},
) {
  return new PanelService({
    roles: over.roles ?? roles({ "111": "OFFICER" }),
    community: over.community ?? community({ members: 3, events: 1, apps: 2 }),
    moderation: over.moderation ?? moderation(0),
    reads: over.reads ?? reads(),
    config: over.config ?? configService(),
    ...(over.heartbeats ? { heartbeats: over.heartbeats } : {}),
    ...(over.xp ? { xp: over.xp } : {}),
    ...(over.milestones ? { milestones: over.milestones } : {}),
    ...(over.tickets ? { tickets: over.tickets } : {}),
    ...(over.wordlist ? { wordlist: over.wordlist } : {}),
    ...(over.permissionExceptions ? { permissionExceptions: over.permissionExceptions } : {}),
    ...(over.commands ? { commands: over.commands } : {}),
    logger: silent,
  });
}

/** Beats are graded by age, so the fixture writes them relative to now. */
function beat(service: string, instance: string, ageMs: number): ServiceHeartbeat {
  return {
    service,
    instance,
    at: new Date(Date.now() - ageMs).toISOString(),
    details: { connected: true },
  };
}

const beats = (list: readonly ServiceHeartbeat[]): HeartbeatReader => ({ async list() { return list; } });

const admin = (): RoleResolver => roles({ "111": "ADMIN" });

test("loadOverview denies and returns null data for a MEMBER", async () => {
  const r = await svc({ roles: roles({ "111": "MEMBER" }) }).loadOverview(session(), "g1");
  assert.equal(r.access.allowed, false);
  assert.equal(r.data, null);
});

test("loadOverview returns counts when authorized", async () => {
  const r = await svc().loadOverview(session(), "g1");
  assert.equal(r.access.allowed, true);
  assert.equal(r.data?.memberCount, 3);
  assert.equal(r.data?.openTicketCount, 4);
  assert.equal(r.data?.openInfractionCount, 5);
});

test("the overview carries both rosters separately, never a blended one", async () => {
  const r = await svc().loadOverview(session(), "g1");

  const m = r.data?.membership;
  assert.equal(m?.discordMemberCount, 3);
  assert.equal(m?.guildMemberCount, 5);
  // Movement is per side. A single joins figure would be the one that hides
  // five people leaving the guild while one joined the server.
  assert.equal(m?.discordJoins, 1);
  assert.equal(m?.gameJoins, 4);
  assert.equal(m?.gameLeaves, 2);
  // The clock travels with the counts; a null one is a real answer, not a gap.
  assert.equal(m?.scannedAt.hypixel, null);
});

test("the activity feed arrives newest-first and already worded", async () => {
  const r = await svc().loadOverview(session(), "g1");

  const feed = r.data?.activity ?? [];
  assert.equal(feed.length, 2);
  assert.equal(feed[0]?.kind, "SCREENING");
  assert.ok((feed[0]?.at ?? "") > (feed[1]?.at ?? ""));
});

test("a scam check that could not run stays its own state all the way to the page", async () => {
  const r = await svc().loadOverview(session(), "g1");

  const [clear, unknown] = r.data?.joinAttempts ?? [];
  assert.equal(clear?.scammer, false);
  // Not false, and not absent: null is "we could not find out", and the whole
  // record exists so that an outage cannot read as an all-clear.
  assert.equal(unknown?.scammer, null);
  // An unreadable profile is nulls, never zeroes.
  assert.equal(unknown?.networth, null);
  assert.equal(unknown?.skillAverage, null);
});

test("loadModeration returns the infraction view when authorized", async () => {
  const r = await svc({ moderation: moderation(2) }).loadModeration(session(), "g1", "target");
  assert.equal(r.access.allowed, true);
  assert.equal(r.data?.infractionCount, 2);
  assert.equal(r.data?.target, "target");
});

// ── job staleness ──
//
// Graded on the Health page. Overview used to carry a copy of this strip; it
// answers a question about the platform rather than about the guild, so the one
// grader on Health is now the only one.

/** A job whose last run was `agoMs` in the past, or `null` for "never ran". */
function job(type: string, agoMs: number | null): JobHealth {
  return {
    type,
    lastRunAt: agoMs === null ? null : new Date(Date.now() - agoMs).toISOString(),
    lastStatus: agoMs === null ? null : "COMPLETED",
    durationMs: agoMs === null ? null : 10,
    error: null,
    failuresLastDay: 0,
  };
}

const HOUR = 3_600_000;

test("a job well inside its cadence is not flagged stale", async () => {
  // profile-snapshot tolerates 3h; the stub reports a run one hour ago.
  const r = await svc({
    roles: admin(),
    reads: reads({ async listJobHealth() { return [job("profile-snapshot", HOUR)]; } }),
  }).loadHealth(session(), "g1");
  assert.equal(r.data?.jobs[0]?.stale, false);
});

test("a job past its threshold is flagged stale", async () => {
  // bazaar-refresh tolerates 6 minutes; an hour-old run is well past that.
  const r = await svc({
    roles: admin(),
    reads: reads({ async listJobHealth() { return [job("bazaar-refresh", HOUR)]; } }),
  }).loadHealth(session(), "g1");
  assert.equal(r.data?.jobs[0]?.stale, true);
});

test("a job that has never run is stale, not silently fresh", async () => {
  const r = await svc({
    roles: admin(),
    reads: reads({ async listJobHealth() { return [job("profile-snapshot", null)]; } }),
  }).loadHealth(session(), "g1");
  assert.equal(r.data?.jobs[0]?.stale, true);
});

// ── the remaining pages ──

test("the selector needs only a session, not a guild role", async () => {
  const r = await svc({ roles: roles({ "111": "MEMBER" }) }).loadSelector(session());
  assert.equal(r.access.allowed, true);
  assert.equal(r.data?.guilds.length, 1);
});

test("the selector is still closed to anonymous callers", async () => {
  const r = await svc().loadSelector(null);
  assert.equal(r.access.allowed, false);
  assert.equal(r.data, null);
});

test("members page reports both rosters and how many are joined", async () => {
  const r = await svc().loadMembers(session(), "g1");
  assert.equal(r.data?.discordCount, 2);
  assert.equal(r.data?.guildCount, 2);
  assert.equal(r.data?.linkedCount, 1);
  assert.equal(r.data?.rows.length, 3);
});

test("the in-game-only tab shows people with no Discord membership at all", async () => {
  const r = await svc().loadMembers(session(), "g1", { side: "game" });
  assert.equal(r.data?.rows.length, 1);
  assert.equal(r.data?.rows[0]?.ign, "C");
  // Totals describe the roster, not the filter — otherwise the tabs would each
  // report a different guild size.
  assert.equal(r.data?.discordCount, 2);
});

test("an unrecognised side falls back to the unfiltered list rather than erroring", async () => {
  const r = await svc().loadMembers(session(), "g1", { side: "sideways" });
  assert.equal(r.data?.side, "all");
  assert.equal(r.data?.rows.length, 3);
});

test("analytics clamps an absurd range instead of trusting the query string", async () => {
  let seen: Date | null = null;
  const captured = reads({
    async listRollups(input) { seen = input.since; return []; },
  });
  await svc({ reads: captured }).loadAnalytics(session(), "g1", { rangeDays: 100_000 });
  assert.ok(seen !== null);
  const days = (Date.now() - (seen as unknown as Date).getTime()) / 86_400_000;
  assert.ok(days <= 366, `range was ${days} days`);
});

test("analytics splits message volume by surface instead of blending it", async () => {
  const r = await svc().loadAnalytics(session(), "g1");
  assert.equal(r.data?.messages.discordMessages, 900);
  assert.equal(r.data?.messages.guildChatMessages, 300);
  // The two are never summed into a single "messages" figure — they describe
  // different populations, exactly as the Overview's two rosters do.
  assert.equal(Object.hasOwn(r.data?.messages ?? {}, "totalMessages"), false);
});

test("analytics ranks members from both surfaces in one table", async () => {
  const r = await svc().loadAnalytics(session(), "g1");
  const rows = r.data?.topMembers ?? [];
  assert.equal(rows.length, 3);
  // The game-only member is present with no Discord id at all. A table that
  // could only show Discord-keyed rows would drop them, which is the whole
  // reason this is one read rather than two lists side by side.
  assert.ok(rows.some((m) => m.discordId === null && m.ign === "C"));
});

test("a member with no linked account reports unknown GEXP, never zero", async () => {
  const r = await svc().loadAnalytics(session(), "g1");
  const unlinked = r.data?.topMembers.find((m) => m.discordId === "2");
  assert.equal(unlinked?.gexp, null, "no linked account means we cannot know, not that they earned none");
  assert.equal(unlinked?.activeDays, null);
});

test("playtime carries its sample interval so the page can call it an estimate", async () => {
  const r = await svc().loadAnalytics(session(), "g1");
  assert.equal(r.data?.playtime.sampleIntervalMinutes, PRESENCE_SAMPLE_INTERVAL_MINUTES);
  // Nothing samples presence yet, so the honest answer is zero samples — and a
  // zero here must mean "not sampled", which is why the interval travels with it
  // rather than the service pre-multiplying into a fabricated hour count.
  assert.equal(r.data?.playtime.presenceSamples, 0);
  assert.equal(r.data?.playtime.gameActiveDays, 18);
});

test("settings shows the screening policy in force, not an empty form", async () => {
  // A guild that has never saved a policy is still being screened under the
  // platform defaults. Rendering blanks would tell the admin that nothing is
  // configured, when in fact the scammer check is already running.
  const r = await svc({ roles: roles({ "111": "ADMIN" }) }).loadSettings(session(), "g1");
  assert.equal(r.access.allowed, true);
  assert.equal(r.data?.screening.enabled, true);
  assert.equal(r.data?.screening.autoAccept, false, "nobody is admitted automatically until someone opts in");
  assert.equal(r.data?.screening.reviewOnUnreadable, true, "an account we cannot read is held, not admitted");
});

// ── events + attendance ──

const EVENT = {
  id: "evt_1", title: "F7", description: null, type: "DUNGEON", status: "SCHEDULED",
  startsAt: "2026-09-01T18:00:00.000Z", endsAt: null, capacity: 5,
  hostDiscordId: "111", going: 1, maybe: 0, declined: 0,
  trackedMetrics: [], pollIntervalMinutes: 30, tracksProgression: false,
  channelId: null, messageId: null, boardUpdatedAt: null,
} as const;

/** A CommunityService whose attendance roster is two ids, one of them unknown. */
function withAttendance(): CommunityService {
  const partial: Partial<CommunityService> = {
    ...community({ members: 3, events: 1, apps: 2 }),
    async getAttendance() {
      return ok({
        event: EVENT as never,
        going: [
          { discordId: "1", state: "GOING" as const, respondedAt: "2026-08-07T10:00:00.000Z" },
          { discordId: "9", state: "GOING" as const, respondedAt: "2026-08-07T11:00:00.000Z" },
        ],
        maybe: [], declined: [], waitlist: [],
      });
    },
  };
  return partial as CommunityService;
}

test("no selection means no roster read at all", async () => {
  const r = await svc({ reads: reads({ async listEvents() { return [EVENT]; } }) }).loadEvents(session(), "g1");
  assert.equal(r.access.allowed, true);
  assert.equal(r.data?.selected, "");
  assert.equal(r.data?.attendance, null);
});

/**
 * A selection that doesn't name a real event comes from a stale link, so it
 * degrades to the plain list rather than to an error page.
 */
test("an unknown event id is dropped rather than reported as a fault", async () => {
  const r = await svc({
    community: withAttendance(),
    reads: reads({ async listEvents() { return [EVENT]; } }),
  }).loadEvents(session(), "g1", "evt_gone");

  assert.equal(r.data?.selected, "");
  assert.equal(r.data?.attendance, null);
});

test("a selected event's roster arrives with names joined, and unknown ids kept", async () => {
  const r = await svc({
    community: withAttendance(),
    reads: reads({ async listEvents() { return [EVENT]; } }),
  }).loadEvents(session(), "g1", "evt_1");

  assert.equal(r.data?.selected, "evt_1");
  assert.deepEqual(
    r.data?.attendance?.going.map((entry) => [entry.discordId, entry.username]),
    [["1", "a"], ["9", null]],
  );
});

/**
 * The board sorts by the first tracked metric, so the page has to show the
 * blocks in the event's own order — not the order the scores came back in.
 */
test("standings are grouped per tracked metric, in the event's order", async () => {
  const tracking = { ...EVENT, trackedMetrics: ["networth", "catacombsLevel"] } as const;
  const r = await svc({
    community: withAttendance(),
    reads: reads({
      async listEvents() { return [tracking]; },
      async eventStandings() {
        return [
          { discordId: "3", uuid: "v", metric: "catacombsLevel", delta: 2 },
          { discordId: "1", uuid: "u", metric: "networth", delta: 500 },
        ];
      },
    }),
  }).loadEvents(session(), "g1", "evt_1");

  assert.deepEqual(r.data?.standings.map((b) => b.metric), ["networth", "catacombsLevel"]);
  assert.deepEqual(r.data?.standings[0]?.entries, [{ discordId: "1", username: "a", delta: 500 }]);
});

/**
 * A score for a metric nobody tracks any more is hidden rather than deleted, so
 * un-ticking a metric is reversible.
 */
test("scores for an untracked metric are not shown", async () => {
  const r = await svc({
    community: withAttendance(),
    reads: reads({
      async listEvents() { return [EVENT]; },
      async eventStandings() {
        return [{ discordId: "1", uuid: "u", metric: "networth", delta: 500 }];
      },
    }),
  }).loadEvents(session(), "g1", "evt_1");

  assert.deepEqual(r.data?.standings, []);
});

/**
 * The point of the warning: nothing can poll an unverified member, so their
 * absence from every leaderboard is a gap in the data rather than a bad night.
 */
test("people going with no verified account are listed as unlinked", async () => {
  const r = await svc({
    community: withAttendance(),
    reads: reads({ async listEvents() { return [EVENT]; } }),
  }).loadEvents(session(), "g1", "evt_1");

  assert.deepEqual(r.data?.unlinked.map((e) => e.discordId), ["9"]);
});

test("settings and health stay closed to an OFFICER", async () => {
  const s = await svc().loadSettings(session(), "g1");
  const h = await svc().loadHealth(session(), "g1");
  assert.equal(s.access.allowed, false);
  assert.equal(h.access.allowed, false);
});

// ── liveness ──

test("a service that never beat is reported DOWN rather than omitted", async () => {
  const r = await svc({ roles: admin(), heartbeats: beats([]) }).loadHealth(session(), "g1");
  assert.equal(r.access.allowed, true);
  assert.deepEqual(
    r.data?.services.map((s) => s.service),
    [...EXPECTED_SERVICES],
    "every expected service must have a row, present or not",
  );
  assert.ok(r.data?.services.every((s) => s.status === "DOWN"));
});

test("a service is graded on its freshest instance, and the lagging one still shows", async () => {
  const r = await svc({
    roles: admin(),
    heartbeats: beats([
      beat("bridge-bot", "old", HEARTBEAT_STALE_MS * 2),
      beat("bridge-bot", "new", 1_000),
    ]),
  }).loadHealth(session(), "g1");

  const bridge = r.data?.services.find((s) => s.service === "bridge-bot");
  assert.equal(bridge?.status, "UP");
  assert.equal(bridge?.instances.length, 2);
  assert.equal(bridge?.instances[0]?.instance, "new", "instances are freshest-first");
});

test("a beat older than the stale window reads STALE, not DOWN", async () => {
  const r = await svc({
    roles: admin(),
    heartbeats: beats([beat("workers", "w1", HEARTBEAT_STALE_MS + 5_000)]),
  }).loadHealth(session(), "g1");
  assert.equal(r.data?.services.find((s) => s.service === "workers")?.status, "STALE");
});

test("an unexpected service still appears, after the expected ones", async () => {
  const r = await svc({ roles: admin(), heartbeats: beats([beat("scrape-bot", "s1", 500)]) }).loadHealth(
    session(),
    "g1",
  );
  const names = r.data?.services.map((s) => s.service) ?? [];
  assert.equal(names.at(-1), "scrape-bot");
  assert.equal(names.length, EXPECTED_SERVICES.length + 1);
});

test("a heartbeat store that throws leaves the job table intact", async () => {
  const r = await svc({
    roles: admin(),
    heartbeats: { async list() { throw new Error("redis down"); } },
  }).loadHealth(session(), "g1");
  assert.equal(r.access.allowed, true);
  assert.deepEqual(r.data?.jobs, []);
  assert.ok(r.data?.services.every((s) => s.status === "DOWN"));
});

test("settings carries every channel slot, present or not", async () => {
  const r = await svc({ roles: roles({ "111": "ADMIN" }) }).loadSettings(session(), "g1");
  assert.equal(r.access.allowed, true);
  // The whole registry, including the slots with no legacy column behind them:
  // a slot missing from this map is a slot with no control on the page.
  assert.deepEqual(Object.keys(r.data?.channels ?? {}).sort(), [...CONFIG_CHANNEL_SLOTS].sort());
  assert.equal(r.data?.channels["milestones"], null);
});

test("a bound slot comes back from the canonical map, not from a legacy column", async () => {
  const r = await svc({
    roles: roles({ "111": "ADMIN" }),
    config: configService({ channels: { lfg: "123456789012345678" } }),
  }).loadSettings(session(), "g1");
  assert.equal(r.data?.channels["lfg"], "123456789012345678");
});

// ── xp, now a section of settings ──

/** Only the two sources the guild has actually configured. */
const xpService = (): XpService =>
  ({
    async policy() {
      return {
        DISCORD_MESSAGE: {
          source: "DISCORD_MESSAGE", enabled: true, weight: 1, dailyCap: 200, cooldownSec: 60, minLength: 8,
        },
        GEXP: { source: "GEXP", enabled: true, weight: 0.01, dailyCap: null, cooldownSec: 0, minLength: 0 },
      };
    },
  }) as unknown as XpService;

test("the XP section lists every source, with unconfigured ones off rather than guessed", async () => {
  // A source with no row is disabled, and the page has to say so: inventing a
  // default weight would show an admin a number nobody chose and no job reads.
  const r = await svc({ roles: roles({ "111": "ADMIN" }), xp: xpService() }).loadSettings(session(), "g1");

  assert.equal(r.access.allowed, true);
  assert.equal(r.data?.xp.installed, true);
  assert.deepEqual(r.data?.xp.sources.map((s) => s.source), [...XP_SOURCE_ORDER]);
  assert.equal(r.data?.xp.sources.find((s) => s.source === "GEXP")?.weight, 0.01);
  const tenure = r.data?.xp.sources.find((s) => s.source === "TENURE");
  assert.equal(tenure?.enabled, false);
  assert.equal(tenure?.weight, 0);
});

test("with XP unwired the section says so instead of showing seven dead controls", async () => {
  const r = await svc({ roles: roles({ "111": "ADMIN" }) }).loadSettings(session(), "g1");
  assert.equal(r.access.allowed, true);
  assert.equal(r.data?.xp.installed, false);
  assert.deepEqual(r.data?.xp.sources, []);
});

// ── milestones ──

/** One built-in and one of the guild's own — the two states the page renders. */
const milestoneService = (): MilestoneDefinitionService =>
  ({
    async list(guildId: string): Promise<readonly MilestoneDefinitionDTO[]> {
      return [
        {
          id: null, guildId, key: "networth:1b", label: "1b networth", description: null,
          type: "NETWORTH_THRESHOLD", metric: "networth", threshold: 1e9, xpReward: 500,
          announce: true, enabled: true, source: "DEFAULT",
        },
        {
          id: "d2", guildId, key: "cata:50", label: "Catacombs 50", description: null,
          type: "CATACOMBS_LEVEL", metric: "catacombsLevel", threshold: 50, xpReward: 0,
          announce: false, enabled: false, source: "GUILD",
        },
      ];
    },
  }) as unknown as MilestoneDefinitionService;

test("the milestones page shows defaults and the guild's own rows together", async () => {
  const r = await svc({ roles: roles({ "111": "ADMIN" }), milestones: milestoneService() })
    .loadMilestones(session(), "g1");

  assert.equal(r.access.allowed, true);
  assert.equal(r.data?.installed, true);
  assert.deepEqual(r.data?.definitions.map((d) => d.source), ["DEFAULT", "GUILD"]);
  // A switched-off definition is listed, not filtered: the page has to render
  // the control that turns it back on.
  assert.equal(r.data?.definitions.find((d) => d.key === "cata:50")?.enabled, false);
});

test("with milestones unwired the page says so rather than showing an empty list", async () => {
  const r = await svc({ roles: roles({ "111": "ADMIN" }) }).loadMilestones(session(), "g1");
  assert.equal(r.access.allowed, true);
  assert.equal(r.data?.installed, false);
  assert.deepEqual(r.data?.definitions, []);
});

test("an officer cannot open the milestones page", async () => {
  const r = await svc({ milestones: milestoneService() }).loadMilestones(session(), "g1");
  assert.equal(r.access.allowed, false);
  assert.equal(r.data, null);
});

// ── tickets ──

/** One offered category and one switched off — the two states the page renders. */
const ticketService = (): TicketConfigService =>
  ({
    async getSettings(guildId: string) {
      return {
        guildId,
        archiveEnabled: true,
        logChannelId: null,
        blocklistRoleIds: [],
        primaryColor: "INFO",
        successColor: "SUCCESS",
        errorColor: "DANGER",
        footer: null,
        staleAfterMinutes: null,
        autoCloseAfterMinutes: 720,
        closeButton: true,
        claimButton: true,
        workingHours: {},
        updatedAt: null,
      };
    },
    async listCategories(guildId: string): Promise<readonly TicketCategoryDTO[]> {
      const base = {
        guildId, description: "", emoji: null, channelNameTemplate: "ticket-{num}", parentChannelId: null,
        staffRoleIds: [], requiredRoleIds: [], pingRoleIds: [], openingMessage: "", image: null,
        claiming: true, cooldownSeconds: null, memberLimit: 1, totalLimit: 50, slowModeSeconds: null,
        requireTopic: false, questions: [],
      };
      return [
        { ...base, id: "c1", key: "support", name: "Support", position: 0, enabled: true },
        { ...base, id: "c2", key: "appeal", name: "Appeal", position: 1, enabled: false },
      ];
    },
    async listPanels(guildId: string) {
      return [
        {
          id: "p1", guildId, name: "Support", channelId: null, messageId: null, title: "Support",
          description: null, image: null, thumbnail: null, style: "BUTTONS" as const,
          categoryKeys: ["support"], updatedAt: null,
        },
      ];
    },
    async listTags(guildId: string) {
      return [{ id: "tag1", guildId, name: "refund", content: "Refunds take 3 days.", autoPattern: null, enabled: true }];
    },
  }) as unknown as TicketConfigService;

test("the tickets page lists every category, switched off ones included", async () => {
  const r = await svc({ roles: roles({ "111": "ADMIN" }), tickets: ticketService() })
    .loadTickets(session(), "g1");

  assert.equal(r.access.allowed, true);
  assert.equal(r.data?.installed, true);
  assert.deepEqual(r.data?.categories.map((c) => c.key), ["support", "appeal"]);
  // A switched-off category is listed, not filtered: the page has to render the
  // control that turns it back on.
  assert.equal(r.data?.categories.find((c) => c.key === "appeal")?.enabled, false);
  assert.equal(r.data?.panels[0]?.title, "Support");
  assert.equal(r.data?.tags[0]?.name, "refund");
  assert.equal(r.data?.settings?.autoCloseAfterMinutes, 720);
});

test("with tickets unwired the page says so rather than showing an empty menu", async () => {
  const r = await svc({ roles: roles({ "111": "ADMIN" }) }).loadTickets(session(), "g1");
  assert.equal(r.access.allowed, true);
  assert.equal(r.data?.installed, false);
  assert.deepEqual(r.data?.categories, []);
  assert.deepEqual(r.data?.panels, []);
  assert.equal(r.data?.settings, null);
});

test("a non-admin gets the queue but not the menu behind it", async () => {
  // The page is Moderator-tier because working the queue is: shutting the people
  // who answer tickets out of it was the old behaviour and it was wrong.
  // Configuring which categories are offered is still Admin, so the same load
  // says allowed but not configurable, and returns no menu to render.
  const r = await svc({ tickets: ticketService() }).loadTickets(session(), "g1");
  assert.equal(r.access.allowed, true);
  assert.equal(r.data?.canConfigure, false);
  assert.deepEqual(r.data?.categories, []);
  assert.deepEqual(r.data?.tags, []);
  assert.equal(r.data?.settings, null);
  assert.equal(r.data?.installed, true, "the reader is told ticketing exists, just not theirs to configure");
});

test("an admin gets the queue and the menu", async () => {
  const r = await svc({ roles: roles({ "111": "ADMIN" }), tickets: ticketService() }).loadTickets(
    session(),
    "g1",
  );
  assert.equal(r.data?.canConfigure, true);
  assert.ok((r.data?.categories.length ?? 0) > 0);
});

// ── the chat filter ──

const wordlistService = (): WordlistService =>
  ({
    async list(guildId: string) {
      return ok([
        { id: "w1", guildId, pattern: "free nitro", matchType: "SUBSTRING", action: "BLOCK", severity: 5, enabled: true },
        { id: "w2", guildId, pattern: "spoiler", matchType: "EXACT", action: "FLAG", severity: 1, enabled: false },
      ]);
    },
  }) as unknown as WordlistService;

test("the filter page lists every rule, switched off ones included", async () => {
  const r = await svc({ roles: admin(), wordlist: wordlistService() }).loadWordlist(session(), "g1");

  assert.equal(r.access.allowed, true);
  assert.equal(r.data?.installed, true);
  // A disabled rule is listed rather than filtered: the page has to render the
  // control that switches it back on.
  assert.deepEqual(r.data?.rules.map((rule) => rule.enabled), [true, false]);
});

test("a guild that has never configured a ladder gets the platform's own", async () => {
  // The read layers guild rungs over the built-ins, so a guild with nothing
  // stored still sees the three rungs that are actually in force.
  const r = await svc({ roles: admin(), wordlist: wordlistService() }).loadWordlist(session(), "g1");

  assert.equal(r.data?.escalation.enabled, true);
  assert.equal(r.data?.escalation.windowDays, 90);
  assert.deepEqual(r.data?.escalation.rungs.map((rung) => rung.warns), [3, 5, 7]);
  assert.deepEqual(r.data?.escalation.rungs.map((rung) => rung.source), ["DEFAULT", "DEFAULT", "DEFAULT"]);
});

test("with the filter unwired the ladder is still editable", async () => {
  // The two halves of the page are independent: escalation runs off the
  // moderation service, which every deployment has, so an absent chat filter
  // must not take the ladder editor down with it.
  const r = await svc({ roles: admin() }).loadWordlist(session(), "g1");

  assert.equal(r.access.allowed, true);
  assert.equal(r.data?.installed, false);
  assert.deepEqual(r.data?.rules, []);
  assert.equal(r.data?.escalation.rungs.length, 3);
});

test("an officer cannot open the filter page", async () => {
  const r = await svc({ wordlist: wordlistService() }).loadWordlist(session(), "g1");
  assert.equal(r.access.allowed, false);
  assert.equal(r.data, null);
});

// ── permissions ──

/** A config service answering one stored policy document and one config row. */
function permissionConfig(policy: unknown, roleMappings: Record<string, unknown> = {}): GuildConfigService {
  const partial: Partial<GuildConfigService> = {
    async get() {
      return ok({
        guildId: "g1", channels: {}, prefixes: ["!"], timezone: "UTC",
        applicationsOpen: true, bridgeSuspended: false, features: {},
        roleMappings: roleMappings as Record<string, string>,
      });
    },
    async getSetting(_g: string, key: string) {
      return key === "roles.policy" ? (policy as never) : null;
    },
  };
  return partial as GuildConfigService;
}

const catalog: CommandCatalog = {
  list() {
    return [
      { name: "warn", description: "Issue a formal warning", minRole: "MODERATOR" },
      { name: "setup", description: "Configure the guild", minRole: "ADMIN" },
    ];
  },
};

const EXCEPTION: PermissionException = {
  id: "e1",
  subjectType: "DISCORD_USER",
  subjectId: "222",
  capability: "RELAY_MESSAGE",
  allow: false,
  createdAt: "2026-08-01T00:00:00.000Z",
};

const exceptionStore = (list: readonly PermissionException[]): PermissionExceptionStore => ({
  async list() { return list; },
  async set() {},
  async remove() { return true; },
});

test("an officer cannot open the permissions page", async () => {
  const r = await svc().loadPermissions(session(), "g1");
  assert.equal(r.access.allowed, false);
  assert.equal(r.data, null);
});

test("a guild that has configured nothing sees the platform defaults, not blanks", async () => {
  const r = await svc({ roles: admin(), config: permissionConfig(null) }).loadPermissions(session(), "g1");

  assert.equal(r.access.allowed, true);
  // Every capability answers with a floor and the default it would have had.
  // That pairing is what tells "unchanged" from "deliberately set to this".
  assert.equal(r.data?.capabilities.every((c) => c.role === c.defaultRole), true);
  assert.deepEqual(r.data?.guildRanks, []);
  assert.equal(r.data?.roles.includes("ADMIN"), true);
});

test("a stored floor is what the page shows, beside the default it replaced", async () => {
  const r = await svc({
    roles: admin(),
    config: permissionConfig({
      capabilities: { MENTION: "ADMIN" },
      guildRanks: { officer: "OFFICER" },
      commands: { warn: "OFFICER" },
    }),
    commands: catalog,
  }).loadPermissions(session(), "g1");

  const mention = r.data?.capabilities.find((c) => c.capability === "MENTION");
  assert.equal(mention?.role, "ADMIN");
  assert.notEqual(mention?.defaultRole, "ADMIN");
  assert.deepEqual(r.data?.guildRanks, [{ rank: "officer", role: "OFFICER" }]);

  const warn = r.data?.commands.find((c) => c.name === "warn");
  assert.equal(warn?.role, "OFFICER");
  assert.equal(warn?.defaultRole, "MODERATOR");
  assert.equal(warn?.overridden, true);
  // The untouched one has to say so, or the page cannot show what was changed.
  assert.equal(r.data?.commands.find((c) => c.name === "setup")?.overridden, false);
});

test("a level bound to several Discord roles keeps all of them", async () => {
  const r = await svc({
    roles: admin(),
    config: permissionConfig(null, { OFFICER: ["1", "2"], ADMIN: "3" }),
  }).loadPermissions(session(), "g1");

  // Both stored shapes read back as a list: /set-role writes a single id and
  // the panel writes a set, and the page must not care which wrote last.
  assert.deepEqual(r.data?.bindings["OFFICER"], ["1", "2"]);
  assert.deepEqual(r.data?.bindings["ADMIN"], ["3"]);
  assert.deepEqual(r.data?.bindings["MEMBER"], []);
});

test("with no command catalog the page says so rather than showing no commands", async () => {
  const r = await svc({ roles: admin(), config: permissionConfig(null) }).loadPermissions(session(), "g1");
  assert.equal(r.data?.commandsAvailable, false);
  assert.deepEqual(r.data?.commands, []);
});

test("exceptions arrive when the store answers, and are marked unavailable when it fails", async () => {
  const good = await svc({
    roles: admin(),
    config: permissionConfig(null),
    permissionExceptions: exceptionStore([EXCEPTION]),
  }).loadPermissions(session(), "g1");
  assert.equal(good.data?.exceptionsAvailable, true);
  assert.equal(good.data?.exceptions[0]?.allow, false);

  // A store that throws must not blank the floors above it, which are the part
  // most guilds ever configure.
  const bad = await svc({
    roles: admin(),
    config: permissionConfig(null),
    permissionExceptions: { ...exceptionStore([]), async list() { throw new Error("db down"); } },
  }).loadPermissions(session(), "g1");
  assert.equal(bad.access.allowed, true);
  assert.equal(bad.data?.exceptionsAvailable, false);
  assert.equal((bad.data?.capabilities.length ?? 0) > 0, true);
});
