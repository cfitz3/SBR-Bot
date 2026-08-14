import assert from "node:assert/strict";
import { test } from "node:test";
import {
  syncDiscordMembers,
  type DiscordMemberRow,
  type DiscordMemberWrite,
  type DiscordSyncPorts,
} from "./discord-sync.js";

const GUILD = "guild-1";

function row(id: string, over: Partial<DiscordMemberRow> = {}): DiscordMemberRow {
  return {
    id,
    username: `user${id}`,
    globalName: null,
    nick: null,
    avatarHash: null,
    roleIds: [],
    joinedAt: "2026-01-02T03:04:05.000Z",
    bot: false,
    ...over,
  };
}

interface Recorder {
  readonly upserts: DiscordMemberWrite[][];
  readonly left: string[][];
}

function ports(
  over: {
    fetched?: readonly DiscordMemberRow[] | null;
    active?: readonly string[];
  } = {},
): { ports: DiscordSyncPorts; rec: Recorder } {
  const rec: Recorder = { upserts: [], left: [] };
  const fetched = over.fetched === undefined ? [] : over.fetched;
  const active = over.active ?? [];
  return {
    rec,
    ports: {
      async fetchMembers() {
        return fetched;
      },
      async listActiveIds() {
        return active;
      },
      async upsertMembers(_g, rows) {
        rec.upserts.push([...rows]);
      },
      async markLeft(_g, ids) {
        rec.left.push([...ids]);
      },
    },
  };
}

test("an unreachable bot writes nothing and evicts nobody", async () => {
  const { ports: p, rec } = ports({ fetched: null, active: ["a", "b"] });
  const result = await syncDiscordMembers(GUILD, p);

  assert.equal(result.skipped, "unreachable");
  assert.deepEqual(rec.upserts, []);
  assert.deepEqual(rec.left, []);
});

test("a roster that comes back empty is refused, not read as everyone leaving", async () => {
  // The Server Members intent being off looks exactly like this: a 200 that
  // carries only the bot, which the filter then removes.
  const { ports: p, rec } = ports({ fetched: [row("bot", { bot: true })], active: ["a", "b"] });
  const result = await syncDiscordMembers(GUILD, p);

  assert.equal(result.skipped, "implausible");
  assert.equal(result.left, 0);
  assert.deepEqual(rec.left, []);
});

test("an empty roster with nothing recorded yet is a normal no-op", async () => {
  const { ports: p, rec } = ports({ fetched: [], active: [] });
  const result = await syncDiscordMembers(GUILD, p);

  assert.equal(result.skipped, undefined);
  assert.equal(result.seen, 0);
  assert.deepEqual(rec.upserts, []);
  assert.deepEqual(rec.left, []);
});

test("bots are excluded from the writes and from every count", async () => {
  const { ports: p, rec } = ports({
    fetched: [row("a"), row("webhook", { bot: true }), row("b")],
    active: [],
  });
  const result = await syncDiscordMembers(GUILD, p);

  assert.equal(result.seen, 2);
  assert.equal(result.joined, 2);
  assert.deepEqual(rec.upserts[0]?.map((w) => w.discordId), ["a", "b"]);
});

test("joined and left are computed against the recorded active set", async () => {
  const { ports: p, rec } = ports({ fetched: [row("a"), row("c")], active: ["a", "b"] });
  const result = await syncDiscordMembers(GUILD, p);

  assert.equal(result.joined, 1, "c is new");
  assert.equal(result.left, 1, "b is gone");
  assert.deepEqual(rec.left, [["b"]]);
  assert.deepEqual(rec.upserts[0]?.map((w) => w.discordId), ["a", "c"]);
});

test("a member who returns is upserted rather than left in place", async () => {
  // `known` holds only ACTIVE rows, so a returning member reads as a join; the
  // upsert is what flips their row back out of LEFT.
  const { ports: p, rec } = ports({ fetched: [row("a")], active: [] });
  const result = await syncDiscordMembers(GUILD, p);

  assert.equal(result.joined, 1);
  assert.deepEqual(rec.left, []);
  assert.equal(rec.upserts[0]?.[0]?.discordId, "a");
});

test("a malformed joinedAt is dropped rather than stored as an Invalid Date", async () => {
  const { ports: p, rec } = ports({ fetched: [row("a", { joinedAt: "not a date" })] });
  await syncDiscordMembers(GUILD, p);

  assert.equal(rec.upserts[0]?.[0]?.joinedAt, null);
});

test("a valid joinedAt survives as a Date", async () => {
  const { ports: p, rec } = ports({ fetched: [row("a")] });
  await syncDiscordMembers(GUILD, p);

  const at = rec.upserts[0]?.[0]?.joinedAt;
  assert.ok(at instanceof Date);
  assert.equal(at.toISOString(), "2026-01-02T03:04:05.000Z");
});

test("names and roles are mirrored verbatim for the permission hot path", async () => {
  const { ports: p, rec } = ports({
    fetched: [row("a", { username: "ash", globalName: "Ash", nick: "Ashy", roleIds: ["r1", "r2"] })],
  });
  await syncDiscordMembers(GUILD, p);

  const write = rec.upserts[0]?.[0];
  assert.equal(write?.username, "ash");
  assert.equal(write?.globalName, "Ash");
  assert.equal(write?.nickname, "Ashy");
  assert.deepEqual(write?.roleIds, ["r1", "r2"]);
});

test("markLeft is not called when nobody departed", async () => {
  const { ports: p, rec } = ports({ fetched: [row("a")], active: ["a"] });
  const result = await syncDiscordMembers(GUILD, p);

  assert.equal(result.left, 0);
  assert.deepEqual(rec.left, []);
});
