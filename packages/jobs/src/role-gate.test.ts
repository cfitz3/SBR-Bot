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

test("a player in some other guild is confirmed absent, which revokes", async () => {
  const probe = createGuildRankProbe(guild([{ uuid: UNDASHED, rank: "Member" }], "other"));
  assert.equal(await probe.rank("g1", UUID), null);
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
