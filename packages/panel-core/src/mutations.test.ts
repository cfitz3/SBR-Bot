/**
 * PanelMutations — the write pipeline: authorize → rate-limit → validate → call
 * the domain service → audit. The GuildConfigService here is a recorder, because
 * what these tests assert is what reaches it (and what never does), not what it
 * then writes; that belongs to @sbr/guild-config.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONFIG_CHANNEL_SLOTS,
  err,
  ok,
  type CommunityService,
  type GuildConfigService,
  type IdentityService,
  type MemberRole,
  type MilestoneDefinitionDTO,
  type MilestoneDefinitionService,
  type TicketConfigService,
  type TicketTypeDTO,
  type ModerationService,
  type Result,
  type XpService,
  type XpSourcePolicyDTO,
} from "@sbr/shared-types";
import type { AnalyticsService, CommandUsageDTO } from "@sbr/shared-types";
import { DEFAULT_POLICY, SCREENING_POLICY_KEY, serializePolicy } from "@sbr/screening";
import type { Logger } from "@sbr/observability";
import type { PanelSession, RoleResolver } from "./access.js";
import {
  MUTATION_COOLDOWN_MS,
  PanelMutations,
  type ConfigAuditEntry,
  type MutationLimiter,
} from "./mutations.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

const roles = (map: Record<string, MemberRole>): RoleResolver => ({
  async getRole(_g, id) { return map[id] ?? "MEMBER"; },
});

const session = (over: Partial<PanelSession> = {}): PanelSession => ({
  discordId: "111",
  manageableGuildIds: ["g1"],
  csrfToken: "t",
  ...over,
});

interface Recorded {
  calls: { method: string; args: readonly unknown[] }[];
  audits: ConfigAuditEntry[];
  usage: CommandUsageDTO[];
  limited: string[];
}

/** A config service that records what it was asked to do and answers `result`. */
function configRecorder(recorded: Recorded, result: Result<void> = ok(undefined)): GuildConfigService {
  const record = (method: string) => async (...args: unknown[]): Promise<Result<void>> => {
    recorded.calls.push({ method, args });
    return result;
  };
  const partial: Partial<GuildConfigService> = {
    setChannel: record("setChannel") as GuildConfigService["setChannel"],
    setFeature: record("setFeature") as GuildConfigService["setFeature"],
    setBridgeSuspended: record("setBridgeSuspended") as GuildConfigService["setBridgeSuspended"],
    setRecruitment: record("setRecruitment") as GuildConfigService["setRecruitment"],
    setRoleMapping: record("setRoleMapping") as GuildConfigService["setRoleMapping"],
    setSetting: record("setSetting") as GuildConfigService["setSetting"],
  };
  return partial as GuildConfigService;
}

/**
 * The three action services, recorded the same way.
 *
 * Typed as partials and cast: these tests exercise the pipeline in front of the
 * services, and stubbing every unrelated method (events, LFG, auctions) would
 * bury the two lines that matter under a page of `async () => {}`.
 */
function actionRecorders(recorded: Recorded, result: Result<unknown> = ok(undefined)) {
  const record = (method: string) => async (...args: unknown[]): Promise<Result<unknown>> => {
    recorded.calls.push({ method, args });
    return result;
  };
  const moderation = { applyAction: record("applyAction") } as unknown as ModerationService;
  const community = {
    decideApplication: record("decideApplication"),
    closeTicket: record("closeTicket"),
    setMemberRole: record("setMemberRole"),
    createEvent: record("createEvent"),
    cancelEvent: record("cancelEvent"),
  } as unknown as CommunityService;
  const identity = { unlink: record("unlink") } as unknown as IdentityService;
  return { moderation, community, identity };
}

/**
 * XP, recorded the same way — but note it is *not* a Result service: its
 * methods return values and throw on failure, which is exactly the difference
 * the mutation layer has to absorb before the shared pipeline sees it.
 */
function xpRecorder(recorded: Recorded, throws = false): XpService {
  const record = (method: string) => async (...args: unknown[]): Promise<unknown> => {
    recorded.calls.push({ method, args });
    if (throws) throw new Error("xp store unavailable");
    return null;
  };
  return {
    setSourcePolicy: record("setSourcePolicy"),
    adjust: record("adjust"),
  } as unknown as XpService;
}

/**
 * Milestone definitions, recorded the same way. `remove` answers `removed` so a
 * key with no stored row can be told apart from one that had one.
 */
function milestoneRecorder(recorded: Recorded, removed = true): MilestoneDefinitionService {
  return {
    async list() { return []; },
    async upsert(guildId, input) {
      recorded.calls.push({ method: "upsertMilestone", args: [guildId, input] });
      return { ...input, id: "d1", guildId, source: "GUILD" } as MilestoneDefinitionDTO;
    },
    async remove(guildId, key) {
      recorded.calls.push({ method: "removeMilestone", args: [guildId, key] });
      return removed;
    },
  };
}

/** Ticket configuration, recorded the same way as milestone definitions. */
function ticketRecorder(recorded: Recorded, removed = true): TicketConfigService {
  return {
    async listTypes() { return []; },
    async upsertType(guildId, input) {
      recorded.calls.push({ method: "upsertTicketType", args: [guildId, input] });
      return { ...input, id: "t1", guildId, source: "GUILD" } as TicketTypeDTO;
    },
    async removeType(guildId, key) {
      recorded.calls.push({ method: "removeTicketType", args: [guildId, key] });
      return removed;
    },
    async getPanel(guildId) {
      return { guildId, channelId: null, messageId: null, title: "Support", description: null, updatedAt: null };
    },
    async savePanel(guildId, input) {
      recorded.calls.push({ method: "saveTicketPanel", args: [guildId, input] });
      return { guildId, messageId: null, updatedAt: "2026-08-07T12:00:00.000Z", ...input };
    },
  };
}

