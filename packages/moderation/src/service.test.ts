import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemberRole, ModActionType, ModerationActionDTO } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { ModerationServiceImpl } from "./service.js";
import type { BotCapabilities, EnforcementMirror, ModerationRepository, NewActionRecord, RankResolver } from "./ports.js";

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
} = {}) {
  return new ModerationServiceImpl({
    repo: over.repoImpl ?? repo().repo,
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
