import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "@sbr/observability";
import { PermServiceImpl, type PermServiceDeps } from "./service.js";
import type { PermGroupRow, PermMemberRow, PermRepository } from "./ports.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

function aPerm(over: Partial<PermGroupRow> = {}): PermGroupRow {
  return {
    id: "perm1",
    guildId: "g1",
    ownerDiscordId: "owner",
    name: "F7 Carries",
    activity: "DUNGEONS",
    status: "ACTIVE",
    isDefault: false,
    notes: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    members: [],
    ...over,
  };
}

function seat(over: Partial<PermMemberRow> = {}): PermMemberRow {
  return { ign: "Notch", role: "healer", slot: 1, discordId: null, uuid: null, ...over };
}

interface Fake {
  repo: PermRepository;
  added: Array<{ permGroupId: string; ign: string; role: string; slot: number; uuid: string | null }>;
  removed: Array<{ permGroupId: string; ign: string; role: string }>;
  statuses: Array<{ permGroupId: string; status: string }>;
  defaults: string[];
}

function repo(over: Partial<PermRepository> = {}, stored: PermGroupRow | null = aPerm()): Fake {
  const added: Fake["added"] = [];
  const removed: Fake["removed"] = [];
  const statuses: Fake["statuses"] = [];
  const defaults: Fake["defaults"] = [];
  return {
    added,
    removed,
    statuses,
    defaults,
    repo: {
      async create(input) { return aPerm({ ...input, id: "new", notes: input.notes }); },
      async findById(_g, id) { return stored !== null && stored.id === id ? stored : null; },
      async findByName(_g, name) {
        return stored !== null && stored.name.toLowerCase() === name.toLowerCase() ? stored : null;
      },
      async list() { return stored === null ? [] : [stored]; },
      async findDefault() { return null; },
      async addMember(permGroupId, m) {
        added.push({ permGroupId, ign: m.ign, role: m.role, slot: m.slot, uuid: m.uuid ?? null });
        const base = stored ?? aPerm();
        return { ...base, members: [...base.members, seat({ ...m, uuid: m.uuid ?? null, discordId: m.discordId ?? null })] };
      },
      async removeMember(permGroupId, ign, role) {
        removed.push({ permGroupId, ign, role });
        const base = stored ?? aPerm();
        return { ...base, members: base.members.filter((m) => !(m.ign === ign && m.role === role)) };
      },
      async setStatus(permGroupId, status) {
        statuses.push({ permGroupId, status });
        return { ...(stored ?? aPerm()), status };
      },
      async setDefault(permGroupId) {
        defaults.push(permGroupId);
        return { ...(stored ?? aPerm()), isDefault: true };
      },
      ...over,
    },
  };
}

function service(fake: Fake, extra: Partial<PermServiceDeps> = {}): PermServiceImpl {
  return new PermServiceImpl({ repo: fake.repo, logger: silent, ...extra });
}

const owner = { discordId: "owner", isStaff: false };
const staff = { discordId: "mod", isStaff: true };
const stranger = { discordId: "someone", isStaff: false };

// ───────────────────────────── creation ─────────────────────────────

test("a created perm carries the capacity of its activity", async () => {
  const fake = repo();
  const dungeons = await service(fake).createPerm({
    guildId: "g1", ownerDiscordId: "owner", name: "Carries", activity: "DUNGEONS",
  });
  assert.ok(dungeons.ok);
  assert.equal(dungeons.value.capacity, 5);

  const kuudra = await service(fake).createPerm({
    guildId: "g1", ownerDiscordId: "owner", name: "Tier 5", activity: "KUUDRA",
  });
  assert.ok(kuudra.ok);
  assert.equal(kuudra.value.capacity, 4);
});

test("a name already in use by an active perm is rejected, case and spacing aside", async () => {
  const fake = repo({}, aPerm({ name: "F7 Carries" }));
  const result = await service(fake).createPerm({
    guildId: "g1", ownerDiscordId: "owner", name: "  f7   carries  ", activity: "DUNGEONS",
  });
  assert.ok(!result.ok);
  assert.equal(result.error.kind, "NAME_TAKEN");
});

test("disbanding frees the name for reuse", async () => {
  const fake = repo({}, aPerm({ name: "F7 Carries", status: "DISBANDED" }));
  const result = await service(fake).createPerm({
    guildId: "g1", ownerDiscordId: "owner", name: "F7 Carries", activity: "DUNGEONS",
  });
  assert.ok(result.ok);
});

test("a name that is unusable in chat is rejected before it reaches the database", async () => {
  const svc = service(repo({}, null));
  for (const name of ["x", "a".repeat(33), "party <@everyone>"]) {
    const result = await svc.createPerm({ guildId: "g1", ownerDiscordId: "owner", name, activity: "DUNGEONS" });
    assert.ok(!result.ok, `expected "${name}" to be rejected`);
    assert.equal(result.error.kind, "INVALID_NAME");
  }
});

