import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AuditQuery,
  EnforcementStatus,
  MemberRole,
  ModActionType,
  ModerationActionDTO,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { ModerationServiceImpl } from "./service.js";
import { DISCORD_ACTOR, type ModLogSink } from "./mod-log.js";
import type {
  BotCapabilities,
  DiscordEnforcer,
  EnforcementMirror,
  GameCommandBus,
  GameCommandOutcome,
  IgnResolver,
  RelaySyncSource,
  StaffAlertSink,
  EscalationPolicySource,
  ModerationRepository,
  NewActionRecord,
  RankResolver,
} from "./ports.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

interface EnforcementWrite {
  readonly actionId: string;
  readonly status: EnforcementStatus;
  readonly detail: string | null;
}

function repo(stale: readonly ModerationActionDTO[] = []): {
  repo: ModerationRepository;
  created: NewActionRecord[];
  enforced: EnforcementWrite[];
} {
  const created: NewActionRecord[] = [];
  const enforced: EnforcementWrite[] = [];
  return {
    created,
    enforced,
    repo: {
      async createInfraction(input) { return { ...input, id: "inf-1", createdAt: "t" }; },
      async createAction(input) {
        created.push(input);
        return { ...input, id: "act-1", caseCode: "CASE-target-a1b2c3d4-1", createdAt: "t", enforcement: "PENDING", enforcementDetail: null, updatedAt: null, editedByDiscordId: null, voidedAt: null, voidReason: null } as ModerationActionDTO;
      },
      async listInfractions() { return []; },
      async listRecentInfractions() { return []; },
      async listActions() { return []; },
      async deactivateExpired() { return 0; },
      async setEnforcement(actionId, status, detail) { enforced.push({ actionId, status, detail }); },
      async listExpiredActive() { return []; },
      async listStalePending() { return stale; },
      async findAction() { return null; },
      async updateAction() { return null; },
    },
  };
}

/**
 * Unknown ids resolve to null, not MEMBER.
 *
 * The `?? "MEMBER"` this used to end with is why a whole enforcement path could
 * be dead for as long as it was: automod acts as the id `automod`, which has no
 * member row, so the real resolver answered null and every automod punishment
 * was refused as TARGET_OUTRANKS_ACTOR. The fake answered MEMBER and the suite
 * stayed green. A fake that is kinder than the thing it stands in for tests
 * nothing.
 */
function ranks(map: Record<string, MemberRole>): RankResolver {
  return { async getRole(_g, id) { return map[id] ?? null; } };
}

function enforcement(): { mirror: EnforcementMirror; applied: ModerationActionDTO[] } {
  const applied: ModerationActionDTO[] = [];
  return { applied, mirror: { async apply(a) { applied.push(a); } } };
}

const allowAll: BotCapabilities = { async canPerform() { return true; } };

/** An enforcer that always succeeds, for the tests that are about something else. */
const enforcerOk: DiscordEnforcer = { async enforce() { return { ok: true }; } };

function build(over: {
  repoImpl?: ModerationRepository;
  ranks?: RankResolver;
  botCaps?: BotCapabilities;
  mirror?: EnforcementMirror;
  escalation?: EscalationPolicySource;
  discord?: DiscordEnforcer;
  staffAlerts?: StaffAlertSink;
  gameCommands?: GameCommandBus;
  igns?: IgnResolver;
  relaySync?: RelaySyncSource;
  modLog?: ModLogSink;
} = {}) {
  return new ModerationServiceImpl({
    repo: over.repoImpl ?? repo().repo,
    ...(over.escalation ? { escalation: over.escalation } : {}),
    // Default: actor outranks target so punitive actions reach the later guards.
    ranks: over.ranks ?? ranks({ actor: "OFFICER", target: "MEMBER" }),
    enforcement: over.mirror ?? enforcement().mirror,
    // Defaulted to a working enforcer: a service with none records every
    // punishment as FAILED, which is correct behaviour and would otherwise
    // silently change what the older tests here are asserting.
    discord: over.discord ?? enforcerOk,
    ...(over.staffAlerts ? { staffAlerts: over.staffAlerts } : {}),
    ...(over.gameCommands ? { gameCommands: over.gameCommands } : {}),
    ...(over.igns ? { igns: over.igns } : {}),
    ...(over.relaySync ? { relaySync: over.relaySync } : {}),
    ...(over.modLog ? { modLog: over.modLog } : {}),
    botCaps: over.botCaps ?? allowAll,
    logger: silent,
    now: () => new Date("2026-08-06T00:00:00.000Z"),
  });
}

function input(type: ModActionType, over: Record<string, unknown> = {}) {
  return {
    guildId: "g1",
    type,
    actorDiscordId: "actor",
    targetDiscordId: "target",
    reason: "because",
    ...over,
  };
}

