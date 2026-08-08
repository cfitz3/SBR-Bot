/**
 * PanelMutations — the write pipeline: authorize → rate-limit → validate → call
 * the domain service → audit. The GuildConfigService here is a recorder, because
 * what these tests assert is what reaches it (and what never does), not what it
 * then writes; that belongs to @sbr/guild-config.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  err,
  ok,
  type CommunityService,
  type GuildConfigService,
  type IdentityService,
  type MemberRole,
  type ModerationService,
  type Result,
} from "@sbr/shared-types";
import type { AnalyticsService, CommandUsageDTO } from "@sbr/shared-types";
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
  over: { roleMap?: Record<string, MemberRole>; result?: Result<void>; blocked?: readonly string[] } = {},
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
