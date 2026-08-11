import assert from "node:assert/strict";
import { test } from "node:test";
import {
  err,
  ok,
  recordArgs,
  type AnalyticsService,
  type ApplicationDTO,
  type ApplyActionInput,
  type AuditQuery,
  type CommunityService,
  type FilterTestDTO,
  type GuildConfigService,
  type GuildEffectError,
  type GuildEffects,
  type IdentityService,
  type LinkedIdentityDTO,
  type LockdownStateDTO,
  type MemberRole,
  type MemberSummaryDTO,
  type ModerationActionDTO,
  type ModerationError,
  type ModerationService,
  type RecruitmentSettings,
  type SafetyService,
  type WordlistError,
  type WordlistService,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { AdminDispatcher } from "./dispatcher.js";
import { buildAdminRegistry } from "./handlers.js";
import { parseDurationSeconds } from "./util.js";
import type { AdminContext, RoleResolver } from "./types.js";

// A real Discord snowflake: `getUser` rejects anything that is not one, so the
// fixture has to look like an id rather than the word "target".
const TARGET = "222222222222222222";

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
    async listActions() { return ok([]); },
    async listInForce() { return ok([]); },
    async sweepExpired() { return ok(0); },
    ...over,
  };
}

const roles = (map: Record<string, MemberRole>): RoleResolver => ({
  async getRole(_g, id) { return map[id] ?? "MEMBER"; },
});

/**
 * Deps a given test doesn't exercise. They exist so `AdminHandlerDeps` stays a
 * single concrete shape rather than a per-command union; a test overrides only
 * the service it is actually asserting on.
 */
const link: LinkedIdentityDTO = {
  discordId: TARGET,
  minecraftUuid: "uuid-1",
  ign: "Target",
  status: "VERIFIED",
  primary: true,
  verifiedAt: "t",
};
const identity: IdentityService = {
  async resolveByDiscordId() { return ok(link); },
  async linkByIgn() { return ok(link); },
  async unlink() { return ok(undefined); },
  async hasCapability() { return true; },
};
const member: MemberSummaryDTO = {
  guildId: "g1", discordId: TARGET, ign: "Target", role: "MODERATOR",
  status: "ACTIVE", guildRank: null, joinedAt: null,
};
function community(over: Partial<CommunityService> = {}): CommunityService {
  // Partial by design: admin handlers touch a handful of community methods, and
  // the rest of the contract is covered by packages/community's own tests.
  const partial: Partial<CommunityService> = {
    async listUpcomingEvents() { return ok([]); },
    async listMembers() { return ok([]); },
    async listApplications() { return ok([]); },
    async setMemberRole() { return ok(member); },
    ...over,
  };
  return partial as CommunityService;
}
function guildConfig(over: Partial<GuildConfigService> = {}): GuildConfigService {
  return {
    async get() { return ok(null); },
    async isFeatureEnabled() { return true; },
    async getChannel() { return null; },
    async getSetting() { return null; },
    async setSetting() { return ok(undefined); },
    async setChannel() { return ok(undefined); },
    async setFeature() { return ok(undefined); },
    async setBridgeSuspended() { return ok(undefined); },
    async setRecruitment() { return ok(undefined); },
    async setRoleMapping() { return ok(undefined); },
    ...over,
  };
}
function lockState(over: Partial<LockdownStateDTO> = {}): LockdownStateDTO {
  return {
    guildId: "g1", scope: "SERVER", channelId: null, reason: "raid",
    actorDiscordId: "actor", startedAt: "t", expiresAt: null, ...over,
  };
}
function safety(over: Partial<SafetyService> = {}): SafetyService {
  return {
    async lockdown() { return ok(lockState()); },
    async liftLockdown() { return ok(null); },
    async enableAntiRaid() {
      return ok({ guildId: "g1", sensitivity: "MEDIUM", actorDiscordId: "actor", startedAt: "t", expiresAt: null });
    },
    async disableAntiRaid() {
      return ok({ guildId: "g1", sensitivity: "MEDIUM", actorDiscordId: "actor", startedAt: "t", expiresAt: null });
    },
    async status() { return ok({ lockdown: null, antiRaid: null }); },
    ...over,
  };
}
function wordlist(over: Partial<WordlistService> = {}): WordlistService {
  return {
    async list() { return ok([]); },
    async add(i) {
      return ok({ id: "w1", guildId: i.guildId, pattern: i.pattern, matchType: i.matchType, action: i.action, severity: i.severity ?? 1, enabled: true });
    },
    async remove() { return ok(null); },
    async test(_g, text) {
      return ok<FilterTestDTO>({ text, matched: [], action: "ALLOW", replacement: null });
    },
    ...over,
  };
}
function effects(over: Partial<GuildEffects> = {}): GuildEffects {
  return {
    async kick() { return ok(undefined); },
    async purge() { return ok(0); },
    async setLocked() { return ok(0); },
    ...over,
  };
}
const analytics: AnalyticsService = { async capture() {}, async emit() {} };