test("MUTE requires a duration", async () => {
  const r = await build().applyAction(input("MUTE"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "DURATION_REQUIRED");
});

test("MUTE with a duration sweeps both surfaces and computes expiry", async () => {
  const r = repo();
  const e = enforcement();
  const svc = build({ repoImpl: r.repo, mirror: e.mirror });
  const result = await svc.applyAction(input("MUTE", { durationSeconds: 3600 }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.surfaces, ["DISCORD", "GUILD_CHAT"]);
    assert.equal(result.value.expiresAt, "2026-08-06T01:00:00.000Z");
    assert.equal(result.value.active, true);
  }
  assert.equal(e.applied.length, 1); // mirrored to Redis
});

test("cannot action a target of equal or higher rank", async () => {
  const svc = build({ ranks: ranks({ actor: "OFFICER", target: "OFFICER" }) });
  const r = await svc.applyAction(input("KICK"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "TARGET_OUTRANKS_ACTOR");
});

test("can action a lower-ranked target", async () => {
  const svc = build({ ranks: ranks({ actor: "OFFICER", target: "MEMBER" }) });
  const r = await svc.applyAction(input("KICK"));
  assert.equal(r.ok, true);
});

test("cannot punish yourself", async () => {
  const r = await build().applyAction(input("WARN", { targetDiscordId: "actor" }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "SELF_TARGET");
});

test("refuses when the bot lacks the Discord permission", async () => {
  const noPerm: BotCapabilities = { async canPerform() { return false; } };
  const r = await build({ botCaps: noPerm }).applyAction(input("BAN"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "BOT_MISSING_PERMISSION");
});

test("WARN is Discord-only surface and has no expiry", async () => {
  const r = await build().applyAction(input("WARN"));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.value.surfaces, ["DISCORD"]);
    assert.equal(r.value.expiresAt, null);
  }
});

test("NOTE bypasses rank/self-target guards (annotation, not punishment)", async () => {
  const svc = build({ ranks: ranks({ actor: "MODERATOR", target: "OWNER" }) });
  const r = await svc.applyAction(input("NOTE", { targetDiscordId: "actor" }));
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.active, false);
});

test("listInForce narrows in the store and re-checks against this process's clock", async () => {
  // The store answers with a row that expired a second after it was queried;
  // the service must not hand it on as something still being served.
  let seen: AuditQuery | null = null;
  const stale: ModerationActionDTO = {
    id: "a1", caseCode: "CASE-target-a1b2c3d4-1", guildId: "g1", type: "MUTE", actorDiscordId: "actor", targetDiscordId: "target",
    reason: "spam", durationSeconds: 60, expiresAt: "2026-08-05T23:59:00.000Z",
    surfaces: ["DISCORD"], active: true, createdAt: "2026-08-05T23:58:00.000Z",
    enforcement: "CONFIRMED", enforcementDetail: null,
    updatedAt: null, editedByDiscordId: null, voidedAt: null, voidReason: null,
  };
  const live: ModerationActionDTO = { ...stale, id: "a2", expiresAt: null, type: "BAN" };
  const svc = build({
    repoImpl: {
      ...repo().repo,
      async listActions(q) { seen = q; return [stale, live]; },
    },
  });

  const r = await svc.listInForce("g1", "target");
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value.map((a) => a.id), ["a2"]);
  const q = seen as unknown as AuditQuery;
  assert.equal(q.inForceOnly, true);
  assert.equal(q.targetDiscordId, "target");
});

test("listInForce with no target asks about the whole guild", async () => {
  let seen: AuditQuery | null = null;
  const svc = build({
    repoImpl: { ...repo().repo, async listActions(q) { seen = q; return []; } },
  });
  await svc.listInForce("g1");
  assert.equal((seen as unknown as AuditQuery).targetDiscordId, null);
});

test("sweepExpired reports what it cleared and passes the clock down", async () => {
  let seenNow: Date | null = null;
  const svc = build({
    repoImpl: {
      ...repo().repo,
      async deactivateExpired(_g, now) { seenNow = now; return 3; },
    },
  });
  const r = await svc.sweepExpired();
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, 3);
  // The injected clock, not the wall clock: a sweep run against "now" in a test
  // that fixed the time everywhere else would clear rows the test never made.
  assert.equal((seenNow as unknown as Date).toISOString(), "2026-08-06T00:00:00.000Z");
});

// ── auto-warn escalation ────────────────────────────────────────────────────

/** A repo whose warn history is fixed, so the ladder is the only variable. */
function repoWithWarns(count: number): { repo: ModerationRepository; created: NewActionRecord[] } {
  const base = repo();
  const history: ModerationActionDTO[] = Array.from({ length: count }, (_, i) => ({
    id: `w${i}`, caseCode: `CASE-target-a1b2c3d4-${i + 1}`, guildId: "g1", type: "WARN", actorDiscordId: "actor", targetDiscordId: "target",
    reason: "spam", durationSeconds: null, expiresAt: null, surfaces: ["DISCORD"],
    active: true, createdAt: "2026-08-05T00:00:00.000Z",
    enforcement: "NOT_REQUIRED", enforcementDetail: null,
    updatedAt: null, editedByDiscordId: null, voidedAt: null, voidReason: null,
  }));
  return {
    created: base.created,
    repo: { ...base.repo, async createAction(i) { base.created.push(i); return { ...i, id: "act", caseCode: "CASE-target-a1b2c3d4-1", createdAt: "t", enforcement: "PENDING", enforcementDetail: null, updatedAt: null, editedByDiscordId: null, voidedAt: null, voidReason: null } as ModerationActionDTO; }, async listActions() { return history; } },
  };
}

const policy = (value: unknown): EscalationPolicySource => ({ async readPolicy() { return value; } });

test("the third warning in the window escalates to a mute", async () => {
  const r = repoWithWarns(3);
  const svc = build({ repoImpl: r.repo, escalation: policy(null) });
  const result = await svc.applyAction(input("WARN"));
  assert.equal(result.ok, true);

  // Two rows written: the warning, then the escalation it tripped.
  assert.deepEqual(r.created.map((a) => a.type), ["WARN", "MUTE"]);
  const escalated = r.created[1]!;
  assert.equal(escalated.durationSeconds, 3600);
  assert.equal(escalated.reason, "Automatic escalation: 3 warnings in 90 days");
  // Attributed to the staffer who warned, so the row has somebody to ask.
  assert.equal(escalated.actorDiscordId, "actor");
});

