/**
 * What the keeper promises: the note ends up at the bottom, it is never
 * duplicated for long, and a chatty channel does not turn it into a firehose.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { STICKY_SETTING_KEY, type StickyDoc } from "@sbr/guild-config";
import { createStickyKeeper, STICKY_CACHE_MS, STICKY_QUIET_MS, type StickyDeps } from "./sticky.js";

const GUILD = "g1";
const CHANNEL = "chan-1";

const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLog;
  },
} as unknown as StickyDeps["log"];

interface Harness {
  readonly keeper: ReturnType<typeof createStickyKeeper>;
  readonly posts: { channelId: string; content: string }[];
  readonly removed: string[];
  readonly reads: number[];
  set(doc: StickyDoc | null): void;
  advance(ms: number): void;
  fail(on: boolean): void;
  breakPosting(on: boolean): void;
}

function harness(initial: StickyDoc | null = { stickies: [{ channelId: CHANNEL, content: "Read the rules.", enabled: true }] }): Harness {
  let stored = initial;
  let clock = 5_000_000;
  let failing = false;
  let postBroken = false;
  let nextId = 1;
  const posts: { channelId: string; content: string }[] = [];
  const removed: string[] = [];
  const reads: number[] = [];

  const keeper = createStickyKeeper({
    config: {
      async getSetting(_guildId: string, key: string) {
        assert.equal(key, STICKY_SETTING_KEY);
        reads.push(clock);
        if (failing) throw new Error("db down");
        return stored as never;
      },
    } as unknown as StickyDeps["config"],
    async post(channelId, content) {
      if (postBroken) return null;
      posts.push({ channelId, content });
      return `m${String(nextId++)}`;
    },
    async remove(_channelId, messageId) {
      removed.push(messageId);
    },
    log: silentLog,
    now: () => clock,
  });

  return {
    keeper,
    posts,
    removed,
    reads,
    set(doc) {
      stored = doc;
    },
    advance(ms) {
      clock += ms;
    },
    fail(on) {
      failing = on;
    },
    breakPosting(on) {
      postBroken = on;
    },
  };
}

test("the first message in a sticky channel posts the note", async () => {
  const h = harness();
  assert.equal(await h.keeper.onMessage(GUILD, CHANNEL), true);
  assert.deepEqual(h.posts, [{ channelId: CHANNEL, content: "Read the rules." }]);
  assert.deepEqual(h.removed, []);
});

test("a repost posts before it deletes, so the note is never briefly missing", async () => {
  const h = harness();
  await h.keeper.onMessage(GUILD, CHANNEL);
  h.advance(STICKY_QUIET_MS + 1);
  await h.keeper.onMessage(GUILD, CHANNEL);

  assert.equal(h.posts.length, 2);
  assert.deepEqual(h.removed, ["m1"]);
});

test("a busy channel is left alone until the quiet window passes", async () => {
  const h = harness();
  await h.keeper.onMessage(GUILD, CHANNEL);
  for (let i = 0; i < 30; i += 1) {
    h.advance(100);
    assert.equal(await h.keeper.onMessage(GUILD, CHANNEL), false);
  }
  assert.equal(h.posts.length, 1);
  // And none of those messages cost a settings read.
  assert.equal(h.reads.length, 1);
});

test("a channel with no sticky is cheap and silent", async () => {
  const h = harness({ stickies: [{ channelId: "elsewhere", content: "x", enabled: true }] });
  assert.equal(await h.keeper.onMessage(GUILD, CHANNEL), false);
  assert.deepEqual(h.posts, []);
});

test("a sticky switched off stops being reposted", async () => {
  const h = harness({ stickies: [{ channelId: CHANNEL, content: "paused", enabled: false }] });
  assert.equal(await h.keeper.onMessage(GUILD, CHANNEL), false);
  assert.deepEqual(h.posts, []);
});

test("a sticky configured away is taken down on the next message", async () => {
  const h = harness();
  await h.keeper.onMessage(GUILD, CHANNEL);

  h.set({ stickies: [] });
  h.keeper.invalidate(GUILD);
  h.advance(STICKY_QUIET_MS + 1);

  assert.equal(await h.keeper.onMessage(GUILD, CHANNEL), false);
  assert.deepEqual(h.removed, ["m1"]);
  // And it is not taken down twice.
  h.advance(STICKY_QUIET_MS + 1);
  await h.keeper.onMessage(GUILD, CHANNEL);
  assert.deepEqual(h.removed, ["m1"]);
});

test("the document is read at most once per cache window", async () => {
  const h = harness({ stickies: [] });
  for (let i = 0; i < 5; i += 1) {
    h.advance(1_000);
    await h.keeper.onMessage(GUILD, CHANNEL);
  }
  assert.equal(h.reads.length, 1);

  h.advance(STICKY_CACHE_MS);
  await h.keeper.onMessage(GUILD, CHANNEL);
  assert.equal(h.reads.length, 2);
});

test("a failed read reuses the last good document rather than stopping every sticky", async () => {
  const h = harness();
  await h.keeper.onMessage(GUILD, CHANNEL);

  h.fail(true);
  h.advance(STICKY_CACHE_MS + 1);
  assert.equal(await h.keeper.onMessage(GUILD, CHANNEL), true);
  assert.equal(h.posts.length, 2);
});

test("a failed first read does nothing at all — an unknown document is not an empty one", async () => {
  const h = harness();
  h.fail(true);
  assert.equal(await h.keeper.onMessage(GUILD, CHANNEL), false);
  assert.deepEqual(h.posts, []);
  assert.deepEqual(h.removed, []);
});

test("a post that does not land leaves the old message alone", async () => {
  const h = harness();
  await h.keeper.onMessage(GUILD, CHANNEL);

  h.breakPosting(true);
  h.advance(STICKY_QUIET_MS + 1);
  assert.equal(await h.keeper.onMessage(GUILD, CHANNEL), false);
  // The previous sticky is still the live one, so it was not deleted.
  assert.deepEqual(h.removed, []);
});

test("apply posts at once, ignoring the quiet window and the cache", async () => {
  const h = harness({ stickies: [] });
  await h.keeper.onMessage(GUILD, CHANNEL);

  h.set({ stickies: [{ channelId: CHANNEL, content: "brand new", enabled: true }] });
  assert.equal(await h.keeper.apply(GUILD, CHANNEL), true);
  assert.equal(h.posts.at(-1)?.content, "brand new");
});

test("apply on a cleared channel takes the old message down and reports it", async () => {
  const h = harness();
  await h.keeper.onMessage(GUILD, CHANNEL);

  h.set({ stickies: [] });
  assert.equal(await h.keeper.apply(GUILD, CHANNEL), true);
  assert.deepEqual(h.removed, ["m1"]);

  // Nothing configured and nothing posted: there is no change to report.
  assert.equal(await h.keeper.apply(GUILD, CHANNEL), false);
});