/** Allows everything unless the key is in `blocked` — the real gate is Redis. */
function limiter(recorded: Recorded, blocked: readonly string[] = []): MutationLimiter {
  return {
    async consume(key) {
      recorded.limited.push(key);
      return blocked.includes(key) ? { allowed: false, retryAfterMs: 1500 } : { allowed: true };
    },
  };
}

function make(
  over: {
    roleMap?: Record<string, MemberRole>;
    result?: Result<void>;
    blocked?: readonly string[];
    /** Leave XP unwired, as a deployment that runs without it does. */
    noXp?: boolean;
    xpThrows?: boolean;
    /** Same, for a deployment without milestone tracking. */
    noMilestones?: boolean;
    /** What `remove` reports back: false is "there was no row of yours". */
    milestoneRemoved?: boolean;
    /** Same, for a deployment without ticketing. */
    noTickets?: boolean;
    ticketTypeRemoved?: boolean;
  } = {},
) {
  const recorded: Recorded = { calls: [], audits: [], usage: [], limited: [] };
  const analytics: AnalyticsService = {
    async capture(u) { recorded.usage.push(u); },
    async emit() {},
  };
  const mutations = new PanelMutations({
    roles: roles(over.roleMap ?? { "111": "ADMIN" }),
    config: configRecorder(recorded, over.result ?? ok(undefined)),
    ...actionRecorders(recorded, over.result ?? ok(undefined)),
    ...(over.noXp === true ? {} : { xp: xpRecorder(recorded, over.xpThrows === true) }),
    ...(over.noMilestones === true
      ? {}
      : { milestones: milestoneRecorder(recorded, over.milestoneRemoved ?? true) }),
    ...(over.noTickets === true
      ? {}
      : { tickets: ticketRecorder(recorded, over.ticketTypeRemoved ?? true) }),
    limiter: limiter(recorded, over.blocked ?? []),
    audit: { async record(entry) { recorded.audits.push(entry); } },
    analytics,
    logger: silent,
    now: () => new Date("2026-08-07T12:00:00.000Z"),
  });
  return { mutations, recorded };
}

// ── the happy path ──

test("an ADMIN setting a channel reaches the config service, the audit and usage", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setChannel(session(), "g1", "bridge", "123456789012345678");

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [
    { method: "setChannel", args: ["g1", "bridge", "123456789012345678"] },
  ]);
  assert.deepEqual(recorded.audits, [
    {
      guildId: "g1",
      actorDiscordId: "111",
      mutation: "config.channel",
      change: { slot: "bridge", channelId: "123456789012345678" },
      at: "2026-08-07T12:00:00.000Z",
    },
  ]);
  assert.equal(recorded.usage.length, 1);
  assert.equal(recorded.usage[0]?.surface, "WEB_PANEL");
  assert.equal(recorded.usage[0]?.command, "config.channel");
  assert.equal(recorded.usage[0]?.success, true);
});

test("null clears a channel slot rather than being rejected as a missing id", async () => {
  const { mutations, recorded } = make();

  assert.equal((await mutations.setChannel(session(), "g1", "log", null)).ok, true);
  assert.deepEqual(recorded.calls[0]?.args, ["g1", "log", null]);
});

test("every slot the platform defines is writable, not just the five legacy columns", async () => {
  const { mutations, recorded } = make();

  for (const slot of CONFIG_CHANNEL_SLOTS) {
    const result = await mutations.setChannel(session(), "g1", slot, "123456789012345678");
    assert.equal(result.ok, true, `${slot} was refused`);
  }

  assert.deepEqual(
    recorded.calls.map((c) => c.args[1]),
    [...CONFIG_CHANNEL_SLOTS],
  );
});

test("a setting is written under its key, and the audit records the key rather than the payload", async () => {
  const { mutations, recorded } = make();
  const value = { title: "Open a ticket", body: "Tell us what you need." };

  const result = await mutations.setSetting(session(), "g1", "tickets.panel", value);

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [{ method: "setSetting", args: ["g1", "tickets.panel", value] }]);
  assert.deepEqual(recorded.audits[0]?.change, { key: "tickets.panel", bytes: JSON.stringify(value).length });
});

test("null clears a setting; only an absent value is refused", async () => {
  const { mutations, recorded } = make();

  assert.equal((await mutations.setSetting(session(), "g1", "tickets.panel", null)).ok, true);
  assert.deepEqual(recorded.calls[0]?.args, ["g1", "tickets.panel", null]);

  const missing = await mutations.setSetting(session(), "g1", "tickets.panel", undefined);
  assert.equal(missing.ok, false);
  assert.equal(missing.error?.kind, "INVALID_INPUT");
});

// ── the two gates ──

test("an unauthenticated write is denied without touching the config service", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setFeature(null, "g1", "lfg", true);

  assert.equal(result.ok, false);
  assert.equal(result.access.allowed, false);
  if (!result.access.allowed) assert.equal(result.access.reason, "NOT_AUTHENTICATED");
  assert.deepEqual(recorded.calls, []);
});