test("a warning between rungs escalates to nothing", async () => {
  const r = repoWithWarns(4);
  await build({ repoImpl: r.repo, escalation: policy(null) }).applyAction(input("WARN"));
  assert.deepEqual(r.created.map((a) => a.type), ["WARN"]);
});

test("a guild that has turned escalation off gets a warning and nothing else", async () => {
  const r = repoWithWarns(3);
  await build({ repoImpl: r.repo, escalation: policy({ enabled: false }) }).applyAction(input("WARN"));
  assert.deepEqual(r.created.map((a) => a.type), ["WARN"]);
});

test("with no policy source wired, warnings are only warnings", async () => {
  const r = repoWithWarns(7);
  await build({ repoImpl: r.repo }).applyAction(input("WARN"));
  assert.deepEqual(r.created.map((a) => a.type), ["WARN"]);
});

test("a guild rung overrides the default at that count", async () => {
  const r = repoWithWarns(3);
  const svc = build({
    repoImpl: r.repo,
    escalation: policy({ rungs: [{ warns: 3, action: "BAN", durationSeconds: null }] }),
  });
  await svc.applyAction(input("WARN"));
  assert.deepEqual(r.created.map((a) => a.type), ["WARN", "BAN"]);
  assert.equal(r.created[1]!.expiresAt, null);
});

test("an escalation the bot cannot enforce still leaves the warning standing", async () => {
  // The warning is the record that must survive; a refused ban must not take it
  // down with it.
  const r = repoWithWarns(7);
  const noBan: BotCapabilities = { async canPerform(_g, type) { return type !== "BAN"; } };
  const result = await build({ repoImpl: r.repo, botCaps: noBan, escalation: policy(null) })
    .applyAction(input("WARN"));
  assert.equal(result.ok, true);
  assert.deepEqual(r.created.map((a) => a.type), ["WARN"]);
});

test("a policy source that throws does not fail the warning", async () => {
  const r = repoWithWarns(3);
  const broken: EscalationPolicySource = { async readPolicy() { throw new Error("settings down"); } };
  const result = await build({ repoImpl: r.repo, escalation: broken }).applyAction(input("WARN"));
  assert.equal(result.ok, true);
  assert.deepEqual(r.created.map((a) => a.type), ["WARN"]);
});

test("escalation does not recurse — the mute it applies is not itself escalated", async () => {
  const r = repoWithWarns(3);
  await build({ repoImpl: r.repo, escalation: policy(null) }).applyAction(input("WARN"));
  assert.equal(r.created.filter((a) => a.type === "MUTE").length, 1);
});


// -----------------------------------------------------------------------------
// Enforcement: the half of a punishment that is not a database row.
//
// Every test below covers a path that was, until this change, either absent or
// silently a no-op. The confirmed live report - "a ban logged the case, but the
// member was neither banned from Discord nor kicked from the guild" - is the
// first three.
// -----------------------------------------------------------------------------

/** A bus that records what it was asked to run, and what the guild made of it. */
function bus(outcome: GameCommandOutcome = "CONFIRMED_INGAME"): { bus: GameCommandBus; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    bus: { async send(_g, command) { sent.push(command); return { outcome, detail: `stub: ${outcome}` }; } },
  };
}

const linked: IgnResolver = { async ignFor() { return "TargetIGN"; } };
/** Relay sync at its shipped defaults, which map BAN to `g kick`. */
const defaultRelay: RelaySyncSource = { async readRelaySync() { return undefined; } };

function alerts(): { sink: StaffAlertSink; posted: { guildId: string; text: string }[] } {
  const posted: { guildId: string; text: string }[] = [];
  return { posted, sink: { async alert(guildId, text) { posted.push({ guildId, text }); } } };
}

test("BAN calls the Discord enforcer, not merely the Redis mirror", async () => {
  // The original bug in one assertion: the admin bot wired the mirror as though
  // it were enforcement, so this call never happened and /ban banned nobody.
  const seen: ModActionType[] = [];
  const discord: DiscordEnforcer = {
    async enforce(action) { seen.push(action.type); return { ok: true }; },
  };
  const result = await build({ discord }).applyAction(input("BAN"));
  assert.equal(result.ok, true);
  assert.deepEqual(seen, ["BAN"]);
});

test("BAN relays a guild kick to guild chat for a linked member", async () => {
  const b = bus();
  const result = await build({ gameCommands: b.bus, igns: linked, relaySync: defaultRelay })
    .applyAction(input("BAN"));
  assert.equal(result.ok, true);
  assert.deepEqual(b.sent, ["/g kick TargetIGN because"]);
  if (result.ok) assert.equal(result.value.enforcement, "CONFIRMED");
});

test("a ban the bridge cannot run is FAILED, not resolved", async () => {
  // The offline bridge: Redis accepted the publish and nobody was listening.
  // The case must not read as a completed ban.
  const r = repo();
  const a = alerts();
  const b = bus("NO_SESSION");
  const result = await build({
    repoImpl: r.repo, gameCommands: b.bus, igns: linked, relaySync: defaultRelay, staffAlerts: a.sink,
  }).applyAction(input("BAN"));

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.enforcement, "FAILED");
    assert.match(result.value.enforcementDetail ?? "", /guild chat/);
  }
  assert.deepEqual(r.enforced.map((w) => w.status), ["FAILED"]);
  assert.equal(a.posted.length, 1);
  assert.match(a.posted[0]!.text, /Enforcement failed/);
});

test("a ban Discord refuses is FAILED and names the reason", async () => {
  const r = repo();
  const a = alerts();
  const discord: DiscordEnforcer = {
    async enforce() { return { ok: false, reason: "missing Ban Members" }; },
  };
  const result = await build({ repoImpl: r.repo, discord, staffAlerts: a.sink }).applyAction(input("BAN"));

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.enforcement, "FAILED");
    assert.match(result.value.enforcementDetail ?? "", /missing Ban Members/);
  }
  assert.match(a.posted[0]?.text ?? "", /missing Ban Members/);
});

