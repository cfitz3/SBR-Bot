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

function effects(over: Partial<GuildEffects> = {}): GuildEffects & { locked: boolean[] } {
  const locked: boolean[] = [];
  return {
    locked,
    async kick() { return ok(undefined); },
    async ban() { return ok(undefined); },
    async unban() { return ok(undefined); },
    async timeout() { return ok(undefined); },
    async untimeout() { return ok(undefined); },
    async purge() { return ok(0); },
    async setLocked(_g, _c, on) { locked.push(on); return ok(1); },
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
  assert.deepEqual(e.locked, [true, false]);
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
  assert.deepEqual(e.locked, [true, false]);
  assert.equal(s.locks.size, 0);
});

test("an unlock the sweep couldn't perform is retried rather than forgotten", async () => {
  const s = store();
  let allow = false;
  const e = effects({
    async setLocked(_g, _c, on) {
      if (!on && !allow) return err({ kind: "FAILED" as const, detail: "network" });
      return ok(1);
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