// ───────────────────────────── roster edits ─────────────────────────────

test("the owner and staff may edit a roster; nobody else may", async () => {
  const change = { guildId: "g1", idOrName: "perm1", ign: "Notch", role: "healer" };

  for (const actor of [owner, staff]) {
    const result = await service(repo()).addToRoster({ ...change, actor });
    assert.ok(result.ok, `${actor.discordId} should be allowed`);
  }

  const denied = await service(repo()).addToRoster({ ...change, actor: stranger });
  assert.ok(!denied.ok);
  assert.equal(denied.error.kind, "NOT_OWNER");
});

test("role aliases resolve to the canonical class name", async () => {
  const fake = repo();
  const result = await service(fake).addToRoster({
    guildId: "g1", idOrName: "perm1", actor: owner, ign: "Notch", role: "  BERSERKER ",
  });
  assert.ok(result.ok);
  assert.equal(fake.added[0]?.role, "berserk");
});

test("a role from the wrong activity is rejected with the ones that would work", async () => {
  const fake = repo({}, aPerm({ activity: "KUUDRA" }));
  const result = await service(fake).addToRoster({
    guildId: "g1", idOrName: "perm1", actor: owner, ign: "Notch", role: "healer",
  });
  assert.ok(!result.ok);
  assert.equal(result.error.kind, "INVALID_ROLE");
  assert.ok(result.error.kind === "INVALID_ROLE" && result.error.allowed.includes("cannoneer"));
  assert.equal(fake.added.length, 0);
});

test("a roster cannot exceed the party size for its activity", async () => {
  const full = aPerm({
    activity: "KUUDRA",
    members: [
      seat({ ign: "a", role: "tank", slot: 1 }),
      seat({ ign: "b", role: "damage", slot: 2 }),
      seat({ ign: "c", role: "cannoneer", slot: 3 }),
      seat({ ign: "d", role: "supplier", slot: 4 }),
    ],
  });
  const fake = repo({}, full);
  const result = await service(fake).addToRoster({
    guildId: "g1", idOrName: "perm1", actor: owner, ign: "e", role: "filler",
  });
  assert.ok(!result.ok);
  assert.deepEqual(result.error, { kind: "FULL", capacity: 4 });
  assert.equal(fake.added.length, 0);
});

test("the same player in the same seat is refused, but a second seat is allowed", async () => {
  const fake = repo({}, aPerm({ members: [seat({ ign: "Notch", role: "healer" })] }));

  const duplicate = await service(fake).addToRoster({
    guildId: "g1", idOrName: "perm1", actor: owner, ign: "notch", role: "heal",
  });
  assert.ok(!duplicate.ok);
  assert.equal(duplicate.error.kind, "ALREADY_ON_ROSTER");

  const secondRole = await service(fake).addToRoster({
    guildId: "g1", idOrName: "perm1", actor: owner, ign: "Notch", role: "mage",
  });
  assert.ok(secondRole.ok);
});

test("new seats are appended after the highest slot in use", async () => {
  const fake = repo({}, aPerm({ members: [seat({ slot: 1 }), seat({ ign: "Herobrine", role: "mage", slot: 4 })] }));
  const result = await service(fake).addToRoster({
    guildId: "g1", idOrName: "perm1", actor: owner, ign: "Dinnerbone", role: "tank",
  });
  assert.ok(result.ok);
  assert.equal(fake.added[0]?.slot, 5);
});

test("removal matches the stored spelling, not the typed one", async () => {
  const fake = repo({}, aPerm({ members: [seat({ ign: "Notch", role: "healer" })] }));
  const result = await service(fake).removeFromRoster({
    guildId: "g1", idOrName: "perm1", actor: owner, ign: "NOTCH", role: "HEAL",
  });
  assert.ok(result.ok);
  assert.deepEqual(fake.removed, [{ permGroupId: "perm1", ign: "Notch", role: "healer" }]);
});

test("removing someone who was never on the roster says so instead of succeeding quietly", async () => {
  const fake = repo();
  const result = await service(fake).removeFromRoster({
    guildId: "g1", idOrName: "perm1", actor: owner, ign: "Notch", role: "healer",
  });
  assert.ok(!result.ok);
  assert.equal(result.error.kind, "NOT_ON_ROSTER");
  assert.equal(fake.removed.length, 0);
});

// ───────────────────────────── lifecycle ─────────────────────────────

test("a disbanded perm accepts no further edits", async () => {
  const fake = repo({}, aPerm({ status: "DISBANDED" }));
  const svc = service(fake);
  const change = { guildId: "g1", idOrName: "perm1", actor: owner, ign: "Notch", role: "healer" };

  assert.equal((await svc.addToRoster(change)).ok, false);
  assert.equal((await svc.removeFromRoster(change)).ok, false);
  assert.equal((await svc.disbandPerm("g1", "perm1", owner)).ok, false);
  assert.equal(fake.statuses.length, 0);
});

