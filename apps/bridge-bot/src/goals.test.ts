/**
 * The goal watcher's contract: only stamp what the snapshots actually show,
 * stamp it whether or not the post lands, and never re-announce a settled row.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmbedView, ProgressMetric, StoredGoalDTO } from "@sbr/shared-types";
import { sweepGoalsOnce, type GoalWatcherDeps } from "./goals.js";

const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLog;
  },
} as unknown as GoalWatcherDeps["log"];

function row(over: Partial<StoredGoalDTO> = {}): StoredGoalDTO {
  return {
    id: "g1",
    guildId: "guild1",
    minecraftUuid: "uuid-1",
    discordId: "111",
    metric: "skyblockLevel",
    target: 250,
    startValue: 200,
    createdAt: "2026-08-01T00:00:00.000Z",
    achievedAt: null,
    ...over,
  };
}

interface Sent {
  readonly channelId: string;
  readonly embed: EmbedView;
  readonly mention: string | null;
}

function deps(
  rows: readonly StoredGoalDTO[],
  over: {
    values?: Record<string, number | null>;
    channels?: Record<string, string | null>;
    postOk?: boolean;
  } = {},
): GoalWatcherDeps & { readonly sent: Sent[]; readonly marked: string[] } {
  const sent: Sent[] = [];
  const marked: string[] = [];
  return {
    sent,
    marked,
    goals: {
      async listUnachieved(limit: number) {
        return rows.filter((r) => !marked.includes(r.id)).slice(0, limit);
      },
      async markAchieved(ids: readonly string[]) {
        marked.push(...ids);
        return ids.length;
      },
    },
    async currentValue(uuid: string, metric: ProgressMetric) {
      return over.values?.[`${uuid}:${metric}`] ?? null;
    },
    async ignFor(discordId: string) {
      return discordId === "111" ? "Refraction" : null;
    },
    async getChannel(guildId: string) {
      return over.channels === undefined ? "chan1" : (over.channels[guildId] ?? null);
    },
    async post(channelId: string, embed: EmbedView, mention: string | null) {
      sent.push({ channelId, embed, mention });
      return over.postOk ?? true;
    },
    log: silentLog,
  };
}

test("a goal whose metric has passed its target is announced and stamped", async () => {
  const d = deps([row()], { values: { "uuid-1:skyblockLevel": 251 } });

  assert.equal(await sweepGoalsOnce(d), 1);
  assert.deepEqual(d.marked, ["g1"]);
  assert.equal(d.sent.length, 1);
  assert.equal(d.sent[0]?.mention, "111");
  assert.match(String(d.sent[0]?.embed.description), /Refraction/);
});

test("a goal short of its target is left alone", async () => {
  const d = deps([row()], { values: { "uuid-1:skyblockLevel": 249 } });

  assert.equal(await sweepGoalsOnce(d), 0);
  assert.deepEqual(d.marked, []);
  assert.equal(d.sent.length, 0);
});

test("an account with no snapshot yet waits rather than counting as reached", async () => {
  const d = deps([row()]);

  assert.equal(await sweepGoalsOnce(d), 0);
  assert.deepEqual(d.marked, []);
});

test("a guild with no milestones channel still has the goal stamped", async () => {
  // The record lives on the row, so losing the post must not lose the fact —
  // and must not leave the row to be reconsidered forever.
  const d = deps([row()], { values: { "uuid-1:skyblockLevel": 300 }, channels: {} });

  assert.equal(await sweepGoalsOnce(d), 1);
  assert.deepEqual(d.marked, ["g1"]);
  assert.equal(d.sent.length, 0);
});

test("a post that does not land still stamps, and does not repeat next pass", async () => {
  const d = deps([row()], { values: { "uuid-1:skyblockLevel": 300 }, postOk: false });

  assert.equal(await sweepGoalsOnce(d), 1);
  assert.equal(d.sent.length, 1);
  assert.equal(await sweepGoalsOnce(d), 0);
  assert.equal(d.sent.length, 1);
});

test("a goal with no linked Discord id posts unnamed and unpinged", async () => {
  const d = deps([row({ discordId: null })], { values: { "uuid-1:skyblockLevel": 300 } });

  assert.equal(await sweepGoalsOnce(d), 1);
  assert.equal(d.sent[0]?.mention, null);
  assert.match(String(d.sent[0]?.embed.description), /A member/);
});

test("a failing snapshot read costs one row, not the pass", async () => {
  const d = deps([row({ id: "bad" }), row({ id: "good", minecraftUuid: "uuid-2" })], {
    values: { "uuid-2:skyblockLevel": 300 },
  });
  const boom = { ...d, currentValue: async (uuid: string, metric: ProgressMetric) =>
    uuid === "uuid-1" ? Promise.reject(new Error("db down")) : d.currentValue(uuid, metric) };

  assert.equal(await sweepGoalsOnce(boom), 1);
  assert.deepEqual(d.marked, ["good"]);
});