test("a process with no Discord enforcer wired fails the action rather than claiming it worked", async () => {
  // The panel and the workers have no gateway. Recording a ban there as
  // CONFIRMED is precisely the state the audit log must never contain.
  const svc = new ModerationServiceImpl({
    repo: repo().repo,
    ranks: ranks({ actor: "OFFICER", target: "MEMBER" }),
    enforcement: enforcement().mirror,
    botCaps: allowAll,
    logger: silent,
    now: () => new Date("2026-08-06T00:00:00.000Z"),
  });
  const result = await svc.applyAction(input("BAN"));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.enforcement, "FAILED");
    assert.match(result.value.enforcementDetail ?? "", /Discord/);
  }
});

test("a ban whose reason has nothing sendable fails rather than kicking nobody", async () => {
  // Hypixel refuses `/g kick <name>` with no reason. Sending it anyway was the
  // silent failure: the case said banned, the guild slot stayed filled.
  const b = bus();
  const a = alerts();
  const result = await build({
    gameCommands: b.bus,
    igns: linked,
    relaySync: defaultRelay,
    staffAlerts: a.sink,
  }).applyAction(input("BAN", { reason: "###" }));
  assert.deepEqual(b.sent, []);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.enforcement, "FAILED");
    assert.match(result.value.enforcementDetail ?? "", /reason/);
  }
  assert.match(a.posted.map((p) => p.text).join(" "), /reason/);
});

test("an unlinked member is skipped in guild chat, not treated as a failure", async () => {
  const b = bus();
  const unlinked: IgnResolver = { async ignFor() { return null; } };
  const result = await build({ gameCommands: b.bus, igns: unlinked, relaySync: defaultRelay })
    .applyAction(input("BAN"));
  assert.deepEqual(b.sent, []);
  if (result.ok) assert.equal(result.value.enforcement, "CONFIRMED");
});

test("MUTE relays a guild mute with the same duration", async () => {
  const b = bus();
  await build({ gameCommands: b.bus, igns: linked, relaySync: defaultRelay })
    .applyAction(input("MUTE", { durationSeconds: 3600 }));
  assert.equal(b.sent.length, 1);
  assert.match(b.sent[0]!, /^\/g mute TargetIGN /);
});

test("UNMUTE relays a guild unmute", async () => {
  const b = bus();
  await build({ gameCommands: b.bus, igns: linked, relaySync: defaultRelay })
    .applyAction(input("UNMUTE"));
  assert.deepEqual(b.sent, ["/g unmute TargetIGN"]);
});

test("WARN needs no enforcement and is not marked as needing it", async () => {
  const result = await build().applyAction(input("WARN"));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.enforcement, "NOT_REQUIRED");
});

test("automod can punish, because it is a system actor and not an unranked member", async () => {
  // `automod` has no member row, so the rank resolver answers null. Before the
  // system-actor exemption that meant TARGET_OUTRANKS_ACTOR, and every automatic
  // punishment the bot has ever tried to issue was refused.
  const r = repo();
  const result = await build({ repoImpl: r.repo, ranks: ranks({ target: "MEMBER" }) })
    .applyAction(input("MUTE", { actorDiscordId: "automod", durationSeconds: 600 }));
  assert.equal(result.ok, true);
  assert.deepEqual(r.created.map((a) => a.type), ["MUTE"]);
});

test("a real staffer with no member row is still refused", async () => {
  // The exemption is a named list, not "anybody we cannot resolve".
  const result = await build({ ranks: ranks({ target: "MEMBER" }) })
    .applyAction(input("MUTE", { durationSeconds: 600 }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "TARGET_OUTRANKS_ACTOR");
});

// -- Expiry reversal ----------------------------------------------------------

function expiredRepo(rows: ModerationActionDTO[]) {
  const base = repo();
  let swept = 0;
  return {
    created: base.created,
    enforced: base.enforced,
    sweeps: () => swept,
    repo: {
      ...base.repo,
      async listExpiredActive() { return rows; },
      async deactivateExpired() { swept += 1; return rows.length; },
    } as ModerationRepository,
  };
}

function expired(over: Partial<ModerationActionDTO>): ModerationActionDTO {
  return {
    id: "old-1", guildId: "g1", type: "BAN", actorDiscordId: "actor", targetDiscordId: "target",
    reason: "because", durationSeconds: 3600, expiresAt: "2026-08-05T23:00:00.000Z",
    surfaces: ["DISCORD", "GUILD_CHAT"], active: true, createdAt: "2026-08-05T22:00:00.000Z",
    enforcement: "CONFIRMED", enforcementDetail: null,
    ...over,
  } as ModerationActionDTO;
}

test("an expired ban is actually lifted, on both surfaces", async () => {
  // A Discord ban does not expire on its own. The old job cleared the `active`
  // flag and nothing else, which turned every temp ban into a permanent one.
  const r = expiredRepo([expired({})]);
  const b = bus();
  const lifted: ModActionType[] = [];
  const discord: DiscordEnforcer = { async enforce(a) { lifted.push(a.type); return { ok: true }; } };

  const result = await build({
    repoImpl: r.repo, discord, gameCommands: b.bus, igns: linked, relaySync: defaultRelay,
  }).reverseExpired();

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value, 1);
  assert.deepEqual(r.created.map((a) => a.type), ["UNBAN"]);
  assert.deepEqual(lifted, ["UNBAN"]);
  assert.equal(r.sweeps(), 1); // the flag is still cleared afterwards
});

