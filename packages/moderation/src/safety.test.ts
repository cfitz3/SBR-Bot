import assert from "node:assert/strict";
import { test } from "node:test";
import { err, ok, type AntiRaidStateDTO, type GuildEffects, type LockdownStateDTO } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import type { SafetyStateStore } from "./ports.js";
import { SafetyServiceImpl } from "./safety.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

function store(): SafetyStateStore & { locks: Map<string, LockdownStateDTO>; raids: Map<string, AntiRaidStateDTO> } {
  const locks = new Map<string, LockdownStateDTO>();
  const raids = new Map<string, AntiRaidStateDTO>();
  return {
    locks,
    raids,
    async getLockdown(g) { return locks.get(g) ?? null; },
    async putLockdown(s) { locks.set(s.guildId, s); },
    async clearLockdown(g) { locks.delete(g); },
    async listLockdowns() { return [...locks.values()]; },
    async getAntiRaid(g) { return raids.get(g) ?? null; },
    async putAntiRaid(s) { raids.set(s.guildId, s); },
    async clearAntiRaid(g) { raids.delete(g); },
    async listAntiRaid() { return [...raids.values()]; },
  };
}

function effects(
  over: Partial<GuildEffects> = {},
): GuildEffects & { locked: boolean[]; calls: { channelId: string | null; on: boolean }[] } {
  const locked: boolean[] = [];
  const calls: { channelId: string | null; on: boolean }[] = [];
  return {
    locked,
    calls,
    async kick() { return ok(undefined); },
    async ban() { return ok(undefined); },
    async unban() { return ok(undefined); },
    async timeout() { return ok(undefined); },
    async untimeout() { return ok(undefined); },
    async purge() { return ok(0); },
    // A server-wide lock shuts two of the three text channels: `chat` and
    // `help` were open, `archive` was already shut and is not in the result.
    async setLocked(_g, c, on) {
      locked.push(on);
      calls.push({ channelId: c, on });
      return ok(c === null ? ["chat", "help"] : [c]);
    },
    ...over,
  };
}

const T0 = new Date("2026-01-01T00:00:00.000Z");

function make(
  over: { store?: ReturnType<typeof store>; effects?: ReturnType<typeof effects>; now?: () => Date } = {},
) {
  const s = over.store ?? store();
  const e = over.effects ?? effects();
  return {
    svc: new SafetyServiceImpl({ store: s, effects: e, logger: silent, now: over.now ?? (() => T0) }),
    store: s,
    effects: e,
  };
}

