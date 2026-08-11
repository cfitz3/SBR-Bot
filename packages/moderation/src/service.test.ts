import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditQuery, MemberRole, ModActionType, ModerationActionDTO } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { ModerationServiceImpl } from "./service.js";
import type {
  BotCapabilities,
  EnforcementMirror,
  EscalationPolicySource,
  ModerationRepository,
  NewActionRecord,
  RankResolver,
} from "./ports.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

function repo(): { repo: ModerationRepository; created: NewActionRecord[] } {
  const created: NewActionRecord[] = [];
  return {
    created,
    repo: {
      async createInfraction(input) { return { ...input, id: "inf-1", createdAt: "t" }; },
      async createAction(input) {
        created.push(input);
        return { ...input, id: "act-1", createdAt: "t" } as ModerationActionDTO;
      },
      async listInfractions() { return []; },
      async listActions() { return []; },
      async deactivateExpired() { return 0; },
    },
  };
}

function ranks(map: Record<string, MemberRole>): RankResolver {
  return { async getRole(_g, id) { return map[id] ?? "MEMBER"; } };
}

function enforcement(): { mirror: EnforcementMirror; applied: ModerationActionDTO[] } {
  const applied: ModerationActionDTO[] = [];
  return { applied, mirror: { async apply(a) { applied.push(a); } } };
}

const allowAll: BotCapabilities = { async canPerform() { return true; } };

function build(over: {
  repoImpl?: ModerationRepository;
  ranks?: RankResolver;
  botCaps?: BotCapabilities;
  mirror?: EnforcementMirror;
  escalation?: EscalationPolicySource;
} = {}) {
  return new ModerationServiceImpl({
    repo: over.repoImpl ?? repo().repo,
    ...(over.escalation ? { escalation: over.escalation } : {}),
    // Default: actor outranks target so punitive actions reach the later guards.
    ranks: over.ranks ?? ranks({ actor: "OFFICER", target: "MEMBER" }),
    enforcement: over.mirror ?? enforcement().mirror,
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
  }));
  return {
    created: base.created,
    repo: { ...base.repo, async createAction(i) { base.created.push(i); return { ...i, id: "act", createdAt: "t" } as ModerationActionDTO; }, async listActions() { return history; } },
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