test("a guild outside the manageable set is denied even for an OWNER", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OWNER" } });

  const result = await mutations.setFeature(session({ manageableGuildIds: ["other"] }), "g1", "lfg", true);

  assert.equal(result.access.allowed, false);
  if (!result.access.allowed) assert.equal(result.access.reason, "NOT_MANAGEABLE");
  assert.deepEqual(recorded.calls, []);
});

test("config writes require ADMIN — an OFFICER is refused", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  const result = await mutations.setFeature(session(), "g1", "lfg", true);

  assert.equal(result.access.allowed, false);
  if (!result.access.allowed) assert.equal(result.access.reason, "INSUFFICIENT_ROLE");
  assert.deepEqual(recorded.calls, []);
});

/** WEB_PANEL.md §2 puts bridge control at Officer, below the config pages. */
test("bridge suspend sits at OFFICER, not ADMIN", async () => {
  const officer = make({ roleMap: { "111": "OFFICER" } });
  assert.equal((await officer.mutations.setBridgeSuspended(session(), "g1", true)).ok, true);
  assert.deepEqual(officer.recorded.calls[0]?.args, ["g1", true]);

  const mod = make({ roleMap: { "111": "MODERATOR" } });
  const denied = await mod.mutations.setBridgeSuspended(session(), "g1", true);
  assert.equal(denied.access.allowed, false);
  assert.deepEqual(mod.recorded.calls, []);
});

// ── rate limiting ──

test("the limiter is keyed per user and mutation, and a block short-circuits the write", async () => {
  const { mutations, recorded } = make({ blocked: ["cd:web:config.feature:111"] });

  const result = await mutations.setFeature(session(), "g1", "lfg", true);

  assert.equal(result.ok, false);
  if (result.error) {
    assert.equal(result.error.kind, "RATE_LIMITED");
    assert.equal(result.error.retryAfterMs, 1500);
  }
  assert.deepEqual(recorded.limited, ["cd:web:config.feature:111"]);
  assert.deepEqual(recorded.calls, []);
  // A refused write is still usage: a burst of them is the pattern worth seeing.
  assert.equal(recorded.usage[0]?.success, false);
});

test("a different mutation by the same user is limited separately", async () => {
  const { mutations, recorded } = make({ blocked: ["cd:web:config.feature:111"] });

  assert.equal((await mutations.setBridgeSuspended(session(), "g1", false)).ok, true);
  assert.deepEqual(recorded.limited, ["cd:web:bridge.suspend:111"]);
});

test("the cooldown is short enough to be invisible to a human editing settings", () => {
  assert.ok(MUTATION_COOLDOWN_MS <= 5_000);
});

// ── validation ──

test("junk input is refused before the config service or the audit sees it", async () => {
  const { mutations, recorded } = make();

  const cases = [
    await mutations.setChannel(session(), "g1", "nowhere", "123456789012345678"),
    await mutations.setChannel(session(), "g1", "bridge", "not-a-snowflake"),
    await mutations.setRoleMapping(session(), "g1", "SUPREME", null),
    await mutations.setFeature(session(), "g1", "Feature With Spaces", true),
    await mutations.setFeature(session(), "g1", "lfg", "yes"),
    await mutations.setBridgeSuspended(session(), "g1", "true"),
    await mutations.setRecruitment(session(), "g1", { open: "yes" }),
    await mutations.setRecruitment(session(), "g1", { open: true, minWeight: -1 }),
    await mutations.setSetting(session(), "g1", "Tickets Panel", {}),
    await mutations.setSetting(session(), "g1", "tickets..panel", {}),
    // A member roster's worth of JSON — a setting is a template, not a table.
    await mutations.setSetting(session(), "g1", "tickets.panel", { blob: "x".repeat(70_000) }),
  ];

  for (const [i, result] of cases.entries()) {
    assert.equal(result.ok, false, `case ${i}`);
    assert.equal(result.error?.kind, "INVALID_INPUT", `case ${i}`);
  }
  assert.deepEqual(recorded.calls, []);
  assert.deepEqual(recorded.audits, []);
});

/**
 * The tri-state that RecruitmentSettings documents: omitting a threshold has to
 * leave it alone, because collapsing "unspecified" into null would wipe a
 * guild's entry bar every time someone toggled applications open.
 */
test("an omitted recruitment threshold is not sent as null", async () => {
  const { mutations, recorded } = make();

  assert.equal((await mutations.setRecruitment(session(), "g1", { open: true })).ok, true);
  assert.deepEqual(recorded.calls[0]?.args, ["g1", { open: true }]);

  const cleared = make();
  await cleared.mutations.setRecruitment(session(), "g1", { open: false, minWeight: null, minNetworth: 5 });
  assert.deepEqual(cleared.recorded.calls[0]?.args, [
    "g1",
    { open: false, minWeight: null, minNetworth: 5 },
  ]);
});

// ── moderation, recruitment, members ──

test("a moderator can act, and the action is attributed to the session, not the body", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "MODERATOR" } });

  const result = await mutations.applyModeration(session(), "g1", {
    type: "MUTE",
    targetDiscordId: "222222222222222222",
    // A caller-supplied actor must be ignored; the audit trail is only worth
    // anything if the name on it is the authenticated one.
    actorDiscordId: "999999999999999999",
    reason: "spam",
    durationSeconds: 3600,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [
    {
      method: "applyAction",
      args: [
        {
          guildId: "g1",
          type: "MUTE",
          actorDiscordId: "111",
          targetDiscordId: "222222222222222222",
          reason: "spam",
          durationSeconds: 3600,
        },
      ],
    },
  ]);
});