test("an expired mute is reversed as an UNMUTE and relayed to guild chat", async () => {
  const r = expiredRepo([expired({ type: "MUTE" })]);
  const b = bus();
  await build({ repoImpl: r.repo, gameCommands: b.bus, igns: linked, relaySync: defaultRelay })
    .reverseExpired();
  assert.deepEqual(r.created.map((a) => a.type), ["UNMUTE"]);
  assert.deepEqual(b.sent, ["/g unmute TargetIGN"]);
});

test("a reversal that cannot be enforced still clears the flag, and is marked FAILED", async () => {
  // Leaving the row flagged active would make the audit log wrong in the other
  // direction - the punishment *has* expired. The FAILED enforcement is what
  // carries the alarm.
  const r = expiredRepo([expired({})]);
  const a = alerts();
  const discord: DiscordEnforcer = { async enforce() { return { ok: false, reason: "unknown ban" }; } };
  await build({ repoImpl: r.repo, discord, staffAlerts: a.sink }).reverseExpired();
  assert.deepEqual(r.enforced.map((w) => w.status), ["FAILED"]);
  assert.equal(r.sweeps(), 1);
  assert.equal(a.posted.length, 1);
});

test("a guild command Hypixel refused is FAILED and quotes the refusal", async () => {
  // The failure this whole surface exists for: the bridge typed the line, so
  // every older signal said success, and Hypixel threw it away.
  const r = repo();
  const a = alerts();
  const b = bus("REFUSED_INGAME");
  const result = await build({
    repoImpl: r.repo, gameCommands: b.bus, igns: linked, relaySync: defaultRelay, staffAlerts: a.sink,
  }).applyAction(input("BAN"));

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.enforcement, "FAILED");
  assert.equal(a.posted.length, 1);
});

test("a guild command nothing answered for stays PENDING rather than claiming either way", async () => {
  // Neither a success to record nor a failure to wake staff for. The sweep
  // escalates it if the guild never gets round to answering.
  const r = repo();
  const a = alerts();
  const b = bus("TIMED_OUT");
  const result = await build({
    repoImpl: r.repo, gameCommands: b.bus, igns: linked, relaySync: defaultRelay, staffAlerts: a.sink,
  }).applyAction(input("BAN"));

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.enforcement, "PENDING");
    assert.match(result.value.enforcementDetail ?? "", /not confirmed in game/);
  }
  // Deliberately quiet: a busy outbound queue must not page anybody.
  assert.deepEqual(a.posted, []);
});

test("a punishment the guild never answered for is escalated, not left pending", async () => {
  // The backstop. PENDING is honest for fifteen seconds and a lie after ten
  // minutes: by then nothing is coming, and a case still reading "pending" is a
  // ban nobody has been told did not land.
  const stalled = {
    id: "act-9", caseCode: "CASE-target-a1b2c3d4-9", guildId: "g1", type: "BAN", actorDiscordId: "staff-1", targetDiscordId: "target-1",
    reason: "Ban evasion", durationSeconds: null, expiresAt: null, surfaces: ["DISCORD"], active: true,
    enforcement: "PENDING", enforcementDetail: "sent but not confirmed", createdAt: "t",
    updatedAt: null, editedByDiscordId: null, voidedAt: null, voidReason: null,
  } as ModerationActionDTO;
  const r = repo([stalled]);
  const a = alerts();
  const out = await build({ repoImpl: r.repo, staffAlerts: a.sink }).settleStalePending();

  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.value, 1);
  assert.deepEqual(r.enforced, [{
    actionId: "act-9",
    status: "FAILED",
    detail: "the guild never confirmed the command; it was still pending when the sweep ran",
  }]);
  assert.equal(a.posted.length, 1);
  assert.match(a.posted[0]!.text, /act-9/);
});

test("nothing stale means nothing said", async () => {
  const r = repo();
  const a = alerts();
  const out = await build({ repoImpl: r.repo, staffAlerts: a.sink }).settleStalePending();
  assert.equal(out.ok && out.value, 0);
  assert.deepEqual(r.enforced, []);
  assert.deepEqual(a.posted, []);
});


/**
 * The in-game kick mirror.
 *
 * These are the tests for the gap the audit log carried as open decision #2:
 * a member kicked from the Hypixel guild kept their Discord account, because
 * the bridge wrote the row and stopped. The row is not the point — the kick is.
 */
function external(over: Record<string, unknown> = {}) {
  return {
    guildId: "g1",
    type: "KICK" as const,
    targetDiscordId: "target",
    targetIgn: "TargetIGN",
    actorDiscordId: "ingame",
    actorIgn: "OfficerIGN",
    reason: "In-game kick of TargetIGN by OfficerIGN",
    durationSeconds: null,
    ...over,
  };
}

test("an in-game kick reaches Discord instead of stopping at the row", async () => {
  const seen: ModerationActionDTO[] = [];
  const discord: DiscordEnforcer = { async enforce(a) { seen.push(a); return { ok: true }; } };
  const r = repo();
  const out = await build({ repoImpl: r.repo, discord }).recordExternalAction(external());

  assert.equal(out.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.targetDiscordId, "target");
  assert.equal(r.created[0]?.sourceContext, "INGAME");
  assert.deepEqual(r.created[0]?.surfaces, ["GUILD_CHAT", "DISCORD"]);
  // Not held by the platform: nothing to expire, nothing for the sweep to own.
  assert.equal(r.created[0]?.active, false);
  assert.deepEqual(r.enforced, [{ actionId: "act-1", status: "CONFIRMED", detail: null }]);
  assert.equal(out.ok && out.value.enforcement, "CONFIRMED");
});

