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
import type {
  BotCapabilities,
  DiscordEnforcer,
  EnforcementMirror,
  GameCommandBus,
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

function repo(): { repo: ModerationRepository; created: NewActionRecord[]; enforced: EnforcementWrite[] } {
  const created: NewActionRecord[] = [];
  const enforced: EnforcementWrite[] = [];
  return {
    created,
    enforced,
    repo: {
      async createInfraction(input) { return { ...input, id: "inf-1", createdAt: "t" }; },
      async createAction(input) {
        created.push(input);
        return { ...input, id: "act-1", createdAt: "t", enforcement: "PENDING", enforcementDetail: null } as ModerationActionDTO;
      },
      async listInfractions() { return []; },
      async listRecentInfractions() { return []; },
      async listActions() { return []; },
      async deactivateExpired() { return 0; },
      async setEnforcement(actionId, status, detail) { enforced.push({ actionId, status, detail }); },
      async listExpiredActive() { return []; },
      async findAction() { return null; },
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
    id: "a1", guildId: "g1", type: "MUTE", actorDiscordId: "actor", targetDiscordId: "target",
    reason: "spam", durationSeconds: 60, expiresAt: "2026-08-05T23:59:00.000Z",
    surfaces: ["DISCORD"], active: true, createdAt: "2026-08-05T23:58:00.000Z",
    enforcement: "CONFIRMED", enforcementDetail: null,
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
    id: `w${i}`, guildId: "g1", type: "WARN", actorDiscordId: "actor", targetDiscordId: "target",
    reason: "spam", durationSeconds: null, expiresAt: null, surfaces: ["DISCORD"],
    active: true, createdAt: "2026-08-05T00:00:00.000Z",
    enforcement: "NOT_REQUIRED", enforcementDetail: null,
  }));
  return {
    created: base.created,
    repo: { ...base.repo, async createAction(i) { base.created.push(i); return { ...i, id: "act", createdAt: "t", enforcement: "PENDING", enforcementDetail: null } as ModerationActionDTO; }, async listActions() { return history; } },
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

/** A bus that records what it was asked to run, and whether it claims to be live. */
function bus(live = true): { bus: GameCommandBus; sent: string[] } {
  const sent: string[] = [];
  return { sent, bus: { async send(_g, command) { sent.push(command); return live; } } };
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
  assert.deepEqual(b.sent, ["/g kick TargetIGN"]);
  if (result.ok) assert.equal(result.value.enforcement, "CONFIRMED");
});

test("a ban the bridge cannot run is FAILED, not resolved", async () => {
  // `send` returning false is the offline bridge: Redis accepted the publish and
  // nobody was listening. The case must not read as a completed ban.
  const r = repo();
  const a = alerts();
  const b = bus(false);
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