test("moderation input is checked before the service sees it", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "MODERATOR" } });
  const target = "222222222222222222";

  const cases = [
    await mutations.applyModeration(session(), "g1", { type: "ROLE_CHANGE", targetDiscordId: target, reason: "x" }),
    await mutations.applyModeration(session(), "g1", { type: "WARN", targetDiscordId: "nope", reason: "x" }),
    await mutations.applyModeration(session(), "g1", { type: "WARN", targetDiscordId: target, reason: "   " }),
    await mutations.applyModeration(session(), "g1", { type: "WARN", targetDiscordId: target, reason: "x".repeat(501) }),
    // A duration on an untimed action is a misunderstanding worth surfacing,
    // not something to silently drop.
    await mutations.applyModeration(session(), "g1", { type: "WARN", targetDiscordId: target, reason: "x", durationSeconds: 60 }),
    await mutations.applyModeration(session(), "g1", { type: "MUTE", targetDiscordId: target, reason: "x", durationSeconds: 0 }),
    await mutations.applyModeration(session(), "g1", { type: "MUTE", targetDiscordId: target, reason: "x", durationSeconds: 60_000_000_000 }),
  ];

  for (const [i, result] of cases.entries()) {
    assert.equal(result.error?.kind, "INVALID_INPUT", `case ${i}`);
  }
  assert.deepEqual(recorded.calls, []);
});

test("a rejection must carry a reason; an acceptance need not", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  const bare = await mutations.decideApplication(session(), "g1", "app1", false, "");
  assert.equal(bare.error?.kind, "INVALID_INPUT");

  assert.equal((await mutations.decideApplication(session(), "g1", "app1", true, null)).ok, true);
  assert.deepEqual(recorded.calls[0]?.args, [
    { applicationId: "app1", reviewerDiscordId: "111", accept: true, reason: null },
  ]);
});

test("application decisions are Officer work, ticket closes are Staff work", async () => {
  const mod = make({ roleMap: { "111": "MODERATOR" } });
  assert.equal((await mod.mutations.decideApplication(session(), "g1", "app1", true, null)).access.allowed, false);
  assert.equal((await mod.mutations.closeTicket(session(), "g1", "t1", "handled")).ok, true);
});

test("role assignment is Admin-tier, refuses OWNER, and refuses self", async () => {
  const officer = make({ roleMap: { "111": "OFFICER" } });
  const denied = await officer.mutations.setMemberRole(session(), "g1", "222222222222222222", "MODERATOR");
  assert.equal(denied.access.allowed, false);

  const { mutations, recorded } = make();
  assert.equal(
    (await mutations.setMemberRole(session(), "g1", "222222222222222222", "OWNER")).error?.kind,
    "INVALID_INPUT",
  );
  // The session's own id — an admin demoting themselves out of this page.
  assert.equal((await mutations.setMemberRole(session(), "g1", "111", "MEMBER")).error?.kind, "INVALID_INPUT");
  assert.deepEqual(recorded.calls, []);

  assert.equal((await mutations.setMemberRole(session(), "g1", "222222222222222222", "ADMIN")).ok, true);
});

test("unlink names the account explicitly rather than guessing a primary", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });
  const uuid = "b876ec32-e396-476b-a115-8438d83c67d4";

  assert.equal((await mutations.unlinkMember(session(), "g1", "222222222222222222", "")).error?.kind, "INVALID_INPUT");
  assert.equal((await mutations.unlinkMember(session(), "g1", "222222222222222222", uuid)).ok, true);
  assert.deepEqual(recorded.calls[0], { method: "unlink", args: ["222222222222222222", uuid] });
});

// ── events ──

/**
 * The host is what `cancelEvent` later checks against, so it has to come from
 * the session: a body-supplied host would create events whose named host cannot
 * call them off, and whose real creator is nowhere on the record.
 */
test("an officer schedules an event hosted by themselves, not by the body", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  const result = await mutations.createEvent(session(), "g1", {
    title: "  F7 carry night  ",
    type: "DUNGEON",
    startsAt: "2026-09-01T18:00:00.000Z",
    capacity: 5,
    description: "  bring pots  ",
    hostDiscordId: "999999999999999999",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [
    {
      method: "createEvent",
      args: [
        {
          guildId: "g1",
          title: "F7 carry night",
          startsAt: "2026-09-01T18:00:00.000Z",
          type: "DUNGEON",
          hostDiscordId: "111",
          description: "bring pots",
          capacity: 5,
        },
      ],
    },
  ]);
});

test("an event needs a title, a known type and a readable start time", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });
  const base = { title: "Run", type: "DUNGEON", startsAt: "2026-09-01T18:00:00.000Z" };

  const bad = async (over: Record<string, unknown>): Promise<string | undefined> =>
    (await mutations.createEvent(session(), "g1", { ...base, ...over })).error?.kind;

  assert.equal(await bad({ title: "   " }), "INVALID_INPUT");
  assert.equal(await bad({ type: "RAID" }), "INVALID_INPUT");
  assert.equal(await bad({ startsAt: "next tuesday" }), "INVALID_INPUT");
  assert.equal(await bad({ capacity: 0 }), "INVALID_INPUT");
  assert.equal(await bad({ capacity: 2.5 }), "INVALID_INPUT");
  // Nothing that fails validation may reach the service or the audit trail.
  assert.deepEqual(recorded.calls, []);
  assert.deepEqual(recorded.audits, []);
});

