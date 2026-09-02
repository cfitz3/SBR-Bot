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
  type TicketDTO,
  type WordlistError,
  type WordlistService,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { AdminDispatcher } from "./dispatcher.js";
import { buildAdminRegistry } from "./handlers.js";
import { parseDurationSeconds } from "./util.js";
import type { AdminContext, RoleMenuBridge, RoleResolver, StickyBridge, TicketBridge } from "./types.js";
import { copy } from "@sbr/brand";

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
    enforcement: "CONFIRMED",
    enforcementDetail: null,
    updatedAt: null,
    editedByDiscordId: null,
    voidedAt: null,
    voidReason: null,
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
    async listRecentInfractions() { return ok([]); },
    async listActions() { return ok([]); },
    async listInForce() { return ok([]); },
    async updateAction() { throw new Error("unused"); },
    async setEnforcementManually() { throw new Error("unused"); },
    async retryEnforcement() { throw new Error("unused"); },
    async voidAction() { throw new Error("unused"); },
    async sweepExpired() { return ok(0); },
    async findAction() { return ok(null); },
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
    async setRoleBinding() { return ok(undefined); },
    async setHypixelGuild() { return ok(undefined); },
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
    async update() { return ok(null); },
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
    async ban() { return ok(undefined); },
    async unban() { return ok(undefined); },
    async timeout() { return ok(undefined); },
    async untimeout() { return ok(undefined); },
    async purge() { return ok(0); },
    async setLocked() { return ok(0); },
    ...over,
  };
}
const analytics: AnalyticsService = { async capture() {}, async emit() {} };

