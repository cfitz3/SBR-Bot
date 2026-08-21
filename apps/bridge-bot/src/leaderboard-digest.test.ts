/**
 * The digest's promises: an unbound slot is a refusal and not an error, empty
 * boards are left out rather than posted blank, one unreadable board does not
 * cost the others theirs, nobody is badged as the viewer, and a channel the bot
 * cannot post in is reported as such rather than as a success.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmbedView, LeaderboardCategory, LeaderboardPageDTO } from "@sbr/shared-types";
import { CATEGORY_SPECS } from "@sbr/leaderboards";
import {
  DIGEST_CATEGORIES,
  DIGEST_PAGE_SIZE,
  LeaderboardDigest,
  type LeaderboardDigestDeps,
} from "./leaderboard-digest.js";

const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLog;
  },
} as unknown as LeaderboardDigestDeps["log"];

function page(category: LeaderboardCategory, entries: number): LeaderboardPageDTO {
  return {
    category,
    spec: CATEGORY_SPECS[category],
    entries: Array.from({ length: entries }, (_, i) => ({
      key: `k${String(i)}`,
      label: `Member${String(i)}`,
      value: 100 - i,
      at: null,
      rank: i + 1,
      isViewer: false,
    })),
    page: 1,
    pageCount: 1,
    totalRanked: entries,
    windowDays: null,
    viewer: null,
    oldestReadingAt: null,
  };
}

function harness(
  options: {
    channel?: string | null;
    entriesFor?: (category: LeaderboardCategory) => number;
    failOn?: LeaderboardCategory;
    postOk?: boolean;
  } = {},
) {
  const posted: { channelId: string; embed: EmbedView }[] = [];
  const asked: { category: LeaderboardCategory; discordId: string; pageSize: number | undefined }[] = [];
  const digest = new LeaderboardDigest({
    leaderboards: {
      async page(query) {
        asked.push({ category: query.category, discordId: query.discordId, pageSize: query.pageSize });
        if (options.failOn === query.category) throw new Error("source is down");
        return page(query.category, options.entriesFor?.(query.category) ?? 3);
      },
    },
    getChannel: async () => (options.channel === undefined ? "c1" : options.channel),
    discord: {
      async post(channelId, embed) {
        if (options.postOk === false) return false;
        posted.push({ channelId, embed });
        return true;
      },
    },
    log: silentLog,
  });
  return { digest, posted, asked };
}

test("an unbound leaderboard channel is a refusal, not a failure", async () => {
  const { digest, posted } = harness({ channel: null });
  const result = await digest.publish("g1");
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.problem, "NO_CHANNEL");
  assert.equal(posted.length, 0);
});

test("a digest posts one message per category with anything on it", async () => {
  const { digest, posted } = harness();
  const result = await digest.publish("g1");
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.posted, DIGEST_CATEGORIES.length);
  assert.equal(posted.length, DIGEST_CATEGORIES.length);
  assert.ok(posted.every((p) => p.channelId === "c1"));
});

test("an empty board is left out rather than posted blank", async () => {
  const { digest, posted } = harness({
    entriesFor: (category) => (category === "wealth" ? 0 : 2),
  });
  const result = await digest.publish("g1");
  assert.equal(result.ok, true);
  assert.equal(posted.length, DIGEST_CATEGORIES.length - 1);
});

test("a guild with nobody ranked anywhere posts nothing at all", async () => {
  const { digest, posted } = harness({ entriesFor: () => 0 });
  const result = await digest.publish("g1");
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.problem, "NOTHING_RANKED");
  assert.equal(posted.length, 0);
});

test("one unreadable board does not cost the others theirs", async () => {
  const { digest, posted } = harness({ failOn: "catacombs" });
  const result = await digest.publish("g1");
  assert.equal(result.ok, true);
  assert.equal(posted.length, DIGEST_CATEGORIES.length - 1);
});

test("the digest asks for a page size and for no viewer", async () => {
  const { digest, asked } = harness();
  await digest.publish("g1");
  assert.deepEqual(
    asked.map((a) => a.category),
    [...DIGEST_CATEGORIES],
  );
  // No reader means no row is "yours": an id nobody has is what keeps every
  // `isViewer` false instead of badging whoever happens to be first.
  assert.ok(asked.every((a) => a.discordId === ""));
  assert.ok(asked.every((a) => a.pageSize === DIGEST_PAGE_SIZE));
});

test("a channel the bot cannot post in is reported, not counted as posted", async () => {
  const { digest } = harness({ postOk: false });
  const result = await digest.publish("g1");
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.problem, "NOT_POSTED");
});