/** Blank optionals are null, not empty strings the database has to interpret. */
test("an event with no capacity or description sends nulls", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  assert.equal(
    (await mutations.createEvent(session(), "g1", {
      title: "Meeting",
      type: "MEETING",
      startsAt: "2026-09-01T18:00:00.000Z",
    })).ok,
    true,
  );
  assert.deepEqual(recorded.calls[0]?.args, [
    {
      guildId: "g1",
      title: "Meeting",
      startsAt: "2026-09-01T18:00:00.000Z",
      type: "MEETING",
      hostDiscordId: "111",
      description: null,
      capacity: null,
    },
  ]);
});

test("cancelling passes the actor through, so the host check has something to compare", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  assert.equal((await mutations.cancelEvent(session(), "g1", "not an id!")).error?.kind, "INVALID_INPUT");
  assert.equal((await mutations.cancelEvent(session(), "g1", "evt_1")).ok, true);
  assert.deepEqual(recorded.calls[0], { method: "cancelEvent", args: ["evt_1", "111"] });
});

test("events are Officer work — a moderator is refused both halves", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "MODERATOR" } });

  const created = await mutations.createEvent(session(), "g1", {
    title: "Run",
    type: "DUNGEON",
    startsAt: "2026-09-01T18:00:00.000Z",
  });
  const cancelled = await mutations.cancelEvent(session(), "g1", "evt_1");

  assert.equal(created.access.allowed, false);
  assert.equal(cancelled.access.allowed, false);
  assert.deepEqual(recorded.calls, []);
});

// ── domain refusal ──

test("a refusal from the config service surfaces as SERVICE_ERROR and writes no audit", async () => {
  const { mutations, recorded } = make({ result: err({ kind: "NOT_CONFIGURED" }) as Result<void> });

  const result = await mutations.setFeature(session(), "g1", "lfg", true);

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, "SERVICE_ERROR");
  assert.equal(result.error?.detail, "NOT_CONFIGURED");
  assert.deepEqual(recorded.audits, []);
  assert.equal(recorded.usage[0]?.success, false);
});

// ── screening policy ──
//
// The one mutation whose contents decide whether a stranger is admitted with
// nobody looking, so these tests are mostly about the ways a policy could be
// *quietly wrong*: a mistyped field that reads back as "no requirement", a coin
// threshold rounded off by a double, an auto-accept switch left on with
// screening disabled. Each of those would save successfully and then not do
// what the admin believed they had set.

/** A complete, valid payload — the shape the settings form sends. */
function policyBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...serializePolicy(DEFAULT_POLICY), ...over };
}

test("a complete policy is stored under the screening key", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setScreeningPolicy(session(), "g1", policyBody({ minSkillAverage: 30 }));

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [
    {
      method: "setSetting",
      args: ["g1", SCREENING_POLICY_KEY, { ...serializePolicy(DEFAULT_POLICY), minSkillAverage: 30 }],
    },
  ]);
});

test("an unknown screening field is refused rather than ignored", async () => {
  // The whole point of the strict write surface: `minCatacomb` accepted here
  // would read back as "no dungeon requirement", and nothing on the page would
  // tell the admin that apart from a working setting.
  const { mutations, recorded } = make();

  const result = await mutations.setScreeningPolicy(session(), "g1", policyBody({ minCatacomb: 30 }));

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, "INVALID_INPUT");
  assert.match(result.error?.detail ?? "", /minCatacomb/);
  assert.deepEqual(recorded.calls, [], "nothing may be written when part of the payload is rejected");
});

test("a coin threshold past 2^53 keeps every digit", async () => {
  const huge = "123456789012345678";
  const { mutations, recorded } = make();

  const result = await mutations.setScreeningPolicy(session(), "g1", policyBody({ minNetworth: huge }));

  assert.equal(result.ok, true);
  assert.equal((recorded.calls[0]?.args[2] as Record<string, unknown>)["minNetworth"], huge);
});

test("a coin threshold that is not digits is refused", async () => {
  const { mutations, recorded } = make();

  for (const bad of ["10b", "1e9", "-5", "1.5", " ", "abc", 1.5, -1]) {
    const result = await mutations.setScreeningPolicy(session(), "g1", policyBody({ minNetworth: bad }));
    assert.equal(result.ok, false, String(bad));
  }
  assert.deepEqual(recorded.calls, []);
});

test("a blank screening bar is null, not zero", async () => {
  // Null means "do not check this". Zero is a bar everybody clears — the same
  // outcome today, but a different instruction, and it reads differently in a
  // report about why somebody was let in.
  const { mutations, recorded } = make();

  await mutations.setScreeningPolicy(session(), "g1", policyBody({ minSkillAverage: null, minCatacombs: 0 }));

  const stored = recorded.calls[0]?.args[2] as Record<string, unknown>;
  assert.equal(stored["minSkillAverage"], null);
  assert.equal(stored["minCatacombs"], 0);
});

test("auto-accept cannot be left on with screening disabled", async () => {
  // Otherwise the policy reads as "admit everyone without checking", which is
  // the one configuration no admin means to save.
  const { mutations } = make();

  const result = await mutations.setScreeningPolicy(
    session(),
    "g1",
    policyBody({ enabled: false, autoAccept: true }),
  );

  assert.equal(result.ok, false);
  assert.match(result.error?.detail ?? "", /autoAccept requires enabled/);
});