test("staff may disband someone else's perm, but only the owner picks their own default", async () => {
  const disband = await service(repo()).disbandPerm("g1", "perm1", staff);
  assert.ok(disband.ok);

  const byStaff = await service(repo()).setDefaultPerm("g1", "perm1", staff);
  assert.ok(!byStaff.ok);
  assert.equal(byStaff.error.kind, "NOT_OWNER");

  const byOwner = await service(repo()).setDefaultPerm("g1", "perm1", owner);
  assert.ok(byOwner.ok);
  assert.equal(byOwner.value.isDefault, true);
});

test("a perm resolves by id or by name, and an unknown key is NOT_FOUND", async () => {
  const svc = service(repo({}, aPerm({ id: "perm1", name: "F7 Carries" })));

  assert.ok((await svc.getPerm("g1", "perm1")).ok);
  assert.ok((await svc.getPerm("g1", "f7 carries")).ok);

  const missing = await svc.getPerm("g1", "nothing-like-this");
  assert.ok(!missing.ok);
  assert.equal(missing.error.kind, "NOT_FOUND");
});

// ───────────────────────────── enrichment ─────────────────────────────

test("members are marked as having left the guild, and are ordered by slot", async () => {
  const fake = repo({}, aPerm({
    members: [seat({ ign: "Gone", role: "mage", slot: 2 }), seat({ ign: "Here", role: "healer", slot: 1 })],
  }));
  const svc = service(fake, {
    directory: {
      async find() { return null; },
      async currentIgns() { return new Set(["here"]); },
    },
  });

  const result = await svc.getPerm("g1", "perm1");
  assert.ok(result.ok);
  assert.deepEqual(result.value.members.map((m) => [m.ign, m.inGuild]), [["Here", true], ["Gone", false]]);
});

test("a cold member cache reports 'unknown' rather than accusing everyone of leaving", async () => {
  const fake = repo({}, aPerm({ members: [seat({ ign: "Notch" })] }));
  const svc = service(fake, {
    directory: { async find() { return null; }, async currentIgns() { return new Set<string>(); } },
  });

  const result = await svc.getPerm("g1", "perm1");
  assert.ok(result.ok);
  assert.equal(result.value.members[0]?.inGuild, null);
});

test("an add takes the cache's spelling of the IGN and its uuid", async () => {
  const fake = repo();
  const svc = service(fake, {
    directory: {
      async find() { return { uuid: "uuid-1", ign: "Notch" }; },
      async currentIgns() { return new Set(["notch"]); },
    },
    links: { async discordIdForIgn() { return "discord-1"; } },
  });

  const result = await svc.addToRoster({
    guildId: "g1", idOrName: "perm1", actor: owner, ign: "nOtCh", role: "healer",
  });
  assert.ok(result.ok);
  assert.equal(fake.added[0]?.ign, "Notch");
  assert.equal(fake.added[0]?.uuid, "uuid-1");
});

test("a player the cache has never seen is still addable", async () => {
  const fake = repo();
  const svc = service(fake, {
    directory: { async find() { return null; }, async currentIgns() { return new Set<string>(); } },
  });

  const result = await svc.addToRoster({
    guildId: "g1", idOrName: "perm1", actor: owner, ign: "JustJoined", role: "tank",
  });
  assert.ok(result.ok);
  assert.equal(fake.added[0]?.ign, "JustJoined");
  assert.equal(fake.added[0]?.uuid, null);
});

test("snapshot stats are attached by uuid, and stay null for members without one", async () => {
  const fake = repo({}, aPerm({
    members: [seat({ ign: "Known", uuid: "uuid-1" }), seat({ ign: "Unknown", role: "mage", slot: 2 })],
  }));
  const svc = service(fake, {
    progress: {
      async forUuids() { return { "uuid-1": { catacombsLevel: 42, skillAverage: 51.2 } }; },
    },
  });

  const result = await svc.getPerm("g1", "perm1");
  assert.ok(result.ok);
  assert.deepEqual(
    result.value.members.map((m) => [m.ign, m.catacombsLevel, m.skillAverage]),
    [["Known", 42, 51.2], ["Unknown", null, null]],
  );
});

test("a roster still renders when the caches behind the extra columns are down", async () => {
  const fake = repo({}, aPerm({ members: [seat({ ign: "Notch", uuid: "uuid-1" })] }));
  const svc = service(fake, {
    directory: {
      async find() { throw new Error("redis down"); },
      async currentIgns() { throw new Error("db down"); },
    },
    progress: { async forUuids() { throw new Error("db down"); } },
  });

  const result = await svc.getPerm("g1", "perm1");
  assert.ok(result.ok);
  assert.equal(result.value.members[0]?.ign, "Notch");
  assert.equal(result.value.members[0]?.inGuild, null);
  assert.equal(result.value.members[0]?.catacombsLevel, null);
});
