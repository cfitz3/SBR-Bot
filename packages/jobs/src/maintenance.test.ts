import assert from "node:assert/strict";
import { test } from "node:test";

import {
  diffRoster,
  findInactive,
  ingestAnalytics,
  invalidateConfigCaches,
  scanInactivity,
  syncRoster,
  type ActivityRow,
  type RosterMemberLike,
  type StoredRosterRow,
} from "./maintenance.js";

const NOW = new Date("2026-08-07T12:00:00.000Z");
const DAY = 24 * 60 * 60_000;

function stored(over: Partial<StoredRosterRow> = {}): StoredRosterRow {
  return { minecraftAccountId: "m1", uuid: "aaaa", guildRank: "Member", active: true, ...over };
}
function remote(over: Partial<RosterMemberLike> = {}): RosterMemberLike {
  return { uuid: "aaaa", rank: "Member", joinedAt: null, ...over };
}

test("the diff classifies joins, departures and rank changes", () => {
  const diff = diffRoster(
    [remote({ uuid: "aaaa" }), remote({ uuid: "bbbb", rank: "Officer" }), remote({ uuid: "cccc" })],
    [
      stored({ minecraftAccountId: "m-a", uuid: "aaaa" }),
      stored({ minecraftAccountId: "m-b", uuid: "bbbb", guildRank: "Member" }),
      stored({ minecraftAccountId: "m-d", uuid: "dddd" }),
    ],
  );

  assert.deepEqual(
    diff.joined.map((m) => m.uuid),
    ["cccc"],
  );
  assert.deepEqual(
    diff.left.map((r) => r.uuid),
    ["dddd"],
  );
  assert.deepEqual(diff.rankChanged.map((c) => [c.row.uuid, c.rank]), [["bbbb", "Officer"]]);
});

test("uuids match regardless of dashes or case, so formatting differences aren't departures", () => {
  const diff = diffRoster([remote({ uuid: "AAAA-BBBB" })], [stored({ uuid: "aaaabbbb" })]);
  assert.deepEqual(diff.joined, []);
  assert.deepEqual(diff.left, []);
});

test("a member who previously left and came back counts as a join again", () => {
  const diff = diffRoster([remote()], [stored({ active: false })]);
  assert.equal(diff.joined.length, 1);
});

test("an unreadable roster makes no changes at all", async () => {
  let applied = false;
  const result = await syncRoster("g1", {
    fetchRemoteRoster: async () => null,
    listStoredRoster: async () => [stored()],
    applyJoined: async () => {
      applied = true;
    },
    applyLeft: async () => {
      applied = true;
    },
    applyRankChanges: async () => {
      applied = true;
    },
  });

  assert.equal(result.skipped, "unreadable");
  assert.equal(applied, false);
});

test("a truncated response that looks like a mass exodus is refused, not applied", async () => {
  let left = 0;
  const result = await syncRoster("g1", {
    // Only one of four members came back — far more likely a bad response than
    // three simultaneous departures.
    fetchRemoteRoster: async () => [remote({ uuid: "aaaa" })],
    listStoredRoster: async () => [
      stored({ uuid: "aaaa" }),
      stored({ uuid: "bbbb" }),
      stored({ uuid: "cccc" }),
      stored({ uuid: "dddd" }),
    ],
    applyJoined: async () => {},
    applyLeft: async (_g, rows) => {
      left += rows.length;
    },
    applyRankChanges: async () => {},
  });

  assert.equal(result.skipped, "mass-departure");
  assert.equal(left, 0);
});

test("a normal diff is applied and counted", async () => {
  const result = await syncRoster("g1", {
    fetchRemoteRoster: async () => [remote({ uuid: "aaaa" }), remote({ uuid: "eeee" })],
    listStoredRoster: async () => [
      stored({ uuid: "aaaa" }),
      stored({ uuid: "bbbb" }),
      stored({ uuid: "cccc" }),
      stored({ uuid: "dddd" }),
    ],
    applyJoined: async () => {},
    applyLeft: async () => {},
    applyRankChanges: async () => {},
    maxLeaveFraction: 0.9,
  });

  assert.deepEqual(result, { joined: 1, left: 3, rankChanged: 0, touched: ["eeee", "bbbb", "cccc", "dddd"] });
});

test("the result names everyone it wrote about, so the caller can mark them dirty", async () => {
  // The counts alone were the bug: this pass is the only writer of the guild
  // rank an IN_GUILD auto-role rule reads, and a caller handed three numbers
  // cannot tell role sync whose facts moved.
  const result = await syncRoster("g1", {
    fetchRemoteRoster: async () => [remote({ uuid: "aaaa" }), remote({ uuid: "bbbb", rank: "Officer" }), remote({ uuid: "eeee" })],
    listStoredRoster: async () => [
      stored({ minecraftAccountId: "m-a", uuid: "aaaa" }),
      stored({ minecraftAccountId: "m-b", uuid: "bbbb" }),
      stored({ minecraftAccountId: "m-c", uuid: "cccc" }),
      stored({ minecraftAccountId: "m-d", uuid: "dddd" }),
    ],
    applyJoined: async () => {},
    applyLeft: async () => {},
    applyRankChanges: async () => {},
    maxLeaveFraction: 0.9,
  });

  // A joiner, a rank change and two departures — and nobody unchanged.
  assert.deepEqual([...result.touched].sort(), ["bbbb", "cccc", "dddd", "eeee"]);
  assert.ok(!result.touched.includes("aaaa"));
});