test("a channel lockdown without a channel is refused rather than locking the server", async () => {
  const { svc } = make();
  const r = await svc.lockdown({ guildId: "g", actorDiscordId: "u", scope: "CHANNEL", reason: "raid" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.kind, "CHANNEL_REQUIRED");
});

test("a server lockdown locks Discord and records who and why", async () => {
  const { svc, effects: e, store: s } = make();
  const r = await svc.lockdown({
    guildId: "g", actorDiscordId: "u1", scope: "SERVER", reason: "raid", durationSeconds: 600,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(e.locked, [true]);
  assert.equal(r.value.actorDiscordId, "u1");
  assert.equal(r.value.expiresAt, "2026-01-01T00:10:00.000Z");
  assert.equal(s.locks.get("g")?.reason, "raid");
});

test("locking an already-locked server reports when the existing lock ends", async () => {
  const { svc } = make();
  await svc.lockdown({ guildId: "g", actorDiscordId: "u", scope: "SERVER", reason: "a", durationSeconds: 600 });
  const again = await svc.lockdown({ guildId: "g", actorDiscordId: "u", scope: "SERVER", reason: "b" });
  assert.equal(again.ok, false);
  if (again.ok) return;
  assert.equal(again.error.kind, "ALREADY_ACTIVE");
  assert.equal(again.error.until, "2026-01-01T00:10:00.000Z");
});

test("a Discord refusal leaves no lockdown recorded", async () => {
  const failing = effects({ async setLocked() { return err({ kind: "MISSING_PERMISSION" as const }); } });
  const { svc, store: s } = make({ effects: failing });
  const r = await svc.lockdown({ guildId: "g", actorDiscordId: "u", scope: "SERVER", reason: "raid" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.kind, "DISCORD_FAILED");
  assert.equal(s.locks.size, 0);
});

test("lifting a lockdown unlocks Discord and clears the record", async () => {
  const { svc, effects: e, store: s } = make();
  await svc.lockdown({ guildId: "g", actorDiscordId: "u", scope: "SERVER", reason: "raid" });
  const lifted = await svc.liftLockdown("g");
  assert.equal(lifted.ok && lifted.value?.reason, "raid");
  assert.deepEqual(e.locked, [true, false, false]);
  assert.equal(s.locks.size, 0);
});

test("lifting when nothing is locked reports nothing rather than failing", async () => {
  const { svc } = make();
  const r = await svc.liftLockdown("g");
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.value, null);
});

test("an elapsed lockdown reads as inactive even before the sweep runs", async () => {
  const s = store();
  let clock = T0;
  const { svc } = make({ store: s, now: () => clock });
  await svc.lockdown({ guildId: "g", actorDiscordId: "u", scope: "SERVER", reason: "raid", durationSeconds: 60 });
  clock = new Date(T0.getTime() + 120_000);
  const status = await svc.status("g");
  assert.equal(status.ok && status.value.lockdown, null);
});

test("the expiry sweep actually reopens the channels", async () => {
  const s = store();
  const e = effects();
  let clock = T0;
  const { svc } = make({ store: s, effects: e, now: () => clock });
  await svc.lockdown({ guildId: "g", actorDiscordId: "u", scope: "SERVER", reason: "raid", durationSeconds: 60 });
  clock = new Date(T0.getTime() + 120_000);
  assert.equal(await svc.sweepExpired(), 1);
  assert.deepEqual(e.locked, [true, false, false]);
  assert.equal(s.locks.size, 0);
});

test("an unlock the sweep couldn't perform is retried rather than forgotten", async () => {
  const s = store();
  let allow = false;
  const e = effects({
    async setLocked(_g, c, on) {
      if (!on && !allow) return err({ kind: "FAILED" as const, detail: "network" });
      return ok(c === null ? ["c1", "c2"] : [c]);
    },
  });
  let clock = T0;
  const { svc } = make({ store: s, effects: e, now: () => clock });
  await svc.lockdown({ guildId: "g", actorDiscordId: "u", scope: "SERVER", reason: "raid", durationSeconds: 60 });
  clock = new Date(T0.getTime() + 120_000);
  assert.equal(await svc.sweepExpired(), 0);
  assert.equal(s.locks.size, 1, "the record must survive so the next tick retries");
  allow = true;
  assert.equal(await svc.sweepExpired(), 1);
  assert.equal(s.locks.size, 0);
});

test("anti-raid turns on once, then reports it is already on", async () => {
  const { svc } = make();
  const on = await svc.enableAntiRaid({
    guildId: "g", actorDiscordId: "u", sensitivity: "HIGH", durationSeconds: 3_600,
  });
  assert.equal(on.ok && on.value.sensitivity, "HIGH");
  const again = await svc.enableAntiRaid({ guildId: "g", actorDiscordId: "u", sensitivity: "LOW" });
  assert.equal(again.ok, false);
  if (again.ok) return;
  assert.equal(again.error.kind, "ALREADY_ACTIVE");
});

test("turning anti-raid off when it isn't on says so", async () => {
  const { svc } = make();
  const r = await svc.disableAntiRaid("g");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.kind, "NOT_ACTIVE");
});

test("an elapsed anti-raid posture can be re-enabled without an off first", async () => {
  let clock = T0;
  const { svc } = make({ now: () => clock });
  await svc.enableAntiRaid({ guildId: "g", actorDiscordId: "u", sensitivity: "LOW", durationSeconds: 60 });
  clock = new Date(T0.getTime() + 120_000);
  const again = await svc.enableAntiRaid({ guildId: "g", actorDiscordId: "u", sensitivity: "HIGH" });
  assert.equal(again.ok, true);
});

test("lifting reopens exactly what the lock shut, and nothing else", async () => {
  // The bug: lifting called `setLocked(guild, null, false)`, which walked every
  // text channel and granted Send Messages back. Channels the server had
  // deliberately kept shut — archives, staff rooms, a channel some officer
  // locked last month — came open as a side effect of a raid ending. The port
  // now reports which channels it actually changed, and the lift undoes those.
  const e = effects();
  const { svc } = make({ effects: e });
  await svc.lockdown({ guildId: "g", actorDiscordId: "u", scope: "SERVER", reason: "raid" });
  await svc.liftLockdown("g");
  assert.deepEqual(
    e.calls.filter((c) => !c.on).map((c) => c.channelId),
    ["chat", "help"],
    "`archive` was already shut before the lockdown and stays shut after it",
  );
});

test("a server lock swallows a channel lock rather than being refused", async () => {
  // A raid that starts in one channel and spreads is the ordinary case. The old
  // code answered the escalation with ALREADY_ACTIVE, so the way to widen a
  // lockdown was to lift it first — briefly reopening the channel the raid was
  // in.
  const s = store();
  const e = effects();
  const { svc } = make({ store: s, effects: e });
  await svc.lockdown({ guildId: "g", actorDiscordId: "u", scope: "CHANNEL", channelId: "chat", reason: "raid" });
  const wider = await svc.lockdown({ guildId: "g", actorDiscordId: "u", scope: "SERVER", reason: "spreading" });
  assert.equal(wider.ok, true);
  if (!wider.ok) return;
  assert.equal(wider.value.scope, "SERVER");
  assert.equal(wider.value.absorbedChannelId, "chat", "the card can say where the earlier lock went");
  assert.equal(s.locks.size, 1, "one posture, not two records fighting over the same guild");
  assert.deepEqual([...(wider.value.lockedChannelIds ?? [])].sort(), ["chat", "help"]);
});

test("the fold leaves no channel orphaned when the wider lock lifts", async () => {
  // Inheriting the absorbed lock's channels is the whole point: without it the
  // channel locked first is unlocked by nobody, because the record naming it
  // was replaced.
  const e = effects();
  const { svc } = make({ effects: e });
  await svc.lockdown({ guildId: "g", actorDiscordId: "u", scope: "CHANNEL", channelId: "quiet", reason: "raid" });
  await svc.lockdown({ guildId: "g", actorDiscordId: "u", scope: "SERVER", reason: "spreading" });
  await svc.liftLockdown("g");
  assert.deepEqual(
    e.calls.filter((c) => !c.on).map((c) => c.channelId).sort(),
    ["chat", "help", "quiet"],
  );
});

test("a channel lock does not swallow the server lock already in force", async () => {
  // Escalation is one-way. Narrowing has to be a lift and a re-lock, so that
  // "lock this channel" can never quietly reopen the rest of the server.
  const { svc } = make();
  await svc.lockdown({ guildId: "g", actorDiscordId: "u", scope: "SERVER", reason: "raid" });
  const narrower = await svc.lockdown({
    guildId: "g", actorDiscordId: "u", scope: "CHANNEL", channelId: "chat", reason: "still",
  });
  assert.equal(narrower.ok, false);
  if (narrower.ok) return;
  assert.equal(narrower.error.kind, "ALREADY_ACTIVE");
});

test("a legacy record with no channel list still lifts, the old way", async () => {
  // Rows written before the port reported ids have `lockedChannelIds: null`.
  // Refusing to lift them, or lifting nothing, would strand a live lockdown on
  // the deploy that fixed lockdowns.
  const s = store();
  const e = effects();
  const { svc } = make({ store: s, effects: e });
  await svc.lockdown({ guildId: "g", actorDiscordId: "u", scope: "CHANNEL", channelId: "chat", reason: "raid" });
  const stored = s.locks.get("g");
  if (stored) s.locks.set("g", { ...stored, lockedChannelIds: null });
  await svc.liftLockdown("g");
  assert.deepEqual(e.calls.filter((c) => !c.on).map((c) => c.channelId), ["chat"]);
});