test("recording an in-game kick never relays it back into the game", async () => {
  // The reason the bypass existed. Issuing the notice as an instruction would
  // type `/g kick` at the guild that just told us it kicked them.
  const b = bus();
  const out = await build({
    discord: enforcerOk, gameCommands: b.bus, igns: linked, relaySync: defaultRelay,
  }).recordExternalAction(external());

  assert.equal(out.ok, true);
  assert.deepEqual(b.sent, []);
});

test("an in-game kick of an unlinked member is recorded, not enforced, and said out loud", async () => {
  const seen: ModerationActionDTO[] = [];
  const discord: DiscordEnforcer = { async enforce(a) { seen.push(a); return { ok: true }; } };
  const r = repo();
  const a = alerts();
  const out = await build({ repoImpl: r.repo, discord, staffAlerts: a.sink })
    .recordExternalAction(external({ targetDiscordId: null }));

  assert.equal(out.ok, true);
  assert.deepEqual(seen, []);
  assert.deepEqual(r.created[0]?.surfaces, ["GUILD_CHAT"]);
  assert.equal(r.enforced[0]?.status, "NOT_REQUIRED");
  assert.match(r.enforced[0]?.detail ?? "", /no linked Discord account/);
  // The gap staff have to close by hand is the one they most need telling about.
  assert.equal(a.posted.length, 1);
  assert.match(a.posted[0]?.text ?? "", /TargetIGN/);
});

test("an in-game kick of a staff member is not mirrored", async () => {
  // Far more likely a mistake or a compromised account than a decision to strip
  // an officer of their Discord access, and nothing here is waiting to undo it.
  const seen: ModerationActionDTO[] = [];
  const discord: DiscordEnforcer = { async enforce(a) { seen.push(a); return { ok: true }; } };
  const r = repo();
  const a = alerts();
  await build({
    repoImpl: r.repo, discord, staffAlerts: a.sink, ranks: ranks({ target: "OFFICER" }),
  }).recordExternalAction(external());

  assert.deepEqual(seen, []);
  assert.equal(r.enforced[0]?.status, "NOT_REQUIRED");
  assert.match(r.enforced[0]?.detail ?? "", /staff role/);
  assert.equal(a.posted.length, 1);
});

test("an in-game mute is history, not a Discord punishment", async () => {
  // Hypixel holds it and Hypixel lifts it. Timing somebody out of Discord for a
  // Minecraft guild mute is a punishment nobody asked for.
  const seen: ModerationActionDTO[] = [];
  const discord: DiscordEnforcer = { async enforce(a) { seen.push(a); return { ok: true }; } };
  const r = repo();
  await build({ repoImpl: r.repo, discord })
    .recordExternalAction(external({ type: "MUTE", durationSeconds: 3_600 }));

  assert.deepEqual(seen, []);
  assert.deepEqual(r.created[0]?.surfaces, ["GUILD_CHAT"]);
  assert.equal(r.created[0]?.expiresAt, "2026-08-06T01:00:00.000Z");
  assert.equal(r.enforced[0]?.status, "NOT_REQUIRED");
});

test("a mirror Discord refuses is a FAILED case and a staff alert", async () => {
  // The invariant: never a log that says kicked while the member is still here
  // and nobody has been told.
  const discord: DiscordEnforcer = { async enforce() { return { ok: false, reason: "missing permission" }; } };
  const r = repo();
  const a = alerts();
  const out = await build({ repoImpl: r.repo, discord, staffAlerts: a.sink })
    .recordExternalAction(external());

  assert.equal(out.ok && out.value.enforcement, "FAILED");
  assert.deepEqual(r.enforced, [{ actionId: "act-1", status: "FAILED", detail: "missing permission" }]);
  assert.match(a.posted[0]?.text ?? "", /Enforcement failed/);
});


test("a punishment marks the target's roles stale straight away", async () => {
  // Otherwise a banned member's auto-roles wait for the reconciler's next full
  // sweep - the punishment lands on one surface now and another whenever.
  const marked: { guildId: string; ids: readonly string[] }[] = [];
  const svc = new ModerationServiceImpl({
    repo: repo().repo,
    ranks: ranks({ actor: "OFFICER", target: "MEMBER" }),
    enforcement: enforcement().mirror,
    discord: enforcerOk,
    rolesDirty: { async mark(guildId, ids) { marked.push({ guildId, ids }); } },
    botCaps: allowAll,
    logger: silent,
    now: () => new Date("2026-08-06T00:00:00.000Z"),
  });

  await svc.applyAction(input("BAN"));
  assert.deepEqual(marked, [{ guildId: "g1", ids: ["target"] }]);
});

test("a marker that throws does not fail the punishment", async () => {
  // A promptness hint, not a step. The daily sweep is what makes it correct.
  const svc = new ModerationServiceImpl({
    repo: repo().repo,
    ranks: ranks({ actor: "OFFICER", target: "MEMBER" }),
    enforcement: enforcement().mirror,
    discord: enforcerOk,
    rolesDirty: { async mark() { throw new Error("redis is down"); } },
    botCaps: allowAll,
    logger: silent,
    now: () => new Date("2026-08-06T00:00:00.000Z"),
  });

  const out = await svc.applyAction(input("BAN"));
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.value.enforcement, "CONFIRMED");
});

// ── correcting a case after the fact ────────────────────────────────────────

/**
 * A store holding exactly one case, which records the patches it is asked for.
 *
 * Deliberately applies them, rather than returning a canned row: half of what
 * these methods do is decide *what* to write, and a fake that ignored the patch
 * would let every one of those decisions pass untested.
 */
