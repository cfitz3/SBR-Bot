import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "@sbr/observability";
import { GuildConfigServiceImpl } from "./service.js";
import type { GuildConfigRepository, GuildConfigRow } from "./ports.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

function row(over: Partial<GuildConfigRow> = {}): GuildConfigRow {
  return {
    channels: { bridge: "chan-1" },
    prefixes: ["!"],
    timezone: "UTC",
    applicationsOpen: false,
    bridgeSuspended: false,
    features: { events: true, lfg: false },
    roleMappings: {},
    ...over,
  };
}

function repo(over: Partial<GuildConfigRepository> = {}): GuildConfigRepository {
  return {
    async get() { return row(); },
    async update() {},
    async setFeature() {},
    async setRoleMapping() {},
    async setRoleBinding() {},
    async setChannelBinding() {},
    async setHypixelGuild() {},
    async getSetting() { return null; },
    async setSetting() {},
    ...over,
  };
}

test("reads are cached within the TTL and refreshed after it", async () => {
  let reads = 0;
  let clock = 0;
  const svc = new GuildConfigServiceImpl({
    repo: repo({ async get() { reads += 1; return row(); } }),
    logger: silent,
    ttlMs: 1_000,
    now: () => clock,
  });

  await svc.get("g1");
  await svc.get("g1");
  assert.equal(reads, 1);

  clock = 1_001;
  await svc.get("g1");
  assert.equal(reads, 2);
});

test("a write invalidates the cache so the staffer sees their own change", async () => {
  let reads = 0;
  const svc = new GuildConfigServiceImpl({
    repo: repo({ async get() { reads += 1; return row(); } }),
    logger: silent,
    now: () => 0,
  });

  await svc.get("g1");
  await svc.setBridgeSuspended("g1", true);
  await svc.get("g1");
  assert.equal(reads, 2);
});

test("isFeatureEnabled is false for unset and explicitly-disabled flags", async () => {
  const svc = new GuildConfigServiceImpl({ repo: repo(), logger: silent });
  assert.equal(await svc.isFeatureEnabled("g1", "events"), true);
  assert.equal(await svc.isFeatureEnabled("g1", "lfg"), false);
  assert.equal(await svc.isFeatureEnabled("g1", "never-heard-of-it"), false);
});

test("an unconfigured guild reads as null rather than erroring", async () => {
  const svc = new GuildConfigServiceImpl({ repo: repo({ async get() { return null; } }), logger: silent });
  const result = await svc.get("g1");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, null);
});

test("a database outage serves the last known config instead of failing the bridge", async () => {
  let fail = false;
  const svc = new GuildConfigServiceImpl({
    repo: repo({
      async get() {
        if (fail) throw new Error("db down");
        return row({ bridgeSuspended: true });
      },
    }),
    logger: silent,
    ttlMs: 0, // force a repo hit every time
  });

  await svc.get("g1");
  fail = true;
  const result = await svc.get("g1");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value?.bridgeSuspended, true);
});

test("with no cached value at all, an outage is reported as an error", async () => {
  const svc = new GuildConfigServiceImpl({
    repo: repo({ async get() { throw new Error("db down"); } }),
    logger: silent,
  });
  assert.equal((await svc.get("g1")).ok, false);
});

test("every slot is written to the binding table and nowhere else", async () => {
  const calls: string[] = [];
  const bound: [string, string | null][] = [];
  const svc = new GuildConfigServiceImpl({
    repo: repo({
      async update() { calls.push("update"); },
      async setChannelBinding(_g, slot, id) { calls.push("bind"); bound.push([slot, id]); },
    }),
    logger: silent,
  });

  // Two slots that used to have a mirrored column and one that never did: since
  // the columns were dropped, all three take exactly the same single write.
  await svc.setChannel("g1", "staff", "chan-9");
  await svc.setChannel("g1", "events", null);
  await svc.setChannel("g1", "tickets", "chan-7");
  assert.deepEqual(bound, [["staff", "chan-9"], ["events", null], ["tickets", "chan-7"]]);
  assert.deepEqual(calls, ["bind", "bind", "bind"], "nothing left to mirror into");
});

test("getChannel resolves through the channel map", async () => {
  const svc = new GuildConfigServiceImpl({
    repo: repo({ async get() { return row({ channels: { bridge: "chan-1", tickets: "chan-7" } }); } }),
    logger: silent,
  });

  assert.equal(await svc.getChannel("g1", "tickets"), "chan-7");
  assert.equal(await svc.getChannel("g1", "modlog"), null, "an unbound slot is absent, not an error");
});

test("an unconfigured guild has no channels rather than throwing", async () => {
  const svc = new GuildConfigServiceImpl({ repo: repo({ async get() { return null; } }), logger: silent });
  assert.equal(await svc.getChannel("g1", "bridge"), null);
});

test("settings round-trip through the repository and invalidate the cache", async () => {
  let reads = 0;
  const store = new Map<string, unknown>();
  const svc = new GuildConfigServiceImpl({
    repo: repo({
      async get() { reads += 1; return row(); },
      async getSetting(_g, key) { return store.get(key) ?? null; },
      async setSetting(_g, key, value) { store.set(key, value); },
    }),
    logger: silent,
  });

  await svc.get("g1");
  assert.equal(await svc.getSetting("g1", "xp.weights"), null);
  const written = await svc.setSetting("g1", "xp.weights", { message: 2 });
  assert.equal(written.ok, true);
  assert.deepEqual(await svc.getSetting<{ message: number }>("g1", "xp.weights"), { message: 2 });
  await svc.get("g1");
  assert.equal(reads, 2, "the write must invalidate the cached read");
});