interface Overrides {
  moderation?: ModerationService;
  ticketBridge?: TicketBridge;
  roleMenuBridge?: RoleMenuBridge;
  stickyBridge?: StickyBridge;
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
      ...(over.ticketBridge === undefined ? {} : { ticketBridge: over.ticketBridge }),
      ...(over.roleMenuBridge === undefined ? {} : { roleMenuBridge: over.roleMenuBridge }),
      ...(over.stickyBridge === undefined ? {} : { stickyBridge: over.stickyBridge }),
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

test("kick reports an enforcement the service could not carry out", async () => {
  // The Discord call moved into the service, so what the handler owes the
  // staffer is no longer "did my effect call work" but "does the case the
  // service handed back say it took effect". A reply that reads "Kicked" over a
  // case marked enforcement_failed is the exact lie this whole change removes.
  let logged = false;
  const mod = moderation({
    async applyAction() {
      logged = true;
      return ok(action({
        type: "KICK",
        enforcement: "FAILED",
        enforcementDetail: "Discord: I don't have the Discord permission that needs.",
        updatedAt: null,
        editedByDiscordId: null,
        voidedAt: null,
        voidReason: null,
      }));
    },
  });
  const r = await make({ moderation: mod }).dispatch(
    "kick",
    ctx({ args: recordArgs({ target: TARGET, confirm: "true" }) }),
  );

  assert.equal(logged, true, "the audit entry must survive a failed kick");
  assert.match(r.text, /did not take effect/);
  assert.match(r.text, /enforcement_failed/);
  assert.equal(r.ephemeral, true, "a failure is for the staffer, not the channel");
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

test("set-recruitment writes the switch on its own", async () => {
  let patch: RecruitmentSettings | null = null;
  const cfg = guildConfig({ async setRecruitment(_g, input) { patch = input; return ok(undefined); } });
  await make({ config: cfg }).dispatch("set-recruitment", ctx({ args: recordArgs({ open: "true" }) }));

  assert.ok(patch);
  const written = patch as RecruitmentSettings;
  assert.equal(written.open, true);
  // The two stat bars used to be tri-state here, with a `clear_requirements`
  // wipe to null them. Neither is a requirement now, so the command carries no
  // threshold at all — and a stray one arriving from an old client must not be
  // forwarded into the config write.
  assert.deepEqual(Object.keys(written), ["open"]);
});

test("set-recruitment ignores a threshold sent by an out-of-date client", async () => {
  let patch: RecruitmentSettings | null = null;
  const cfg = guildConfig({ async setRecruitment(_g, input) { patch = input; return ok(undefined); } });
  await make({ config: cfg }).dispatch(
    "set-recruitment",
    ctx({ args: recordArgs({ open: "false", min_weight: "1200", clear_requirements: "true" }) }),
  );
  assert.deepEqual(patch, { open: false });
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

test("audit leads with the overview and puts the listing behind it", async () => {
  // Page one is the answer — how much, how much still in force, what kind, who.
  // The entries are a page away for the reader who wants to read rather than
  // search, which is the minority of the times this command is typed.
  const rows = Array.from({ length: 23 }, (_, i) => action({ id: `a${i}` }));
  const mod = moderation({ async listActions() { return ok(rows); } });
  const r = await make({ moderation: mod }).dispatch("audit", ctx({ args: recordArgs({}) }));
  assert.equal(r.pages?.length, 1 + 5, "one overview, then the listing at five a page");
  assert.equal(r.embed, r.pages?.[0]);
  assert.match(r.pages?.[0]?.description ?? "", /23 actions match/);
});

test("audit offers the matching cases as a menu, so an id is never a prerequisite", async () => {
  const rows = [action({ id: "a1" }), action({ id: "a2" })];
  const mod = moderation({ async listActions() { return ok(rows); } });
  const r = await make({ moderation: mod }).dispatch("audit", ctx({ args: recordArgs({}) }));
  assert.deepEqual(
    r.components?.[0]?.select?.options.map((o) => o.value),
    ["a1", "a2"],
  );
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

test("a date range is a whole day at each end, which is what the typist meant", async () => {
  // `to:2026-03-14` that excluded the 14th would be a surprise every time, and
  // the surprise is silent: the case they were looking for is simply not there.
  let seen: AuditQuery | null = null;
  const mod = moderation({ async listActions(q) { seen = q; return ok([]); } });
  await make({ moderation: mod }).dispatch(
    "audit",
    ctx({ args: recordArgs({ from: "2026-03-01", to: "2026-03-14" }) }),
  );
  const q = seen as unknown as AuditQuery;
  assert.equal(q.since, "2026-03-01T00:00:00.000Z");
  assert.equal(q.until, "2026-03-14T23:59:59.999Z");
});

test("a date the parser cannot read is named rather than silently ignored", async () => {
  // An unapplied filter that says nothing produces a result set that looks like
  // an answer, which is worse than an error.
  let seen: AuditQuery | null = null;
  const mod = moderation({
    async listActions(q) { seen = q; return ok([action()]); },
  });
  const r = await make({ moderation: mod }).dispatch(
    "audit",
    ctx({ args: recordArgs({ from: "last tuesday" }) }),
  );
  assert.equal((seen as unknown as AuditQuery).since, null);
  assert.match(r.pages?.[0]?.description ?? "", /Couldn't read `from`/);
});

test("audit says so when the log runs past the page limit, rather than stopping silently", async () => {
  // 101 rows: the handler asks for one more than it shows precisely to tell
  // "a hundred entries" apart from "at least a hundred entries".
  const rows = Array.from({ length: 101 }, (_, i) => action({ id: `a${i}` }));
  const mod = moderation({ async listActions() { return ok(rows); } });
  const r = await make({ moderation: mod }).dispatch("audit", ctx({ args: recordArgs({}) }));
  assert.match(r.pages?.[0]?.description ?? "", /Newest 100 of more than that/);
  assert.equal(r.pages?.length, 1 + 20, "the extra row is dropped, not rendered");
});

test("audit shows exactly the page limit without claiming there is more", async () => {
  const rows = Array.from({ length: 100 }, (_, i) => action({ id: `a${i}` }));
  const mod = moderation({ async listActions() { return ok(rows); } });
  const r = await make({ moderation: mod }).dispatch("audit", ctx({ args: recordArgs({}) }));
  assert.match(r.pages?.[0]?.description ?? "", /^100 actions match\./);
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
  const listing = r.pages?.[1]?.fields ?? [];
  assert.deepEqual(listing.map((f) => f.name), ["Case gone", "Case early"]);
  assert.match(listing[0]?.value ?? "", /expired/);
  assert.match(listing[1]?.value ?? "", /lifted/);
});

test("/case renders the one row the id names", async () => {
  let seen: readonly [string, string] | null = null;
  const mod = moderation({
    async findAction(g, id) {
      seen = [g, id];
      return ok(action({ id: "act-1f3b", type: "BAN" }));
    },
  });
  const r = await make({ moderation: mod }).dispatch(
    "case",
    ctx({ args: recordArgs({ id: " act-1f3b " }) }),
  );
  // Guild-scoped, and the surrounding whitespace of a pasted id is not part of it.
  assert.deepEqual(seen as unknown as string[], ["g1", "act-1f3b"]);
  assert.match(r.embed?.footer ?? "", /act-1f3b/);
});

test("/case on an unknown id says nothing about other guilds", async () => {
  const r = await make().dispatch("case", ctx({ args: recordArgs({ id: "nope" }) }));
  assert.match(r.text, /No case/);
  assert.equal(r.embed, undefined);
});

test("/case is not a member command", async () => {
  const r = await make({ roles: roles({ actor: "MEMBER" }) }).dispatch(
    "case",
    ctx({ args: recordArgs({ id: "x" }) }),
  );
  assert.match(r.text, /requires MODERATOR/);
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
  assert.equal(r.text, copy.error.generic.notFound);
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


// ────────────────────────────── /tickets ─────────────────────────────────────

function ticket(over: Partial<TicketDTO> = {}): TicketDTO {
  return {
    id: "tkt-1",
    guildId: "g1",
    number: 12,
    openerDiscordId: "111111111111111111",
    assigneeDiscordId: null,
    categoryId: "cat-1",
    categoryKey: "support",
    categoryName: "Support",
    status: "OPEN",
    channelId: "222222222222222222",
    subject: null,
    topic: null,
    claimedByDiscordId: null,
    claimedAt: null,
    closeRequestedByDiscordId: null,
    closeRequestedAt: null,
    lastMessageAt: null,
    firstStaffReplyAt: null,
    feedbackRating: null,
    transcriptReady: false,
    closeReason: null,
    createdAt: "2026-08-18T12:00:00.000Z",
    closedAt: null,
    ...over,
  };
}

/** A community with one open ticket, plus a `getTicket` that ignores the guild. */
function ticketCommunity(rows: readonly TicketDTO[] = [ticket()]): CommunityService {
  return community({
    async listTickets() {
      return ok(rows);
    },
    async getTicket(id: string) {
      return ok(rows.find((t) => t.id === id) ?? null);
    },
  } as Partial<CommunityService>);
}

test("/tickets list shows the open queue", async () => {
  const r = await make({ roles: roles({ actor: "MODERATOR" }), community: ticketCommunity() }).dispatch(
    "tickets",
    ctx({ args: recordArgs({ action: "list" }) }),
  );
  assert.match(r.text, /1 open/);
  assert.match(r.embed?.fields?.[0]?.name ?? "", /#12/);
});

test("/tickets view accepts the number staff actually say", async () => {
  const r = await make({ roles: roles({ actor: "MODERATOR" }), community: ticketCommunity() }).dispatch(
    "tickets",
    ctx({ args: recordArgs({ action: "view", id: "#12" }) }),
  );
  assert.match(r.embed?.title ?? "", /Ticket #12/);
});

test("/tickets view refuses a ticket belonging to another server", async () => {
  // Ids are opaque but enumerable in bulk; nothing else in this path would stop
  // one server's staff from reading another's conversation.
  const r = await make({
    roles: roles({ actor: "MODERATOR" }),
    community: ticketCommunity([ticket({ guildId: "other" })]),
  }).dispatch("tickets", ctx({ args: recordArgs({ action: "view", id: "tkt-1" }) }));
  assert.equal(r.text, copy.error.generic.notFound);
});

test("/tickets close without a bridge says so rather than moving the row", async () => {
  // Closing the row here would leave the channel open with everyone still in
  // it — the half-done state the bridge exists to prevent.
  const r = await make({ roles: roles({ actor: "MODERATOR" }), community: ticketCommunity() }).dispatch(
    "tickets",
    ctx({ args: recordArgs({ action: "close", id: "#12" }) }),
  );
  assert.match(r.text, /bridge bot isn't running/);
});

test("/tickets close reports the bridge's own words when it refuses", async () => {
  const bridge: TicketBridge = {
    async close() {
      return { ok: false, detail: "that ticket is already closed" };
    },
    async transcript() {
      return null;
    },
  };
  const r = await make({
    roles: roles({ actor: "MODERATOR" }),
    community: ticketCommunity(),
    ticketBridge: bridge,
  }).dispatch("tickets", ctx({ args: recordArgs({ action: "close", id: "#12" }) }));
  assert.match(r.text, /already closed/);
});

test("/tickets transcript comes back as a file", async () => {
  const bridge: TicketBridge = {
    async close() {
      return { ok: true, number: 12 };
    },
    async transcript() {
      return { name: "ticket-12.md", content: "# 12" };
    },
  };
  const r = await make({
    roles: roles({ actor: "MODERATOR" }),
    community: ticketCommunity(),
    ticketBridge: bridge,
  }).dispatch("tickets", ctx({ args: recordArgs({ action: "transcript", id: "tkt-1" }) }));
  assert.equal(r.file?.name, "ticket-12.md");
});

// ── /rolemenu ─────────────────────────────────────────────────────────────────

function menuBridge(over: Partial<RoleMenuBridge> = {}): RoleMenuBridge {
  return {
    async list() {
      return [{ id: "colours", title: "Pick a colour", optionCount: 2, channelId: null }];
    },
    async publish() {
      return { ok: true, edited: false };
    },
    ...over,
  };
}

test("/rolemenu list names the menus and where they live", async () => {
  const r = await make({ roles: roles({ actor: "OFFICER" }), roleMenuBridge: menuBridge() }).dispatch(
    "rolemenu",
    ctx({ args: recordArgs({ action: "list" }) }),
  );
  assert.match(r.text, /colours/);
  assert.match(r.text, /not posted/);
});

test("/rolemenu post defaults to the channel it was typed in", async () => {
  const seen: (string | null)[] = [];
  const r = await make({
    roles: roles({ actor: "OFFICER" }),
    roleMenuBridge: menuBridge({
      async publish(_guildId, _menuId, channelId) {
        seen.push(channelId);
        return { ok: true, edited: true };
      },
    }),
  }).dispatch("rolemenu", ctx({ args: recordArgs({ action: "post", id: "colours" }) }));
  assert.deepEqual(seen, ["333333333333333333"]);
  assert.match(r.text, /Updated/);
});

test("/rolemenu post reports the bridge's own words when it refuses", async () => {
  const r = await make({
    roles: roles({ actor: "OFFICER" }),
    roleMenuBridge: menuBridge({
      async publish() {
        return { ok: false, detail: "I cannot post in that channel" };
      },
    }),
  }).dispatch("rolemenu", ctx({ args: recordArgs({ action: "post", id: "colours" }) }));
  assert.match(r.text, /cannot post in that channel/);
});

test("/rolemenu without a bridge says so rather than pretending", async () => {
  const r = await make({ roles: roles({ actor: "OFFICER" }) }).dispatch(
    "rolemenu",
    ctx({ args: recordArgs({ action: "list" }) }),
  );
  assert.match(r.text, /bridge bot isn't running/);
});

test("/rolemenu is not a moderator command", async () => {
  // Posting a menu puts a message in front of the whole server, and the roles
  // it hands out were chosen by an admin — a moderator publishing one is a
  // wider act than moderating a channel.
  const r = await make({ roles: roles({ actor: "MODERATOR" }), roleMenuBridge: menuBridge() }).dispatch(
    "rolemenu",
    ctx({ args: recordArgs({ action: "list" }) }),
  );
  assert.match(r.text, /requires OFFICER/);
});

// -- /sticky ------------------------------------------------------------------

function stickyBridge(over: Partial<StickyBridge> = {}): StickyBridge {
  return {
    async list() {
      return [{ channelId: "444444444444444444", content: "Read the rules.\nSeriously.", enabled: true }];
    },
    async set() {
      return { ok: true, created: true, applied: true };
    },
    async clear() {
      return { ok: true, applied: true };
    },
    ...over,
  };
}

test("/sticky list names the channels and shows one line of each note", async () => {
  const r = await make({ roles: roles({ actor: "OFFICER" }), stickyBridge: stickyBridge() }).dispatch(
    "sticky",
    ctx({ args: recordArgs({ action: "list" }) }),
  );
  assert.match(r.text, /<#444444444444444444>/);
  assert.match(r.text, /Read the rules\./);
  // The second line of the note is not part of the summary.
  assert.equal(r.text.includes("Seriously"), false);
});

test("/sticky set defaults to the channel it was typed in", async () => {
  const seen: string[] = [];
  const r = await make({
    roles: roles({ actor: "OFFICER" }),
    stickyBridge: stickyBridge({
      async set(_guildId, channelId) {
        seen.push(channelId);
        return { ok: true, created: true, applied: true };
      },
    }),
  }).dispatch("sticky", ctx({ args: recordArgs({ action: "set", message: "No trading here" }) }));

  assert.deepEqual(seen, ["333333333333333333"]);
  assert.match(r.text, /Sticky set in/);
});

test("/sticky set with nothing to say explains itself instead of storing an empty note", async () => {
  const r = await make({ roles: roles({ actor: "OFFICER" }), stickyBridge: stickyBridge() }).dispatch(
    "sticky",
    ctx({ args: recordArgs({ action: "set", message: "   " }) }),
  );
  assert.match(r.text, /Usage/);
});

test("a saved sticky the bridge could not post says when it will appear", async () => {
  const r = await make({
    roles: roles({ actor: "OFFICER" }),
    stickyBridge: stickyBridge({
      async set() {
        return { ok: true, created: false, applied: false };
      },
    }),
  }).dispatch("sticky", ctx({ args: recordArgs({ action: "set", message: "hi" }) }));

  assert.match(r.text, /Updated the sticky/);
  assert.match(r.text, /next time somebody talks/);
});

test("/sticky clear reports the bridge's own words when there is nothing to clear", async () => {
  const r = await make({
    roles: roles({ actor: "OFFICER" }),
    stickyBridge: stickyBridge({
      async clear() {
        return { ok: false, detail: "that channel has no sticky" };
      },
    }),
  }).dispatch("sticky", ctx({ args: recordArgs({ action: "clear" }) }));
  assert.match(r.text, /no sticky/);
});

test("a cleared sticky the bridge could not reach admits the old message is still up", async () => {
  const r = await make({
    roles: roles({ actor: "OFFICER" }),
    stickyBridge: stickyBridge({
      async clear() {
        return { ok: true, applied: false };
      },
    }),
  }).dispatch("sticky", ctx({ args: recordArgs({ action: "clear" }) }));
  assert.match(r.text, /still up/);
});

test("/sticky without a bridge says so rather than saving what nothing will post", async () => {
  const r = await make({ roles: roles({ actor: "OFFICER" }) }).dispatch(
    "sticky",
    ctx({ args: recordArgs({ action: "list" }) }),
  );
  assert.match(r.text, /bridge bot isn't running/);
});

test("/sticky is not a moderator command", async () => {
  // A sticky is a permanent notice in front of a whole channel, which is the
  // same weight of act as publishing a role menu.
  const r = await make({ roles: roles({ actor: "MODERATOR" }), stickyBridge: stickyBridge() }).dispatch(
    "sticky",
    ctx({ args: recordArgs({ action: "list" }) }),
  );
  assert.match(r.text, /requires OFFICER/);
});

test("/tickets is not a member command", async () => {
  const r = await make({ roles: roles({ actor: "MEMBER" }), community: ticketCommunity() }).dispatch(
    "tickets",
    ctx({ args: recordArgs({ action: "list" }) }),
  );
  assert.match(r.text, /requires MODERATOR/);
});
