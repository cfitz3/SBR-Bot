/**
 * The announcer's contract: post once, flip the flag after, retry what didn't
 * land, keep what has nowhere to go, and never let one guild's missing channel
 * block another guild's queue.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmbedView, PendingMilestoneDTO } from "@sbr/shared-types";
import { announceMilestonesOnce, type MilestoneAnnouncerDeps } from "./milestones.js";

const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLog;
  },
} as unknown as MilestoneAnnouncerDeps["log"];

function milestone(over: Partial<PendingMilestoneDTO> = {}): PendingMilestoneDTO {
  return {
    id: "m1",
    guildId: "g1",
    discordId: "111",
    ign: "Refraction",
    label: "1b networth",
    type: "NETWORTH_THRESHOLD",
    metric: "networth",
    thresholdValue: 1e9,
    achievedAt: "2026-08-09T12:00:00.000Z",
    ...over,
  };
}

interface Recorded {
  readonly channelId: string;
  readonly embed: EmbedView;
  readonly mention: string | null;
}

function deps(
  pending: readonly PendingMilestoneDTO[],
  over: {
    channels?: Record<string, string | null>;
    postResult?: (m: Recorded) => boolean;
  } = {},
): MilestoneAnnouncerDeps & { readonly sent: Recorded[]; readonly marked: string[] } {
  const sent: Recorded[] = [];
  const marked: string[] = [];
  return {
    sent,
    marked,
    milestones: {
      // Honours the exclusion and the announced flag the same way the query
      // does, so a test can tell "asked again without that guild" apart from
      // "asked again", and a second pass cannot re-post a settled row.
      async listPending(limit, excludeGuildIds = []) {
        return pending
          .filter((m) => !excludeGuildIds.includes(m.guildId) && !marked.includes(m.id))
          .slice(0, limit);
      },
      async markAnnounced(ids) {
        marked.push(...ids);
        return ids.length;
      },
    },
    async getChannel(guildId) {
      return over.channels === undefined ? "c1" : over.channels[guildId] ?? null;
    },
    async post(channelId, embed, mention) {
      const record = { channelId, embed, mention };
      const ok = over.postResult?.(record) ?? true;
      if (ok) sent.push(record);
      return ok;
    },
    log: silentLog,
  };
}

test("posts a pending milestone and marks it announced", async () => {
  const d = deps([milestone()]);
  assert.equal(await announceMilestonesOnce(d), 1);
  assert.equal(d.sent.length, 1);
  assert.equal(d.sent[0]?.channelId, "c1");
  assert.deepEqual(d.marked, ["m1"]);
});

test("the embed names the member and only pings that one person", async () => {
  const d = deps([milestone()]);
  await announceMilestonesOnce(d);
  const embed = d.sent[0]?.embed;
  assert.match(embed?.description ?? "", /Refraction/);
  assert.match(embed?.description ?? "", /1b networth/);
  assert.equal(d.sent[0]?.mention, "111");
});

test("an unlinked account is still announced, without a mention", async () => {
  const d = deps([milestone({ discordId: null, ign: "Ghost" })]);
  assert.equal(await announceMilestonesOnce(d), 1);
  assert.equal(d.sent[0]?.mention, null);
  assert.doesNotMatch(d.sent[0]?.embed.description ?? "", /<@/);
});

test("a failed post stays pending so the next pass retries it", async () => {
  const d = deps([milestone()], { postResult: () => false });
  assert.equal(await announceMilestonesOnce(d), 0);
  assert.deepEqual(d.marked, []);
});

test("a milestone for a guild with no channel stays pending", async () => {
  const d = deps([milestone({ id: "m1", guildId: "g1" }), milestone({ id: "m2", guildId: "g2" })], {
    channels: { g2: "c2" },
  });
  assert.equal(await announceMilestonesOnce(d), 1);
  assert.deepEqual(d.sent.map((s) => s.channelId), ["c2"]);
  // Only the posted one settles. m1 waits for somebody to bind a channel, which
  // is the whole reason the Health page counts it.
  assert.deepEqual(d.marked, ["m2"]);
});

test("an unconfigured guild at the head of the queue does not starve the rest", async () => {
  // g1 owns the entire first page. If the pass consumed a page and stopped, g2
  // would never be reached, today or on any later pass.
  const d = deps(
    [
      milestone({ id: "m1", guildId: "g1" }),
      milestone({ id: "m2", guildId: "g1" }),
      milestone({ id: "m3", guildId: "g2" }),
    ],
    { channels: { g2: "c2" } },
  );
  assert.equal(await announceMilestonesOnce(d, 2), 1);
  assert.deepEqual(d.marked, ["m3"]);
});

test("a guild with no channel is asked about once, however many rows it has", async () => {
  const d = deps([milestone({ id: "m1" }), milestone({ id: "m2" }), milestone({ id: "m3" })], {
    channels: {},
  });
  let lookups = 0;
  const counted: MilestoneAnnouncerDeps = {
    ...d,
    async getChannel(guildId) {
      lookups += 1;
      return d.getChannel(guildId);
    },
  };
  assert.equal(await announceMilestonesOnce(counted), 0);
  assert.equal(lookups, 1);
  assert.deepEqual(d.marked, []);
});

test("one channel lookup per guild, not per milestone", async () => {
  const d = deps([milestone({ id: "m1" }), milestone({ id: "m2" }), milestone({ id: "m3" })]);
  let lookups = 0;
  const counted: MilestoneAnnouncerDeps = {
    ...d,
    async getChannel(guildId) {
      lookups += 1;
      return d.getChannel(guildId);
    },
  };
  await announceMilestonesOnce(counted);
  assert.equal(lookups, 1);
});

test("an empty queue does no work at all", async () => {
  const d = deps([]);
  assert.equal(await announceMilestonesOnce(d), 0);
  assert.deepEqual(d.marked, []);
});