function caseRepo(seed: ModerationActionDTO): {
  repo: ModerationRepository;
  patches: Record<string, unknown>[];
  created: NewActionRecord[];
  row: () => ModerationActionDTO;
} {
  let row = seed;
  const patches: Record<string, unknown>[] = [];
  const inner = repo();
  return {
    patches,
    created: inner.created,
    row: () => row,
    repo: {
      ...inner.repo,
      async findAction(guildId, actionId) {
        return guildId === row.guildId && actionId === row.id ? row : null;
      },
      async updateAction(guildId, actionId, patch) {
        if (guildId !== row.guildId || actionId !== row.id) return null;
        patches.push({ ...patch });
        row = { ...row, ...(patch as Partial<ModerationActionDTO>) };
        return row;
      },
    },
  };
}

function seededCase(over: Partial<ModerationActionDTO> = {}): ModerationActionDTO {
  return {
    id: "act-1", caseCode: "CASE-target-a1b2c3d4-1", guildId: "g1", type: "MUTE", actorDiscordId: "actor", targetDiscordId: "target",
    reason: "spam", durationSeconds: 7200, expiresAt: "2026-08-05T21:00:00.000Z",
    surfaces: ["DISCORD"], active: true, createdAt: "2026-08-05T19:00:00.000Z",
    enforcement: "CONFIRMED", enforcementDetail: null,
    updatedAt: null, editedByDiscordId: null, voidedAt: null, voidReason: null,
    ...over,
  };
}

test("a case id from another guild reads as no such case, not as a write", async () => {
  const c = caseRepo(seededCase());
  const svc = build({ repoImpl: c.repo });

  for (const out of [
    await svc.updateAction({ guildId: "g2", actionId: "act-1", editorDiscordId: "boss", reason: "x" }),
    await svc.setEnforcementManually("g2", "act-1", "boss", "CONFIRMED", "did it"),
    await svc.retryEnforcement("g2", "act-1", "boss"),
    await svc.voidAction("g2", "act-1", "boss", "wrong person"),
  ]) {
    assert.equal(out.ok, false);
    assert.equal(!out.ok && out.error.kind, "NO_SUCH_CASE");
  }
  assert.deepEqual(c.patches, [], "nothing was written for a guild that does not own the case");
});

test("shortening a mute re-times it from when it started, not from now", async () => {
  // Recomputing from the moment of the edit would make every correction quietly
  // extend the sentence: a two-hour mute cut to one hour would end an hour from
  // the edit rather than an hour after it began.
  const c = caseRepo(seededCase());
  const e = enforcement();
  const svc = build({ repoImpl: c.repo, mirror: e.mirror });

  const out = await svc.updateAction({
    guildId: "g1", actionId: "act-1", editorDiscordId: "boss", durationSeconds: 3600,
  });
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.value.expiresAt, "2026-08-05T20:00:00.000Z");
  assert.equal(c.patches[0]?.editedByDiscordId, "boss");
  // The mirror carries the TTL the bridge enforces. An edit that never reached
  // it would be true on the page and false in the world.
  assert.equal(e.applied.at(-1)?.expiresAt, "2026-08-05T20:00:00.000Z");
});

test("editing only the reason leaves the clock alone", async () => {
  const c = caseRepo(seededCase());
  const svc = build({ repoImpl: c.repo });

  const out = await svc.updateAction({
    guildId: "g1", actionId: "act-1", editorDiscordId: "boss", reason: "spam, repeatedly",
  });
  assert.equal(out.ok && out.value.reason, "spam, repeatedly");
  assert.equal(out.ok && out.value.expiresAt, "2026-08-05T21:00:00.000Z");
  assert.ok(!("expiresAt" in (c.patches[0] ?? {})), "a sparse patch must not touch what it was not given");
});

test("an enforcement set by hand carries who set it", async () => {
  // The queue of FAILED rows is only useful if the person who cleared the
  // failure can clear the row, and "CONFIRMED" with no author beside it reads
  // as the platform having confirmed something it never did.
  const c = caseRepo(seededCase({ enforcement: "FAILED", enforcementDetail: "Discord refused" }));
  const svc = build({ repoImpl: c.repo });

  const out = await svc.setEnforcementManually("g1", "act-1", "boss", "CONFIRMED", "banned by hand");
  assert.equal(out.ok && out.value.enforcement, "CONFIRMED");
  assert.match(String(out.ok && out.value.enforcementDetail), /banned by hand/);
  assert.match(String(out.ok && out.value.enforcementDetail), /boss/);
});

test("voiding an active ban actually unbans them", async () => {
  // The invariant, in its last form: a case reading "voided" beside somebody
  // who is still banned is the same lie as one reading "banned" beside somebody
  // who is still here.
  const c = caseRepo(seededCase({ type: "BAN", durationSeconds: null, expiresAt: null }));
  const svc = build({ repoImpl: c.repo, ranks: ranks({ boss: "ADMIN", target: "MEMBER" }) });

  const out = await svc.voidAction("g1", "act-1", "boss", "wrong person");
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.value.voidedAt, "2026-08-06T00:00:00.000Z");
  assert.equal(out.ok && out.value.active, false, "a voided punishment stops being enforced");

  // Issued as a real punishment reversal, not a column flipped in the database:
  // it goes through the same enforcer, gets its own verdict and its own card.
  assert.equal(c.created.length, 1);
  assert.equal(c.created[0]?.type, "UNBAN");
  assert.equal(c.created[0]?.targetDiscordId, "target");
  assert.match(String(c.created[0]?.reason), /^Case CASE-target-a1b2c3d4-1 voided: wrong person$/);
});