test("a failed setting read degrades to null instead of throwing at the caller", async () => {
  const svc = new GuildConfigServiceImpl({
    repo: repo({ async getSetting() { throw new Error("db down"); } }),
    logger: silent,
  });
  assert.equal(await svc.getSetting("g1", "xp.weights"), null);
});

test("opening recruitment leaves an unspecified threshold alone", async () => {
  const patches: Record<string, unknown>[] = [];
  const svc = new GuildConfigServiceImpl({
    repo: repo({ async update(_g, patch) { patches.push(patch); } }),
    logger: silent,
  });

  await svc.setRecruitment("g1", { open: true });
  assert.deepEqual(patches[0], { applicationsOpen: true });
});

test("recruitment writes the switch and nothing else", async () => {
  // The tri-state weight and networth bars were tested here. They are not
  // requirements any more, so the write is one field and the assertion is that
  // no stale threshold rides along with it.
  const patches: Record<string, unknown>[] = [];
  const svc = new GuildConfigServiceImpl({
    repo: repo({ async update(_g, patch) { patches.push(patch); } }),
    logger: silent,
  });

  await svc.setRecruitment("g1", { open: false });
  assert.deepEqual(patches[0], { applicationsOpen: false });
});

test("every write announces the guild so other processes drop their copy", async () => {
  const published: string[] = [];
  const svc = new GuildConfigServiceImpl({
    repo: repo(),
    broadcast: { async publish(guildId) { published.push(guildId); } },
    logger: silent,
  });

  await svc.setBridgeSuspended("g1", true);
  await svc.setFeature("g1", "welcome", false);
  await svc.setRoleMapping("g2", "OFFICER", "role-9");
  assert.deepEqual(published, ["g1", "g1", "g2"]);
});

test("a feature nobody reads is refused rather than stored", async () => {
  // The whole point of the catalogue: a key that reaches the row but no reader
  // is a switch wired to nothing, and it looks identical to one that works.
  const published: string[] = [];
  let writes = 0;
  const svc = new GuildConfigServiceImpl({
    repo: repo({ async setFeature() { writes += 1; } }),
    broadcast: { async publish(guildId) { published.push(guildId); } },
    logger: silent,
  });

  const r = await svc.setFeature("g1", "events", false);
  assert.equal(r.ok, false);
  assert.equal(writes, 0);
  assert.deepEqual(published, []);
});

test("linking a Hypixel guild clears the cache and announces it like any other write", async () => {
  // It writes a different table from every other method here, which is exactly
  // why it is worth asserting: a link that skipped the fan-out would leave the
  // bots serving "no guild linked" for the rest of their TTL.
  const published: string[] = [];
  let linked: unknown;
  let reads = 0;
  const svc = new GuildConfigServiceImpl({
    repo: repo({
      async get() { reads += 1; return row(); },
      async setHypixelGuild(_g, id) { linked = id; },
    }),
    broadcast: { async publish(guildId) { published.push(guildId); } },
    logger: silent,
    ttlMs: 60_000,
  });

  await svc.get("g1");
  assert.equal((await svc.setHypixelGuild("g1", "abc")).ok, true);
  await svc.get("g1");

  assert.equal(linked, "abc");
  assert.deepEqual(published, ["g1"]);
  assert.equal(reads, 2, "the write should have dropped the cached config");
});

test("a collision on the unique link reaches the caller in words they can act on", async () => {
  const svc = new GuildConfigServiceImpl({
    repo: repo({
      async setHypixelGuild() { throw new Error("another guild on this platform is already linked to that Hypixel guild"); },
    }),
    logger: silent,
  });

  // Unlike every other write here, this failure is not "the database is having a
  // day" — it is a real answer, and flattening it to "couldn't save that
  // setting" would leave the admin retyping a correct id.
  const result = await svc.setHypixelGuild("g1", "abc");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /already linked/);
});

test("a broadcast that fails does not fail the write that was already durable", async () => {
  const svc = new GuildConfigServiceImpl({
    repo: repo(),
    broadcast: { async publish() { throw new Error("redis down"); } },
    logger: silent,
  });

  // The row is committed by this point; reporting failure here would tell the
  // staffer their change was lost when in fact only the fan-out was.
  assert.equal((await svc.setBridgeSuspended("g1", true)).ok, true);
});

test("invalidate drops a cached guild without reading it back", async () => {
  let reads = 0;
  const svc = new GuildConfigServiceImpl({
    repo: repo({ async get() { reads += 1; return row(); } }),
    logger: silent,
  });

  await svc.get("g1");
  assert.equal(reads, 1);
  svc.invalidate("g1");
  assert.equal(reads, 1, "invalidation must not itself cost a query");
  await svc.get("g1");
  assert.equal(reads, 2);
});

test("a role mapping is written through and the read cache dropped", async () => {
  let reads = 0;
  const bound: [string, string | null][] = [];
  const svc = new GuildConfigServiceImpl({
    repo: repo({
      async get() { reads += 1; return row(); },
      async setRoleMapping(_g, role, id) { bound.push([role, id]); },
    }),
    logger: silent,
  });

  await svc.get("g1");
  const r = await svc.setRoleMapping("g1", "OFFICER", "role-9");
  assert.equal(r.ok, true);
  assert.deepEqual(bound, [["OFFICER", "role-9"]]);
  await svc.get("g1");
  assert.equal(reads, 2, "the write must invalidate the cached read");
});
