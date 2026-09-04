/**
 * The gate's one job is to distinguish three answers, and the tests are mostly
 * about the third: an unreachable Hypixel must never read as "they left the
 * guild", because that answer revokes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createGuildRankProbe, type GuildLookup } from "./role-gate.js";

const UUID = "11111111-2222-3333-4444-555555555555";
const UNDASHED = UUID.replaceAll("-", "");

function lookup(result: Awaited<ReturnType<GuildLookup["getGuild"]>>): GuildLookup {
  return { getGuild: () => Promise.resolve(result) };
}

/** Records what was asked, and answers only when the test says to. */
function slowLookup(result: Awaited<ReturnType<GuildLookup["getGuild"]>>) {
  const asked: string[] = [];
  let release = (): void => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return {
    asked,
    release: () => release(),
    hypixel: {
      async getGuild(id: string) {
        asked.push(id);
        await gate;
        return result;
      },
    } satisfies GuildLookup,
  };
}

function guild(members: readonly { uuid: string; rank: string | null }[], id = "g1") {
  return lookup({ ok: true, value: { data: { id, members } } });
}

test("a member of the bound guild answers with their rank", async () => {
  const probe = createGuildRankProbe(guild([{ uuid: UNDASHED, rank: "Officer" }]));
  assert.equal(await probe.rank("g1", UUID), "Officer");
});

test("undashed and dashed uuids are the same player", async () => {
  const probe = createGuildRankProbe(guild([{ uuid: UUID, rank: "Member" }]));
  assert.equal(await probe.rank("g1", UNDASHED), "Member");
});

test("a rankless member is still a member", async () => {
  const probe = createGuildRankProbe(guild([{ uuid: UNDASHED, rank: null }]));
  assert.equal(await probe.rank("g1", UUID), "Member");
});

test("a player who is not on the roster is confirmed absent, which revokes", async () => {
  const probe = createGuildRankProbe(guild([{ uuid: "someone-else", rank: "Member" }]));
  assert.equal(await probe.rank("g1", UUID), null);
});

test("somebody else's roster is not evidence about this guild's member", async () => {
  // Cannot happen against Hypixel, which answers the id it was asked for. It
  // can happen against a cache with a mixed-up key, and the safe reading of a
  // roster we did not ask for is "we do not know" rather than "they left".
  const probe = createGuildRankProbe(guild([{ uuid: UNDASHED, rank: "Member" }], "other"));
  assert.equal(await probe.rank("g1", UUID), undefined);
});

test("the guild is asked for by id, so it is one cache entry for everybody", async () => {
  const spy = { asked: [] as [string, string][] };
  const probe = createGuildRankProbe({
    async getGuild(id, by) {
      spy.asked.push([id, by]);
      return { ok: true, value: { data: { id: "g1", members: [{ uuid: UNDASHED, rank: "Member" }] } } };
    },
  });
  await probe.rank("g1", UUID);
  assert.deepEqual(spy.asked, [["g1", "id"]]);
});

/**
 * The influx case. Twenty people pressing /link inside the same second all miss
 * the client cache, because none of their requests has returned yet — so the
 * thing that has to collapse them is here, not downstream.
 */
test("a crowd asking at once costs one upstream call", async () => {
  const slow = slowLookup({ ok: true, value: { data: { id: "g1", members: [{ uuid: UNDASHED, rank: "Member" }] } } });
  const probe = createGuildRankProbe(slow.hypixel);

  const crowd = Promise.all(Array.from({ length: 20 }, () => probe.rank("g1", UUID)));
  slow.release();
  const answers = await crowd;

  assert.equal(slow.asked.length, 1, "twenty links should not be twenty guild fetches");
  assert.deepEqual(new Set(answers), new Set(["Member"]));
});

test("the next crowd after the first settles asks again rather than reusing a stale promise", async () => {
  let calls = 0;
  const probe = createGuildRankProbe({
    async getGuild() {
      calls += 1;
      return { ok: true, value: { data: { id: "g1", members: [] } } };
    },
  });
  await probe.rank("g1", UUID);
  await probe.rank("g1", UUID);
  // Two, because coalescing is about concurrency; staleness is the client
  // cache's problem and it has a TTL for it.
  assert.equal(calls, 2);
});

test("a player in no guild at all is confirmed absent", async () => {
  const probe = createGuildRankProbe(lookup({ ok: false, error: { state: "MISSING_PROFILE" } }));
  assert.equal(await probe.rank("g1", UUID), null);
});

test("a rate limit is not evidence about the member", async () => {
  const probe = createGuildRankProbe(lookup({ ok: false, error: { state: "RATE_LIMITED" } }));
  assert.equal(await probe.rank("g1", UUID), undefined);
});

test("a rejected key is not evidence about the member either", async () => {
  const probe = createGuildRankProbe(lookup({ ok: false, error: { state: "API_DISABLED" } }));
  assert.equal(await probe.rank("g1", UUID), undefined);
});

test("a thrown lookup is unknown rather than a thrown probe", async () => {
  const probe = createGuildRankProbe({ getGuild: () => Promise.reject(new Error("socket")) });
  assert.equal(await probe.rank("g1", UUID), undefined);
});