interface Overrides {
  moderation?: ModerationService;
  roles?: RoleResolver;
  community?: CommunityService;
  config?: GuildConfigService;
  safety?: SafetyService;
  wordlist?: WordlistService;
  effects?: GuildEffects;
}

function make(over: Overrides = {}) {
  return new AdminDispatcher({
    registry: buildAdminRegistry(),
    roles: over.roles ?? roles({ actor: "OWNER" }),
    handlerDeps: {
      moderation: over.moderation ?? moderation(),
      identity,
      community: over.community ?? community(),
      config: over.config ?? guildConfig(),
      safety: over.safety ?? safety(),
      wordlist: over.wordlist ?? wordlist(),
      effects: over.effects ?? effects(),
      analytics,
      logger: silent,
    },
    logger: silent,
  });
}

const ctx = (over: Partial<AdminContext> = {}): AdminContext => ({
  guildId: "g1",
  actorId: "actor",
  args: recordArgs({ target: TARGET }),
  channelId: "333333333333333333",
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

test("warn tells the staffer when the ladder escalated it", async () => {
  // The escalation is a separate row the service wrote; /warn learns about it
  // by asking what is being enforced now, not from its own return value.
  const mod = moderation({
    async listInForce() {
      return ok([
        action({
          id: "act-2",
          type: "MUTE",
          reason: "Automatic escalation: 3 warnings in 90 days",
          expiresAt: "2026-08-06T01:00:00Z",
        }),
      ]);
    },
  });
  const r = await make({ moderation: mod, roles: roles({ actor: "MODERATOR" }) }).dispatch("warn", ctx());
  assert.match(r.text, /Warned/);
  assert.match(r.text, /Escalated automatically: mute until 2026-08-06T01:00:00Z/);
});

test("warn says nothing about escalation when the live punishment was a staffer's", async () => {
  const mod = moderation({
    async listInForce() { return ok([action({ type: "MUTE", reason: "being a nuisance" })]); },
  });
  const r = await make({ moderation: mod, roles: roles({ actor: "MODERATOR" }) }).dispatch("warn", ctx());
  assert.doesNotMatch(r.text, /Escalated/);
});

test("mute renders the cross-surface sweep and expiry", async () => {
  const mod = moderation({
    async applyAction(input: ApplyActionInput) {
      assert.equal(input.type, "MUTE");
      assert.equal(input.durationSeconds, 3600);
      return ok(action({ type: "MUTE", surfaces: ["DISCORD", "GUILD_CHAT"], expiresAt: "2026-08-06T01:00:00Z" }));
    },
  });
  const r = await make({ moderation: mod }).dispatch("mute", ctx({ args: recordArgs({ target: TARGET, duration: "1h" }) }));
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

  const done = await make({ moderation: mod }).dispatch("ban", ctx({ args: recordArgs({ target: TARGET, confirm: "true" }) }));
  assert.match(done.text, /Banned/);
  assert.equal(called, true);
});

test("every registered command carries a description Discord will accept", () => {
  for (const [name, spec] of buildAdminRegistry()) {
    assert.ok(spec.description.length > 0 && spec.description.length <= 100, `${name} description`);
    assert.match(name, /^[a-z][a-z0-9-]{0,31}$/, `${name} is a legal command name`);
    for (const opt of spec.options ?? []) {
      assert.match(opt.name, /^[a-z_][a-z0-9_]{0,31}$/, `${name}.${opt.name}`);
    }
  }
});

test("kick logs the case even when Discord refuses the removal", async () => {
  let logged = false;
  const mod = moderation({ async applyAction() { logged = true; return ok(action({ type: "KICK" })); } });
  const r = await make({
    moderation: mod,
    effects: effects({ async kick() { return err<GuildEffectError>({ kind: "MISSING_PERMISSION" }); } }),
  }).dispatch("kick", ctx({ args: recordArgs({ target: TARGET, confirm: "true" }) }));

  assert.equal(logged, true, "the audit entry must survive a failed kick");
  assert.match(r.text, /didn't go through/);
});

test("purge refuses a count outside Discord's bulk-delete range", async () => {
  let swept = false;
  const eff = effects({ async purge() { swept = true; return ok(5); } });
  const r = await make({ effects: eff }).dispatch(
    "purge",
    ctx({ args: recordArgs({ count: "500", confirm: "true" }) }),
  );
  assert.match(r.text, /1-100/);
  assert.equal(swept, false);
});

test("purge reports what was actually deleted, not what was asked for", async () => {
  const r = await make({ effects: effects({ async purge() { return ok(7); } }) }).dispatch(
    "purge",
    ctx({ args: recordArgs({ count: "50", confirm: "true" }) }),
  );
  assert.match(r.text, /Deleted 7 message/);
});

test("purge falls back to the channel it was invoked in", async () => {
  let seen: string | null = null;
  const eff = effects({ async purge(input) { seen = input.channelId; return ok(1); } });
  await make({ effects: eff }).dispatch("purge", ctx({ args: recordArgs({ count: "5", confirm: "true" }) }));
  assert.equal(seen, "333333333333333333");
});

test("lockdown warns when no duration was given", async () => {
  const r = await make().dispatch(
    "lockdown",
    ctx({ args: recordArgs({ scope: "server", reason: "raid", confirm: "true" }) }),
  );
  assert.match(r.text, /No expiry set/);
});

test("lockdown reports the auto-lift time when one was set", async () => {
  const svc = safety({
    async lockdown(input) {
      assert.equal(input.durationSeconds, 1800);
      return ok(lockState({ expiresAt: "2026-08-07T12:30:00.000Z" }));
    },
  });
  const r = await make({ safety: svc }).dispatch(
    "lockdown",
    ctx({ args: recordArgs({ scope: "server", duration: "30m", confirm: "true" }) }),
  );
  assert.match(r.text, /Lifts automatically/);
});

test("lifting a lockdown that isn't active says so plainly", async () => {
  const r = await make().dispatch("lockdown-lift", ctx({ args: recordArgs({}) }));
  assert.match(r.text, /Nothing is locked down/);
});

test("antiraid-on defaults to MEDIUM sensitivity", async () => {
  let seen: string | null = null;
  const svc = safety({
    async enableAntiRaid(input) {
      seen = input.sensitivity;
      return ok({ guildId: "g1", sensitivity: input.sensitivity, actorDiscordId: "actor", startedAt: "t", expiresAt: null });
    },
  });
  await make({ safety: svc }).dispatch("antiraid-on", ctx({ args: recordArgs({}) }));
  assert.equal(seen, "MEDIUM");
});

test("wordlist-add reports a duplicate rather than silently succeeding", async () => {
  const wl = wordlist({ async add() { return err<WordlistError>({ kind: "DUPLICATE" }); } });
  const r = await make({ wordlist: wl }).dispatch(
    "wordlist-add",
    ctx({ args: recordArgs({ pattern: "bad" }) }),
  );
  assert.match(r.text, /already exists/);
});

test("wordlist-add explains an unusable pattern", async () => {
  const wl = wordlist({
    async add() { return err<WordlistError>({ kind: "INVALID_PATTERN", detail: "unterminated group" }); },
  });
  const r = await make({ wordlist: wl }).dispatch(
    "wordlist-add",
    ctx({ args: recordArgs({ pattern: "(", match_type: "REGEX" }) }),
  );
  assert.match(r.text, /unterminated group/);
});

test("wordlist-remove says nothing matched instead of claiming success", async () => {
  const r = await make().dispatch("wordlist-remove", ctx({ args: recordArgs({ rule: "ghost" }) }));
  assert.match(r.text, /No rule here matches/);
});

test("filter-test names the verdict when a rule fires", async () => {
  const wl = wordlist({
    async test(_g, text) {
      return ok<FilterTestDTO>({
        text,
        matched: [{ id: "w1", guildId: "g1", pattern: "bad", matchType: "SUBSTRING", action: "BLOCK", severity: 3, enabled: true }],
        action: "BLOCK",
        replacement: null,
      });
    },
  });
  const r = await make({ wordlist: wl }).dispatch("filter-test", ctx({ args: recordArgs({ text: "so bad" }) }));
  assert.match(r.text, /Caught — BLOCK/);
  assert.ok(r.embed);
});

test("wordlist-remove autocompletes over this guild's rules only", async () => {
  const wl = wordlist({
    async list(guildId) {
      assert.equal(guildId, "g1");
      return ok([
        { id: "w1", guildId: "g1", pattern: "scam", matchType: "SUBSTRING", action: "BLOCK", severity: 1, enabled: true },
        { id: "w2", guildId: "g1", pattern: "hello", matchType: "EXACT", action: "FLAG", severity: 1, enabled: true },
      ]);
    },
  });
  const choices = await make({ wordlist: wl }).autocomplete(
    "wordlist-remove",
    { name: "rule", value: "sca" },
    { guildId: "g1", userId: "actor" },
  );
  assert.equal(choices.length, 1);
  assert.equal(choices[0]?.value, "w1");
});

test("set-channel with no channel clears the slot", async () => {
  let cleared = false;
  const cfg = guildConfig({
    async setChannel(_g, slot, channelId) {
      assert.equal(slot, "log");
      cleared = channelId === null;
      return ok(undefined);
    },
  });
  const r = await make({ config: cfg }).dispatch("set-channel", ctx({ args: recordArgs({ slot: "log" }) }));
  assert.equal(cleared, true);
  assert.match(r.text, /cleared/);
});

test("set-recruitment leaves an unnamed threshold alone", async () => {
  let patch: RecruitmentSettings | null = null;
  const cfg = guildConfig({ async setRecruitment(_g, input) { patch = input; return ok(undefined); } });
  await make({ config: cfg }).dispatch("set-recruitment", ctx({ args: recordArgs({ open: "true" }) }));

  assert.ok(patch);
  const written = patch as RecruitmentSettings;
  assert.equal(written.open, true);
  assert.equal("minWeight" in written, false, "an unnamed bar must not be written");
  assert.equal("minNetworth" in written, false);
});

test("set-recruitment clear_requirements explicitly nulls both bars", async () => {
  let patch: RecruitmentSettings | null = null;
  const cfg = guildConfig({ async setRecruitment(_g, input) { patch = input; return ok(undefined); } });
  await make({ config: cfg }).dispatch(
    "set-recruitment",
    ctx({ args: recordArgs({ open: "false", clear_requirements: "true" }) }),
  );
  const written = patch as unknown as RecruitmentSettings;
  assert.equal(written.minWeight, null);
  assert.equal(written.minNetworth, null);
});

test("set-role type:member changes the rank and records it", async () => {
  let recorded: string | null = null;
  const mod = moderation({
    async applyAction(input) { recorded = input.type; return ok(action({ type: "ROLE_CHANGE" })); },
  });
  const r = await make({ moderation: mod }).dispatch(
    "set-role",
    ctx({ args: recordArgs({ target: TARGET, role: "MODERATOR" }) }),
  );
  assert.match(r.text, /is now MODERATOR/);
  assert.equal(recorded, "ROLE_CHANGE");
});

test("set-role type:mapping binds a Discord role instead of touching a member", async () => {
  let mapped: string | null = null;
  const cfg = guildConfig({
    async setRoleMapping(_g, _role, discordRoleId) { mapped = discordRoleId; return ok(undefined); },
  });
  const r = await make({ config: cfg }).dispatch(
    "set-role",
    ctx({ args: recordArgs({ type: "mapping", role: "OFFICER", discord_role: "444444444444444444" }) }),
  );
  assert.equal(mapped, "444444444444444444");
  assert.match(r.text, /OFFICER now maps to/);
});

test("bridge-suspend and bridge-unsuspend move the flag both ways", async () => {
  const seen: boolean[] = [];
  const cfg = guildConfig({ async setBridgeSuspended(_g, s) { seen.push(s); return ok(undefined); } });
  await make({ config: cfg }).dispatch("bridge-suspend", ctx({ args: recordArgs({}) }));
  await make({ config: cfg }).dispatch("bridge-unsuspend", ctx({ args: recordArgs({}) }));
  assert.deepEqual(seen, [true, false]);
});

test("audit with no matches says so rather than showing an empty embed", async () => {
  const r = await make().dispatch("audit", ctx({ args: recordArgs({}) }));
  assert.match(r.text, /No moderation actions match/);
  assert.equal(r.embed, undefined);
});

test("audit paginates past Discord's field cap", async () => {
  const rows = Array.from({ length: 23 }, (_, i) => action({ id: `a${i}` }));
  const mod = moderation({ async listActions() { return ok(rows); } });
  const r = await make({ moderation: mod }).dispatch("audit", ctx({ args: recordArgs({}) }));
  assert.equal(r.pages?.length, 3);
  assert.equal(r.embed, r.pages?.[0]);
});

test("audit passes its filters straight through", async () => {
  let seen: AuditQuery | null = null;
  const mod = moderation({ async listActions(q) { seen = q; return ok([]); } });
  await make({ moderation: mod }).dispatch(
    "audit",
    ctx({ args: recordArgs({ target: TARGET, type: "BAN", days: "7" }) }),
  );
  const q = seen as unknown as AuditQuery;
  assert.equal(q.targetDiscordId, TARGET);
  assert.equal(q.type, "BAN");
  assert.equal(q.sinceDays, 7);
});

test("audit says so when the log runs past the page limit, rather than stopping silently", async () => {
  // 101 rows: the handler asks for one more than it shows precisely to tell
  // "a hundred entries" apart from "at least a hundred entries".
  const rows = Array.from({ length: 101 }, (_, i) => action({ id: `a${i}` }));
  const mod = moderation({ async listActions() { return ok(rows); } });
  const r = await make({ moderation: mod }).dispatch("audit", ctx({ args: recordArgs({}) }));
  assert.match(r.text, /100\+ action/);
  assert.match(r.pages?.[0]?.title ?? "", /there are more/);
  assert.equal(r.pages?.length, 10, "the extra row is dropped, not rendered");
});

test("audit shows exactly the page limit without claiming there is more", async () => {
  const rows = Array.from({ length: 100 }, (_, i) => action({ id: `a${i}` }));
  const mod = moderation({ async listActions() { return ok(rows); } });
  const r = await make({ moderation: mod }).dispatch("audit", ctx({ args: recordArgs({}) }));
  assert.match(r.text, /^100 action/);
  assert.doesNotMatch(r.pages?.[0]?.title ?? "", /more/);
});

test("audit in_force asks the store for live punishments and says so when there are none", async () => {
  let seen: AuditQuery | null = null;
  const mod = moderation({ async listActions(q) { seen = q; return ok([]); } });
  const r = await make({ moderation: mod }).dispatch(
    "audit",
    ctx({ args: recordArgs({ in_force: "true" }) }),
  );
  assert.equal((seen as unknown as AuditQuery).inForceOnly, true);
  assert.match(r.text, /Nothing is being enforced/);
});

test("an expired mute reads as expired, not as one a staffer lifted", async () => {
  const rows = [
    action({ id: "gone", type: "MUTE", active: true, expiresAt: "2000-01-01T00:00:00.000Z" }),
    action({ id: "early", type: "MUTE", active: false, expiresAt: "2999-01-01T00:00:00.000Z" }),
  ];
  const mod = moderation({ async listActions() { return ok(rows); } });
  const r = await make({ moderation: mod }).dispatch("audit", ctx({ args: recordArgs({}) }));
  const names = (r.pages?.[0]?.fields ?? []).map((f) => f.name);
  assert.match(names[0] ?? "", /\(expired\)/);
  assert.match(names[1] ?? "", /\(lifted\)/);
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

// ─────────────── Applications (COMMANDS.md /application-review) ───────────────

const anApplication: ApplicationDTO = {
  id: "a1", guildId: "g1", applicantDiscordId: "555", status: "SUBMITTED",
  submittedAt: "2026-08-01T00:00:00.000Z", reviewerDiscordId: null, decisionReason: null, decidedAt: null,
};

test("/application-review with no id lists what's waiting", async () => {
  const c = community({ async listApplications() { return ok([anApplication]); } });
  const r = await make({ community: c }).dispatch("application-review", ctx({ args: recordArgs({}) }));
  assert.equal(r.ephemeral, true);
  assert.match(r.text, /1 waiting for review/);
  assert.match(r.embed?.fields?.[0]?.value ?? "", /a1/);
});

test("/application-review with an id opens that application", async () => {
  const c = community({ async getApplication() { return ok(anApplication); } });
  const r = await make({ community: c }).dispatch("application-review", ctx({ args: recordArgs({ id: "a1" }) }));
  assert.match(r.embed?.title ?? "", /Application a1/);
});

test("/application-review says so when the id doesn't exist", async () => {
  const c = community({ async getApplication() { return ok(null); } });
  const r = await make({ community: c }).dispatch("application-review", ctx({ args: recordArgs({ id: "nope" }) }));
  assert.match(r.text, /couldn't find an application/);
});

test("/accept-member records the decision and promotes the applicant", async () => {
  const promoted: string[] = [];
  const c = community({
    async decideApplication(input) {
      return ok({ ...anApplication, status: input.accept ? "ACCEPTED" : "REJECTED", reviewerDiscordId: input.reviewerDiscordId });
    },
    async setMemberRole(_g, discordId, role) { promoted.push(`${discordId}:${role}`); return ok(member); },
  });
  const r = await make({ community: c }).dispatch("accept-member", ctx({ args: recordArgs({ id: "a1" }) }));
  assert.match(r.text, /<@555>'s application was accepted\./);
  assert.deepEqual(promoted, ["555:MEMBER"]);
});

test("accepting someone not yet on the roster still stands, but says the rank wasn't set", async () => {
  const c = community({
    async decideApplication() { return ok({ ...anApplication, status: "ACCEPTED" }); },
    async setMemberRole() { return err(new Error("that member isn't on this server's roster")); },
  });
  const r = await make({ community: c }).dispatch("accept-member", ctx({ args: recordArgs({ id: "a1" }) }));
  assert.match(r.text, /accepted \(they aren't on the roster yet, so no rank was set\)/);
});

test("/deny-member carries the reason and does not touch the roster", async () => {
  let promotions = 0;
  const c = community({
    async decideApplication(input) {
      return ok({ ...anApplication, status: "REJECTED", decisionReason: input.reason ?? null });
    },
    async setMemberRole() { promotions += 1; return ok(member); },
  });
  const r = await make({ community: c }).dispatch(
    "deny-member",
    ctx({ args: recordArgs({ id: "a1", reason: "cata too low" }) }),
  );
  assert.match(r.text, /application was denied/);
  assert.equal(promotions, 0);
  assert.match((r.embed?.fields ?? []).map((f) => f.value).join(" "), /cata too low/);
});

test("re-deciding an application reports the existing verdict", async () => {
  const c = community({ async decideApplication() { return err({ kind: "ALREADY_DECIDED", status: "ACCEPTED" }); } });
  const r = await make({ community: c }).dispatch("accept-member", ctx({ args: recordArgs({ id: "a1" }) }));
  assert.match(r.text, /already accepted/);
});

test("application review is refused below OFFICER", async () => {
  const r = await make({ roles: roles({ actor: "MODERATOR" }) }).dispatch("application-review", ctx());
  assert.match(r.text, /requires OFFICER/);
});