test("voiding a warning corrects the record without inventing a reversal", async () => {
  // Nothing to undo. A warning holds no enforcement, so a void is a statement
  // about the record and only that.
  const c = caseRepo(seededCase({ type: "WARN", durationSeconds: null, expiresAt: null, active: false }));
  const svc = build({ repoImpl: c.repo });

  const out = await svc.voidAction("g1", "act-1", "boss", "issued in error");
  assert.equal(out.ok && out.value.voidReason, "issued in error");
  assert.deepEqual(c.created, [], "nothing to undo, so nothing was issued");
});

test("a case is voided once, not repeatedly", async () => {
  const c = caseRepo(seededCase({ type: "WARN", active: false, voidedAt: "2026-08-05T22:00:00.000Z" }));
  const svc = build({ repoImpl: c.repo });

  const out = await svc.voidAction("g1", "act-1", "boss", "again");
  assert.equal(!out.ok && out.error.kind, "ALREADY_VOID");
});

test("retrying a failed case runs the real enforcement path and restamps it", async () => {
  const c = caseRepo(seededCase({ type: "BAN", enforcement: "FAILED", enforcementDetail: "Discord refused" }));
  const seen: ModerationActionDTO[] = [];
  const svc = build({
    repoImpl: c.repo,
    discord: { async enforce(a) { seen.push(a); return { ok: true }; } },
  });

  const out = await svc.retryEnforcement("g1", "act-1", "boss");
  assert.equal(out.ok, true);
  assert.equal(seen.length, 1, "the retry went to the same enforcer the first attempt used");
  assert.equal(seen[0]?.id, "act-1");
  assert.equal(c.patches.at(-1)?.editedByDiscordId, "boss");
});


// -----------------------------------------------------------------------------
// Punishments placed by hand in Discord.
//
// The mirror of the in-game path above, pointing the other way. Staff
// right-click and ban; before this existed the platform recorded nothing, so
// the case list, `/audit` and the mod-log all disagreed with the server they
// claim to describe — and the guild-chat half never ran, leaving the member
// playing in a Minecraft guild they had just been thrown out of the Discord for.
// -----------------------------------------------------------------------------

function modLogSink(): { sink: ModLogSink; posted: { guildId: string; title?: string }[] } {
  const posted: { guildId: string; title?: string }[] = [];
  return {
    posted,
    sink: {
      async post(guildId, embed) {
        posted.push({ guildId, ...(embed.title === undefined ? {} : { title: embed.title }) });
      },
    },
  };
}

function fromDiscord(over: Record<string, unknown> = {}) {
  return {
    guildId: "g1",
    type: "BAN" as const,
    targetDiscordId: "target",
    actorDiscordId: "actor",
    reason: "Banned in Discord",
    ...over,
  };
}

test("a ban placed in Discord is written as a case from that surface", async () => {
  const r = repo();
  const out = await build({ repoImpl: r.repo }).recordDiscordAction(fromDiscord());

  assert.equal(out.ok, true);
  assert.equal(r.created[0]?.sourceContext, "DISCORD");
  assert.equal(r.created[0]?.actorDiscordId, "actor");
  assert.equal(r.created[0]?.active, true);
  // Discord's ban list has no expiry and the audit log carries none, so the
  // sweep is given nothing to act on rather than a guessed duration.
  assert.equal(r.created[0]?.durationSeconds, null);
  assert.equal(r.created[0]?.expiresAt, null);
});

test("an adopted ban is not banned all over again", async () => {
  // It has already happened on that surface. Re-issuing it would be a
  // privileged write on no evidence, and for a KICK the member is already gone,
  // so the retry answers "unknown member" and only reads as success because we
  // chose to read it that way.
  const seen: ModActionType[] = [];
  const discord: DiscordEnforcer = {
    async enforce(a) { seen.push(a.type); return { ok: true }; },
  };
  const out = await build({ discord }).recordDiscordAction(fromDiscord());

  assert.equal(out.ok, true);
  assert.deepEqual(seen, []);
  assert.equal(out.ok && out.value.enforcement, "CONFIRMED");
});

test("a ban placed in Discord still reaches guild chat", async () => {
  // The half that costs something. The Discord leg is done; the Minecraft one
  // is exactly what nobody did, and is the reason this path exists at all.
  const b = bus();
  const out = await build({ gameCommands: b.bus, igns: linked, relaySync: defaultRelay })
    .recordDiscordAction(fromDiscord({ reason: "spam" }));

  assert.equal(out.ok, true);
  assert.deepEqual(b.sent, ["/g kick TargetIGN spam"]);
  assert.equal(out.ok && out.value.enforcement, "CONFIRMED");
});

test("an adopted action posts its mod-log card like any other", async () => {
  // The whole point of adopting it: one log that agrees with the server.
  const m = modLogSink();
  await build({ modLog: m.sink }).recordDiscordAction(fromDiscord());
  assert.equal(m.posted.length, 1);
  assert.equal(m.posted[0]?.guildId, "g1");
});

test("an adopted unban is a reversal, not something the sweep now owns", async () => {
  const r = repo();
  const out = await build({ repoImpl: r.repo })
    .recordDiscordAction(fromDiscord({ type: "UNBAN", reason: "Unbanned in Discord" }));

  assert.equal(out.ok, true);
  assert.equal(r.created[0]?.active, false);
});

test("a ban whose actor Discord would not name is recorded anyway", async () => {
  // Without View Audit Log there is nobody to credit. The ban still happened,
  // and a case that says so with an unknown actor beats no case at all.
  const r = repo();
  const out = await build({ repoImpl: r.repo })
    .recordDiscordAction(fromDiscord({ actorDiscordId: DISCORD_ACTOR }));

  assert.equal(out.ok, true);
  assert.equal(r.created[0]?.actorDiscordId, DISCORD_ACTOR);
});
