/**
 * The level announcer's contract: the milestone rules plus the opt-out — an
 * opted-out row is cleared rather than posted, and clearing it must not be
 * mistaken for having announced something.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmbedView, PendingLevelUpDTO } from "@sbr/shared-types";
import { announceLevelUpsOnce, type LevelAnnouncerDeps } from "./levels.js";

const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLog;
  },
} as unknown as LevelAnnouncerDeps["log"];

function levelUp(over: Partial<PendingLevelUpDTO> = {}): PendingLevelUpDTO {
  return {
    id: "l1",
    guildId: "g1",
    discordId: "111",
    fromLevel: 4,
    toLevel: 5,
    totalXp: 2_400,
    achievedAt: "2026-08-19T12:00:00.000Z",
    ...over,
  };
}

interface Recorded {
  readonly channelId: string;
  readonly embed: EmbedView;
  readonly mention: string;
}

interface Harness {
  readonly deps: LevelAnnouncerDeps;
  readonly posts: Recorded[];
  readonly announced: string[];
}

function harness(
  rows: readonly PendingLevelUpDTO[],
  over: Partial<{
    channels: Record<string, string | null>;
    muted: Record<string, readonly string[]>;
    post: (r: Recorded) => boolean;
  }> = {},
): Harness {
  const posts: Recorded[] = [];
  const announced: string[] = [];
  let queue = [...rows];

  const deps: LevelAnnouncerDeps = {
    levels: {
      async listPending(limit, exclude = []) {
        const skip = new Set(exclude);
        return queue.filter((r) => !skip.has(r.guildId)).slice(0, limit);
      },
      async markAnnounced(ids) {
        announced.push(...ids);
        queue = queue.filter((r) => !ids.includes(r.id));
        return ids.length;
      },
    },
    async getChannel(guildId) {
      const channels = over.channels ?? { g1: "chan-1" };
      return channels[guildId] ?? null;
    },
    async mutedIds(guildId) {
      return new Set(over.muted?.[guildId] ?? []);
    },
    async post(channelId, embed, mention) {
      const recorded = { channelId, embed, mention };
      const ok = over.post?.(recorded) ?? true;
      if (ok) posts.push(recorded);
      return ok;
    },
    log: silentLog,
  };

  return { deps, posts, announced };
}

test("a pending level-up is posted to the guild's levels channel and then cleared", async () => {
  const h = harness([levelUp()]);
  const count = await announceLevelUpsOnce(h.deps);

  assert.equal(count, 1);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0]?.channelId, "chan-1");
  assert.equal(h.posts[0]?.mention, "111");
  assert.deepEqual(h.announced, ["l1"]);
});

test("the embed says where they came from, not just where they landed", async () => {
  const h = harness([levelUp({ fromLevel: 12, toLevel: 15 })]);
  await announceLevelUpsOnce(h.deps);

  const fields = h.posts[0]?.embed.fields ?? [];
  assert.equal(fields.find((f) => f.name === "Levels")?.value, "12 → 15");
});

test("somebody who opted out is cleared without being posted, and is not counted as announced", async () => {
  const h = harness([levelUp({ id: "l1", discordId: "111" }), levelUp({ id: "l2", discordId: "222" })], {
    muted: { g1: ["111"] },
  });

  const count = await announceLevelUpsOnce(h.deps);

  assert.equal(count, 1);
  assert.deepEqual(
    h.posts.map((p) => p.mention),
    ["222"],
  );
  // Both rows leave the queue: the opted-out one would otherwise be retried forever.
  assert.deepEqual([...h.announced].sort(), ["l1", "l2"]);
});

test("a post that does not land stays pending for the next pass", async () => {
  const h = harness([levelUp()], { post: () => false });
  const count = await announceLevelUpsOnce(h.deps);

  assert.equal(count, 0);
  assert.deepEqual(h.announced, []);
});

test("a guild with no levels channel keeps its rows and does not block another guild", async () => {
  const h = harness([levelUp({ id: "l1", guildId: "g-unset" }), levelUp({ id: "l2", guildId: "g1" })], {
    channels: { g1: "chan-1" },
  });

  const count = await announceLevelUpsOnce(h.deps);

  assert.equal(count, 1);
  assert.deepEqual(h.announced, ["l2"]);
  assert.deepEqual(
    h.posts.map((p) => p.channelId),
    ["chan-1"],
  );
});

test("the opt-out list is read once per guild, not once per row", async () => {
  const asked: string[] = [];
  const h = harness([levelUp({ id: "l1" }), levelUp({ id: "l2", discordId: "222" })]);
  const deps: LevelAnnouncerDeps = {
    ...h.deps,
    async mutedIds(guildId) {
      asked.push(guildId);
      return new Set<string>();
    },
  };

  await announceLevelUpsOnce(deps);
  assert.deepEqual(asked, ["g1"]);
});