test("screening off with auto-accept off is a legitimate policy", async () => {
  const { mutations } = make();

  const result = await mutations.setScreeningPolicy(
    session(),
    "g1",
    policyBody({ enabled: false, autoAccept: false }),
  );

  assert.equal(result.ok, true);
});

test("a risk threshold outside the score's range is refused", async () => {
  const { mutations } = make();

  for (const bad of [-1, 101, 12.5, "50", null]) {
    const result = await mutations.setScreeningPolicy(session(), "g1", policyBody({ reviewAtRisk: bad }));
    assert.equal(result.ok, false, String(bad));
  }
});

test("a missing screening flag is refused rather than defaulted", async () => {
  // The form sends the whole policy every time. Quietly filling an absent field
  // from the defaults would turn a partial write into a silent rollback of
  // somebody else's edit.
  const { mutations } = make();
  const body = policyBody();
  delete body["denyOnScammer"];

  const result = await mutations.setScreeningPolicy(session(), "g1", body);

  assert.equal(result.ok, false);
  assert.match(result.error?.detail ?? "", /denyOnScammer/);
});

test("the screening audit records the policy in full", async () => {
  // Unlike config.setting, which logs only the key: a policy is numbers and
  // switches with nobody's words in it, and "who lowered the bar, and to what"
  // is the question this audit exists to answer.
  const { mutations, recorded } = make();

  await mutations.setScreeningPolicy(session(), "g1", policyBody({ autoAccept: true, minSkillAverage: 35 }));

  assert.equal(recorded.audits.length, 1);
  assert.equal(recorded.audits[0]?.mutation, "config.screening");
  assert.equal(recorded.audits[0]?.actorDiscordId, "111");
  assert.equal(recorded.audits[0]?.change["autoAccept"], true);
  assert.equal(recorded.audits[0]?.change["minSkillAverage"], 35);
});

test("an officer cannot change the entry bar", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  const result = await mutations.setScreeningPolicy(session(), "g1", policyBody());

  assert.equal(result.access.allowed, false);
  assert.deepEqual(recorded.calls, []);
});

// ── xp ──

const sourceBody = (over: Partial<XpSourcePolicyDTO> = {}): Record<string, unknown> => ({
  source: "DISCORD_MESSAGE",
  enabled: true,
  weight: 1.5,
  dailyCap: 200,
  cooldownSec: 60,
  minLength: 8,
  ...over,
});

test("a source policy reaches the XP service whole, and the audit records it in full", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setXpSource(session(), "g1", sourceBody());

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [
    {
      method: "setSourcePolicy",
      args: [
        "g1",
        { source: "DISCORD_MESSAGE", enabled: true, weight: 1.5, dailyCap: 200, cooldownSec: 60, minLength: 8 },
      ],
    },
  ]);
  assert.equal(recorded.audits[0]?.mutation, "xp.source");
  assert.equal(recorded.audits[0]?.change["weight"], 1.5);
});

test("null is an uncapped source, not a missing field", async () => {
  const { mutations, recorded } = make();

  assert.equal((await mutations.setXpSource(session(), "g1", sourceBody({ dailyCap: null }))).ok, true);
  assert.equal((recorded.calls[0]?.args[1] as XpSourcePolicyDTO).dailyCap, null);
});

test("a fractional weight is allowed but a fractional cooldown is not", async () => {
  const { mutations } = make();

  assert.equal((await mutations.setXpSource(session(), "g1", sourceBody({ weight: 0.01 }))).ok, true);
  const bad = await mutations.setXpSource(session(), "g1", sourceBody({ cooldownSec: 1.5 }));
  assert.equal(bad.ok, false);
  assert.equal(bad.error?.kind, "INVALID_INPUT");
});

test("an out-of-range weight is refused before it reaches the service", async () => {
  // The realistic accident: a cap typed into the weight box. Ten thousand XP
  // per message would put one member permanently at the top of a ladder nobody
  // else could catch, and no later config change takes it back.
  const { mutations, recorded } = make();

  const result = await mutations.setXpSource(session(), "g1", sourceBody({ weight: 10_000 }));

  assert.equal(result.ok, false);
  assert.deepEqual(recorded.calls, []);
});

test("an unknown source name is refused rather than stored as a row nothing reads", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.setXpSource(session(), "g1", sourceBody({ source: "VOICE" as never }));

  assert.equal(result.ok, false);
  assert.deepEqual(recorded.calls, []);
});

test("an adjustment carries the actor, and its reason reaches the ledger", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.adjustXp(session(), "g1", {
    discordId: "222222222222222222",
    amount: -250,
    reason: "  duplicate event payout  ",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [
    { method: "adjust", args: ["g1", "222222222222222222", -250, "duplicate event payout", "111"] },
  ]);
  assert.equal(recorded.audits[0]?.mutation, "xp.adjust");
  assert.equal(recorded.audits[0]?.change["amount"], -250);
});

test("an adjustment of zero, or without a reason, writes nothing", async () => {
  const { mutations, recorded } = make();
  const target = "222222222222222222";

  const zero = await mutations.adjustXp(session(), "g1", { discordId: target, amount: 0, reason: "x" });
  const unreasoned = await mutations.adjustXp(session(), "g1", { discordId: target, amount: 10, reason: "   " });

  assert.equal(zero.ok, false);
  assert.equal(unreasoned.ok, false);
  assert.deepEqual(recorded.calls, []);
});

