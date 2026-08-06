import assert from "node:assert/strict";
import { test } from "node:test";
import { ok, type CommunityService, type MemberRole, type ModerationService } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { authorize, type PanelSession, type RoleResolver } from "./access.js";
import { PanelService } from "./service.js";

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
  return {
    async listMembers() { return ok(arr(counts.members) as never); },
    async listUpcomingEvents() { return ok(arr(counts.events) as never); },
    async listApplications() { return ok(arr(counts.apps) as never); },
  };
}

const moderation = (n: number): ModerationService => ({
  async recordInfraction(i) { return ok({ ...i, id: "x", createdAt: "t" }); },
  async applyAction() { throw new Error("unused"); },
  async listInfractions() {
    return ok(
      Array.from({ length: n }, (_v, i) => ({
        id: `i${i}`, guildId: "g1", targetDiscordId: "t", type: "SPAM" as const,
        severity: "LOW" as const, reason: "x", createdAt: "t",
      })),
    );
  },
});

function svc(over: { roles?: RoleResolver; community?: CommunityService; moderation?: ModerationService } = {}) {
  return new PanelService({
    roles: over.roles ?? roles({ "111": "OFFICER" }),
    community: over.community ?? community({ members: 3, events: 1, apps: 2 }),
    moderation: over.moderation ?? moderation(0),
    logger: silent,
  });
}

test("loadOverview denies and returns null data for a MEMBER", async () => {
  const r = await svc({ roles: roles({ "111": "MEMBER" }) }).loadOverview(session(), "g1");
  assert.equal(r.access.allowed, false);
  assert.equal(r.data, null);
});

test("loadOverview returns counts when authorized", async () => {
  const r = await svc().loadOverview(session(), "g1");
  assert.equal(r.access.allowed, true);
  assert.deepEqual(r.data, { memberCount: 3, upcomingEventCount: 1, openApplicationCount: 2 });
});

test("loadModeration returns the infraction view when authorized", async () => {
  const r = await svc({ moderation: moderation(2) }).loadModeration(session(), "g1", "target");
  assert.equal(r.access.allowed, true);
  assert.equal(r.data?.infractionCount, 2);
  assert.equal(r.data?.target, "target");
});
