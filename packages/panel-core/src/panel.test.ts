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
  type TicketTypeDTO,
  type WordlistService,
  type ModerationService,
  type XpService,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { authorize, type PanelSession, type RoleResolver } from "./access.js";
import type { HeartbeatReader, JobHealth, PanelReads, ServiceHeartbeat } from "./reads.js";
import { EXPECTED_SERVICES, HEARTBEAT_STALE_MS, PanelService, XP_SOURCE_ORDER } from "./service.js";

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

function reads(over: Partial<PanelReads> = {}): PanelReads {
  const base: PanelReads = {
    async listGuildCards(ids) {
      return ids.map((id) => ({
        id, name: `Guild ${id}`, discordGuildId: `d-${id}`, hypixelGuildId: null, memberCount: 3,
      }));
    },
    async overviewCounts() { return COUNTS; },
    async lastSnapshotAt() { return null; },
    async listLinkedMembers() {
      return [
        { discordId: "1", username: "a", role: "MEMBER", status: "ACTIVE", guildRank: null, lastSeenAt: null, ign: "A", uuid: "u", verification: "VERIFIED" },
        { discordId: "2", username: "b", role: "MEMBER", status: "ACTIVE", guildRank: null, lastSeenAt: null, ign: null, uuid: null, verification: "UNLINKED" },
        { discordId: "3", username: "c", role: "MEMBER", status: "ACTIVE", guildRank: null, lastSeenAt: null, ign: "C", uuid: "v", verification: "PENDING" },
      ];
    },
    async listRollups() { return []; },
    async topCommands() { return []; },
    async listEvents() { return []; },
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
        applicationsOpen: true, bridgeSuspended: false, features: {}, minWeight: null,
        minNetworth: null, roleMappings: {}, ...over,
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

test("members page counts unlinked and pending separately", async () => {
  const r = await svc().loadMembers(session(), "g1");
  assert.equal(r.data?.unlinkedCount, 1);
  assert.equal(r.data?.pendingCount, 1);
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

test("settings shows the screening policy in force, not an empty form", async () => {
  // A guild that has never saved a policy is still being screened under the
  // platform defaults. Rendering blanks would tell the admin that nothing is
  // configured, when in fact the scammer check is already running.
  const r = await svc({ roles: roles({ "111": "ADMIN" }) }).loadSettings(session(), "g1");
  assert.equal(r.access.allowed, true);
  assert.equal(r.data?.screening.enabled, true);
  assert.equal(r.data?.screening.autoAccept, false, "nobody is admitted automatically until someone opts in");
  assert.equal(r.data?.screening.minNetworth, null);
});

// ── events + attendance ──

const EVENT = {
  id: "evt_1", title: "F7", type: "DUNGEON", status: "SCHEDULED",
  startsAt: "2026-09-01T18:00:00.000Z", endsAt: null, capacity: 5,
  hostDiscordId: "111", going: 1, maybe: 0, declined: 0,
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

/** One built-in and one of the guild's own — the two states the page renders. */
const ticketService = (): TicketConfigService =>
  ({
    async listTypes(guildId: string): Promise<readonly TicketTypeDTO[]> {
      return [
        {
          id: null, guildId, key: "support", label: "Support", emoji: null, category: "SUPPORT",
          parentChannelId: null, staffRoleIds: [], prompt: null, position: 0, enabled: true,
          source: "DEFAULT",
        },
        {
          id: "t2", guildId, key: "appeal", label: "Appeal", emoji: null, category: "APPEAL",
          parentChannelId: null, staffRoleIds: [], prompt: null, position: 1, enabled: false,
          source: "GUILD",
        },
      ];
    },
    async getPanel(guildId: string) {
      return { guildId, channelId: null, messageId: null, title: "Support", description: null, updatedAt: null };
    },
  }) as unknown as TicketConfigService;

test("the tickets page shows built-ins and the guild's own rows together", async () => {
  const r = await svc({ roles: roles({ "111": "ADMIN" }), tickets: ticketService() })
    .loadTickets(session(), "g1");

  assert.equal(r.access.allowed, true);
  assert.equal(r.data?.installed, true);
  assert.deepEqual(r.data?.types.map((t) => t.source), ["DEFAULT", "GUILD"]);
  // A switched-off type is listed, not filtered: the page has to render the
  // control that turns it back on.
  assert.equal(r.data?.types.find((t) => t.key === "appeal")?.enabled, false);
  assert.equal(r.data?.panel?.title, "Support");
});

test("with tickets unwired the page says so rather than showing an empty menu", async () => {
  const r = await svc({ roles: roles({ "111": "ADMIN" }) }).loadTickets(session(), "g1");
  assert.equal(r.access.allowed, true);
  assert.equal(r.data?.installed, false);
  assert.deepEqual(r.data?.types, []);
  assert.equal(r.data?.panel, null);
});

test("a non-admin gets the queue but not the menu behind it", async () => {
  // The page is Moderator-tier because closing a ticket is: shutting the people
  // who answer tickets out of the queue was the old behaviour and it was wrong.
  // Configuring which types are offered is still Admin, so the same load says
  // allowed but not configurable, and returns no menu to render.
  const r = await svc({ tickets: ticketService() }).loadTickets(session(), "g1");
  assert.equal(r.access.allowed, true);
  assert.equal(r.data?.canConfigure, false);
  assert.deepEqual(r.data?.types, []);
  assert.equal(r.data?.panel, null);
  assert.equal(r.data?.installed, true, "the reader is told ticketing exists, just not theirs to configure");
});

test("an admin gets the queue and the menu", async () => {
  const r = await svc({ roles: roles({ "111": "ADMIN" }), tickets: ticketService() }).loadTickets(
    session(),
    "g1",
  );
  assert.equal(r.data?.canConfigure, true);
  assert.ok((r.data?.types.length ?? 0) > 0);
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