test("a throwing XP service is reported as a service error, not an unhandled rejection", async () => {
  // XpService is not a Result service — it throws. If this layer let that
  // escape, the panel's write endpoint would answer 500 with a stack trace
  // where every other refusal answers with a sentence.
  const { mutations, recorded } = make({ xpThrows: true });

  const result = await mutations.setXpSource(session(), "g1", sourceBody());

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, "SERVICE_ERROR");
  assert.deepEqual(recorded.audits, []);
});

test("with XP unwired, both writes refuse instead of crashing the request", async () => {
  const { mutations, recorded } = make({ noXp: true });

  const source = await mutations.setXpSource(session(), "g1", sourceBody());
  const adjust = await mutations.adjustXp(session(), "g1", {
    discordId: "222222222222222222", amount: 5, reason: "test",
  });

  assert.equal(source.ok, false);
  assert.equal(source.error?.kind, "SERVICE_ERROR");
  assert.equal(adjust.ok, false);
  assert.deepEqual(recorded.audits, []);
});

test("an officer can neither reweight XP nor adjust a balance", async () => {
  // Both are ADMIN because the page is: XP weights decide what the whole
  // guild's standing means, and an adjustment is the one award no counter can
  // explain afterwards.
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  const source = await mutations.setXpSource(session(), "g1", sourceBody());
  const adjust = await mutations.adjustXp(session(), "g1", {
    discordId: "222222222222222222", amount: 5, reason: "test",
  });

  assert.equal(source.access.allowed, false);
  assert.equal(adjust.access.allowed, false);
  assert.deepEqual(recorded.calls, []);
});

// ── milestones ──

const milestoneBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  key: "networth:1b",
  label: "1b networth",
  description: null,
  type: "NETWORTH_THRESHOLD",
  metric: "networth",
  threshold: 1_000_000_000,
  xpReward: 500,
  announce: true,
  enabled: true,
  ...over,
});

test("a definition reaches the milestone service whole, and the audit records it in full", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.upsertMilestone(session(), "g1", milestoneBody());

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [
    {
      method: "upsertMilestone",
      args: [
        "g1",
        {
          key: "networth:1b",
          label: "1b networth",
          description: null,
          type: "NETWORTH_THRESHOLD",
          metric: "networth",
          threshold: 1_000_000_000,
          xpReward: 500,
          announce: true,
          enabled: true,
        },
      ],
    },
  ]);
  assert.equal(recorded.audits[0]?.mutation, "milestone.upsert");
  assert.deepEqual(recorded.audits[0]?.change, {
    key: "networth:1b",
    label: "1b networth",
    description: null,
    type: "NETWORTH_THRESHOLD",
    metric: "networth",
    threshold: 1_000_000_000,
    xpReward: 500,
    announce: true,
    enabled: true,
  });
});

test("a definition that could never fire is refused before it reaches the store", async () => {
  const { mutations, recorded } = make();

  const cases: Record<string, unknown>[] = [
    { key: "Networth 1B" },              // keys are lowercase and punctuated, not prose
    { key: "" },
    { label: "   " },
    { label: "x".repeat(81) },
    { type: "SOMETHING_ELSE" },
    { metric: "bankBalance" },           // not a snapshot field the detector reads
    { threshold: 0 },
    { threshold: -5 },
    { threshold: "1000000000" },
    { xpReward: 2_000_000 },             // above MAX_MILESTONE_REWARD
    { xpReward: 1.5 },
    { xpReward: -1 },
    { announce: "yes" },
    { enabled: null },
  ];

  for (const [i, over] of cases.entries()) {
    const result = await mutations.upsertMilestone(session(), "g1", milestoneBody(over));
    assert.equal(result.ok, false, `case ${i}`);
    assert.equal(result.error?.kind, "INVALID_INPUT", `case ${i}`);
  }
  // Nothing was stored, and nothing invalid was written to the trail either.
  assert.deepEqual(recorded.calls, []);
  assert.deepEqual(recorded.audits, []);
});

test("a description is optional but bounded", async () => {
  const { mutations } = make();

  assert.equal((await mutations.upsertMilestone(session(), "g1", milestoneBody({ description: "why" }))).ok, true);
  const long = await mutations.upsertMilestone(session(), "g1", milestoneBody({ description: "x".repeat(501) }));
  assert.equal(long.error?.kind, "INVALID_INPUT");
});

test("removing a key nobody stored is a success, reported as nothing removed", async () => {
  // The page lists built-in defaults next to stored rows, so "remove" on a
  // default is a reasonable thing to click. The end state the caller wanted —
  // no row of this guild's own — is already true.
  const { mutations, recorded } = make({ milestoneRemoved: false });

  const result = await mutations.removeMilestone(session(), "g1", "networth:1b");

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [{ method: "removeMilestone", args: ["g1", "networth:1b"] }]);
  assert.deepEqual(recorded.audits[0]?.change, { key: "networth:1b", removed: false });
});

test("a removal needs a key shaped like one", async () => {
  const { mutations, recorded } = make();

  assert.equal((await mutations.removeMilestone(session(), "g1", "")).error?.kind, "INVALID_INPUT");
  assert.equal((await mutations.removeMilestone(session(), "g1", 7)).error?.kind, "INVALID_INPUT");
  assert.deepEqual(recorded.calls, []);
});

test("with milestones unwired, both writes refuse instead of crashing the request", async () => {
  const { mutations, recorded } = make({ noMilestones: true });

  const upsert = await mutations.upsertMilestone(session(), "g1", milestoneBody());
  const remove = await mutations.removeMilestone(session(), "g1", "networth:1b");

  assert.equal(upsert.error?.kind, "SERVICE_ERROR");
  assert.equal(remove.error?.kind, "SERVICE_ERROR");
  assert.deepEqual(recorded.audits, []);
});

