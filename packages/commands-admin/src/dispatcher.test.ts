import assert from "node:assert/strict";
import { test } from "node:test";
import {
  err,
  ok,
  type ApplyActionInput,
  type MemberRole,
  type ModerationActionDTO,
  type ModerationError,
  type ModerationService,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { AdminDispatcher } from "./dispatcher.js";
import { buildAdminRegistry } from "./handlers.js";
import { parseDurationSeconds } from "./util.js";
import type { AdminContext, RoleResolver } from "./types.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

function action(over: Partial<ModerationActionDTO> = {}): ModerationActionDTO {
  return {
    id: "act-1",
    guildId: "g1",
    type: "WARN",
    actorDiscordId: "actor",
    targetDiscordId: "target",
    reason: "x",
    durationSeconds: null,
    expiresAt: null,
    surfaces: ["DISCORD"],
    active: true,
    createdAt: "t",
    ...over,
  };
}

function moderation(over: Partial<ModerationService> = {}): ModerationService {
  return {
    async recordInfraction(i) { return ok({ ...i, id: "inf", createdAt: "t" }); },
    async applyAction() { return ok(action()); },
    async listInfractions() { return ok([]); },
    ...over,
  };
}

const roles = (map: Record<string, MemberRole>): RoleResolver => ({
  async getRole(_g, id) { return map[id] ?? "MEMBER"; },
});

function make(over: { moderation?: ModerationService; roles?: RoleResolver } = {}) {
  return new AdminDispatcher({
    registry: buildAdminRegistry(),
    roles: over.roles ?? roles({ actor: "OFFICER" }),
    handlerDeps: { moderation: over.moderation ?? moderation(), logger: silent },
    logger: silent,
  });
}

const ctx = (over: Partial<AdminContext> = {}): AdminContext => ({
  guildId: "g1",
  actorId: "actor",
  args: { target: "target" },
  ...over,
});

test("parseDurationSeconds handles s/m/h/d", () => {
  assert.equal(parseDurationSeconds("45s"), 45);
  assert.equal(parseDurationSeconds("30m"), 1800);
  assert.equal(parseDurationSeconds("1h"), 3600);
  assert.equal(parseDurationSeconds("2d"), 172_800);
  assert.equal(parseDurationSeconds("garbage"), undefined);
});

test("unknown command replies", async () => {
  const r = await make().dispatch("nuke", ctx());
  assert.match(r.text, /Unknown command/);
});

test("warn denied for a MEMBER-tier actor", async () => {
  const r = await make({ roles: roles({ actor: "MEMBER" }) }).dispatch("warn", ctx());
  assert.match(r.text, /requires MODERATOR/);
});

test("warn succeeds for a MODERATOR and reports the case id", async () => {
  const r = await make({ roles: roles({ actor: "MODERATOR" }) }).dispatch("warn", ctx());
  assert.match(r.text, /Warned/);
  assert.match(r.text, /act-1/);
});

test("mute renders the cross-surface sweep and expiry", async () => {
  const mod = moderation({
    async applyAction(input: ApplyActionInput) {
      assert.equal(input.type, "MUTE");
      assert.equal(input.durationSeconds, 3600);
      return ok(action({ type: "MUTE", surfaces: ["DISCORD", "GUILD_CHAT"], expiresAt: "2026-08-06T01:00:00Z" }));
    },
  });
  const r = await make({ moderation: mod }).dispatch("mute", ctx({ args: { target: "target", duration: "1h" } }));
  assert.match(r.text, /DISCORD \+ GUILD_CHAT/);
});

test("mute without duration surfaces DURATION_REQUIRED from the service", async () => {
  const mod = moderation({ async applyAction() { return err<ModerationError>({ kind: "DURATION_REQUIRED" }); } });
  const r = await make({ moderation: mod }).dispatch("mute", ctx());
  assert.match(r.text, /duration is required/i);
});

test("target-outranks error is rendered", async () => {
  const mod = moderation({ async applyAction() { return err<ModerationError>({ kind: "TARGET_OUTRANKS_ACTOR" }); } });
  const r = await make({ moderation: mod }).dispatch("warn", ctx());
  assert.match(r.text, /equal or higher rank/);
});

test("ban requires confirmation before executing", async () => {
  let called = false;
  const mod = moderation({ async applyAction() { called = true; return ok(action({ type: "BAN" })); } });
  const prompt = await make({ moderation: mod }).dispatch("ban", ctx());
  assert.match(prompt.text, /destructive/);
  assert.equal(called, false);

  const done = await make({ moderation: mod }).dispatch("ban", ctx({ args: { target: "target", confirm: "true" } }));
  assert.match(done.text, /Banned/);
  assert.equal(called, true);
});

test("infractions reports the count", async () => {
  const mod = moderation({
    async listInfractions() {
      return ok([
        { id: "i1", guildId: "g1", targetDiscordId: "target", type: "SPAM", severity: "LOW", reason: "x", createdAt: "t" },
      ]);
    },
  });
  const r = await make({ moderation: mod }).dispatch("infractions", ctx());
  assert.match(r.text, /1 infraction/);
});