test("a refused pass names nobody, because it wrote nothing", async () => {
  const result = await syncRoster("g1", {
    fetchRemoteRoster: async () => [remote({ uuid: "aaaa" })],
    listStoredRoster: async () => [
      stored({ uuid: "aaaa" }),
      stored({ uuid: "bbbb" }),
      stored({ uuid: "cccc" }),
      stored({ uuid: "dddd" }),
    ],
    applyJoined: async () => {},
    applyLeft: async () => {},
    applyRankChanges: async () => {},
  });

  assert.equal(result.skipped, "mass-departure");
  assert.deepEqual(result.touched, []);
});

function activity(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    minecraftAccountId: "m1",
    uuid: "aaaa",
    lastSeenAt: NOW.getTime(),
    joinedAt: NOW.getTime() - 60 * DAY,
    exempt: false,
    ...over,
  };
}

test("only members past the threshold are flagged", () => {
  const flags = findInactive(
    [
      activity({ minecraftAccountId: "active", lastSeenAt: NOW.getTime() - 2 * DAY }),
      activity({ minecraftAccountId: "gone", lastSeenAt: NOW.getTime() - 20 * DAY }),
    ],
    NOW,
    14,
    7,
  );

  assert.deepEqual(flags, [{ minecraftAccountId: "gone", inactiveDays: 20, reason: "INACTIVE" }]);
});

test("a hidden API is reported as unknown activity, not as absence", () => {
  const flags = findInactive([activity({ lastSeenAt: null })], NOW, 14, 7);
  assert.equal(flags[0]?.reason, "UNKNOWN_ACTIVITY");
});

test("new members and exempt members are never flagged", () => {
  const rows = [
    activity({ minecraftAccountId: "new", joinedAt: NOW.getTime() - 2 * DAY, lastSeenAt: NOW.getTime() - 2 * DAY }),
    activity({ minecraftAccountId: "exempt", exempt: true, lastSeenAt: NOW.getTime() - 90 * DAY }),
  ];
  assert.deepEqual(findInactive(rows, NOW, 14, 7), []);
});

test("a scan with nothing to flag writes nothing", async () => {
  let wrote = false;
  const count = await scanInactivity("g1", {
    listActivity: async () => [activity()],
    flag: async () => {
      wrote = true;
    },
    now: () => NOW,
  });
  assert.equal(count, 0);
  assert.equal(wrote, false);
});

test("ingest drains batches until the buffer is short, persisting before acking", async () => {
  const order: string[] = [];
  const buffer = [...Array(7).keys()];

  const total = await ingestAnalytics({
    drain: async (n) => buffer.splice(0, n),
    persist: async (e) => {
      order.push(`persist:${e.length}`);
    },
    ack: async (e) => {
      order.push(`ack:${e.length}`);
    },
    batchSize: 3,
  });

  assert.equal(total, 7);
  assert.deepEqual(order, ["persist:3", "ack:3", "persist:3", "ack:3", "persist:1", "ack:1"]);
});

test("a failed persist leaves the batch unacked, so it is replayed rather than lost", async () => {
  let acked = false;
  await assert.rejects(
    ingestAnalytics({
      drain: async () => [1, 2, 3],
      persist: async () => {
        throw new Error("db down");
      },
      ack: async () => {
        acked = true;
      },
      batchSize: 3,
    }),
  );
  assert.equal(acked, false);
});

test("an empty buffer costs one drain and no writes", async () => {
  let drains = 0;
  const total = await ingestAnalytics({
    drain: async () => {
      drains += 1;
      return [];
    },
    persist: async () => assert.fail("nothing to persist"),
    ack: async () => assert.fail("nothing to ack"),
  });
  assert.equal(total, 0);
  assert.equal(drains, 1);
});

test("config invalidation evicts changed guilds and advances the watermark", async () => {
  const evicted: string[] = [];
  let watermark: Date | null = new Date("2026-08-07T11:00:00.000Z");
  let queried: Date | null = null;

  const count = await invalidateConfigCaches({
    listChangedGuilds: async (since) => {
      queried = since;
      return ["g1", "g2"];
    },
    invalidate: async (g) => {
      evicted.push(g);
    },
    setWatermark: async (at) => {
      watermark = at;
    },
    watermark: async () => watermark,
    now: () => NOW,
  });

  assert.equal(count, 2);
  assert.deepEqual(evicted, ["g1", "g2"]);
  assert.equal((queried as unknown as Date)?.toISOString(), "2026-08-07T11:00:00.000Z");
  assert.equal(watermark.toISOString(), NOW.toISOString());
});

test("a failed eviction leaves the watermark alone so the window is re-covered", async () => {
  let advanced = false;
  await assert.rejects(
    invalidateConfigCaches({
      listChangedGuilds: async () => ["g1"],
      invalidate: async () => {
        throw new Error("redis down");
      },
      setWatermark: async () => {
        advanced = true;
      },
      watermark: async () => null,
      now: () => NOW,
    }),
  );
  assert.equal(advanced, false);
});

test("a cold start looks back a bounded window instead of over all history", async () => {
  let queried: Date | undefined;
  await invalidateConfigCaches({
    listChangedGuilds: async (since) => {
      queried = since;
      return [];
    },
    invalidate: async () => {},
    setWatermark: async () => {},
    watermark: async () => null,
    now: () => NOW,
    coldStartLookbackMs: 60 * 60_000,
  });
  assert.equal(queried?.toISOString(), "2026-08-07T11:00:00.000Z");
});