test("an officer cannot change what the guild recognises", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  const upsert = await mutations.upsertMilestone(session(), "g1", milestoneBody());
  const remove = await mutations.removeMilestone(session(), "g1", "networth:1b");

  assert.equal(upsert.access.allowed, false);
  assert.equal(remove.access.allowed, false);
  assert.deepEqual(recorded.calls, []);
});

// ── tickets ──

const ticketTypeBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  key: "staff-app",
  label: "Staff application",
  emoji: null,
  category: "APPLICATION",
  parentChannelId: null,
  staffRoleIds: [],
  prompt: "Tell us why.",
  position: 3,
  enabled: true,
  ...over,
});

test("a ticket type reaches the service whole, and the audit records it in full", async () => {
  const { mutations, recorded } = make();

  const result = await mutations.upsertTicketType(session(), "g1", ticketTypeBody());

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [
    {
      method: "upsertTicketType",
      args: [
        "g1",
        {
          key: "staff-app",
          label: "Staff application",
          emoji: null,
          category: "APPLICATION",
          parentChannelId: null,
          staffRoleIds: [],
          prompt: "Tell us why.",
          position: 3,
          enabled: true,
        },
      ],
    },
  ]);
  assert.equal(recorded.audits[0]?.mutation, "ticket.type.upsert");
  assert.equal((recorded.audits[0]?.change as Record<string, unknown>)["key"], "staff-app");
});

test("a ticket type that could never be opened is refused before it reaches the store", async () => {
  const { mutations, recorded } = make();

  const cases: Record<string, unknown>[] = [
    { key: "Staff App" },                       // keys are lowercase and typable
    { key: "" },
    { label: "   " },
    { label: "x".repeat(81) },
    { category: "BILLING" },                    // not one of the fixed categories
    { parentChannelId: "not-a-channel" },
    { staffRoleIds: "123456789012345678" },     // a list, not one id
    { staffRoleIds: ["nope"] },
    { staffRoleIds: Array.from({ length: 11 }, (_, i) => String(100000000000000000 + i)) },
    { prompt: "x".repeat(501) },
    { position: -1 },
    { position: 1.5 },
    { enabled: "yes" },
  ];

  for (const [i, over] of cases.entries()) {
    const result = await mutations.upsertTicketType(session(), "g1", ticketTypeBody(over));
    assert.equal(result.ok, false, `case ${i}`);
    assert.equal(result.error?.kind, "INVALID_INPUT", `case ${i}`);
  }
  assert.deepEqual(recorded.calls, []);
  assert.deepEqual(recorded.audits, []);
});

test("duplicate staff roles are stored once, so nobody is pinged twice", async () => {
  const { mutations, recorded } = make();

  await mutations.upsertTicketType(
    session(),
    "g1",
    ticketTypeBody({ staffRoleIds: ["123456789012345678", "123456789012345678"] }),
  );

  const input = recorded.calls[0]?.args[1] as { staffRoleIds: readonly string[] };
  assert.deepEqual(input.staffRoleIds, ["123456789012345678"]);
});

test("removing a ticket type nobody stored is a success, reported as nothing removed", async () => {
  // The page lists built-ins next to stored rows, so "remove" on a built-in is
  // a reasonable thing to click; the end state is already true.
  const { mutations, recorded } = make({ ticketTypeRemoved: false });

  const result = await mutations.removeTicketType(session(), "g1", "support");

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.calls, [{ method: "removeTicketType", args: ["g1", "support"] }]);
  assert.deepEqual(recorded.audits[0]?.change, { key: "support", removed: false });
});

test("the panel needs a title and a channel that could exist", async () => {
  const { mutations, recorded } = make();

  assert.equal(
    (await mutations.saveTicketPanel(session(), "g1", { channelId: null, title: "Support", description: null })).ok,
    true,
  );
  const bad = await mutations.saveTicketPanel(session(), "g1", { channelId: "here", title: "Support", description: null });
  assert.equal(bad.error?.kind, "INVALID_INPUT");
  const untitled = await mutations.saveTicketPanel(session(), "g1", { channelId: null, title: " ", description: null });
  assert.equal(untitled.error?.kind, "INVALID_INPUT");
  assert.equal(recorded.calls.length, 1);
});

test("with tickets unwired, every write refuses instead of crashing the request", async () => {
  const { mutations, recorded } = make({ noTickets: true });

  assert.equal((await mutations.upsertTicketType(session(), "g1", ticketTypeBody())).error?.kind, "SERVICE_ERROR");
  assert.equal((await mutations.removeTicketType(session(), "g1", "support")).error?.kind, "SERVICE_ERROR");
  assert.equal(
    (await mutations.saveTicketPanel(session(), "g1", { channelId: null, title: "Support", description: null }))
      .error?.kind,
    "SERVICE_ERROR",
  );
  assert.deepEqual(recorded.audits, []);
});

test("an officer cannot change what a member may open", async () => {
  const { mutations, recorded } = make({ roleMap: { "111": "OFFICER" } });

  assert.equal((await mutations.upsertTicketType(session(), "g1", ticketTypeBody())).access.allowed, false);
  assert.equal((await mutations.removeTicketType(session(), "g1", "support")).access.allowed, false);
  assert.deepEqual(recorded.calls, []);
});
