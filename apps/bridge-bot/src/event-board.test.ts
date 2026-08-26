/**
 * The board's promises: it edits rather than re-posts, it heals when the
 * message it remembers has been deleted, it never posts another server's event
 * into this one's channel, and a finished event gets exactly one result card.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmbedView } from "@sbr/shared-types";
import {
  EventBoardGateway,
  type EventBoardGatewayDeps,
  type EventBoardRow,
  type EventStanding,
} from "./event-board.js";

const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLog;
  },
} as unknown as EventBoardGatewayDeps["log"];

function row(over: Partial<EventBoardRow> = {}): EventBoardRow {
  return {
    id: "e1",
    guildId: "g1",
    title: "Dungeon night",
    status: "LIVE",
    startsAt: "2026-08-19T20:00:00.000Z",
    endsAt: null,
    channelId: null,
    messageId: null,
    trackedMetrics: ["catacombsLevel"],
    participantCount: 4,
    prize: null,
    ...over,
  };
}

interface Bound {
  readonly channelId: string;
  readonly messageId: string | null;
  readonly final: boolean;
}

function harness(
  options: {
    event?: EventBoardRow | null;
    standings?: readonly EventStanding[];
    channel?: string | null;
    unlinked?: readonly { readonly discordId: string }[];
    postId?: string | null;
    editOk?: boolean;
    orphan?: string | null;
  } = {},
) {
  const posted: { channelId: string; embed: EmbedView }[] = [];
  const edited: { channelId: string; messageId: string; embed: EmbedView }[] = [];
  const bound: Bound[] = [];
  const asked: { eventId: string; metric: string }[] = [];

  const deps: EventBoardGatewayDeps = {
    events: {
      async boardEvent() {
        return options.event === undefined ? row() : options.event;
      },
      async standings(eventId, metric) {
        asked.push({ eventId, metric });
        return options.standings ?? [];
      },
      async unlinkedParticipants() {
        return options.unlinked ?? [];
      },
      async bindBoardMessage(_eventId, channelId, messageId, final) {
        bound.push({ channelId, messageId, final });
      },
    },
    async getChannel() {
      return options.channel === undefined ? "chan-1" : options.channel;
    },
    discord: {
      async post(channelId, embed) {
        posted.push({ channelId, embed });
        return options.postId === undefined ? "msg-1" : options.postId;
      },
      async edit(channelId, messageId, embed) {
        edited.push({ channelId, messageId, embed });
        return options.editOk ?? true;
      },
      async findBoard() {
        return options.orphan ?? null;
      },
    },
    log: silentLog,
    now: () => new Date("2026-08-19T21:00:00.000Z"),
  };

  return { gateway: new EventBoardGateway(deps), posted, edited, bound, asked };
}

test("posts a live event's board into the guild's events channel", async () => {
  const h = harness({ standings: [{ discordId: "111", uuid: "u1", delta: 3 }] });

  const result = await h.gateway.publish("g1", "e1");
  assert.equal(result.ok, true);
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0]?.channelId, "chan-1");
  assert.match(String(h.posted[0]?.embed.title), /Dungeon night — live now/);
  assert.deepEqual(h.bound, [{ channelId: "chan-1", messageId: "msg-1", final: false }]);
});

test("edits the board it posted before rather than posting a second one", async () => {
  const h = harness({ event: row({ channelId: "chan-old", messageId: "msg-9" }) });

  const result = await h.gateway.publish("g1", "e1");
  assert.equal(result.ok && result.edited, true);
  assert.equal(h.posted.length, 0);
  assert.equal(h.edited[0]?.messageId, "msg-9");
  // The stored channel wins over the slot, so a rebound slot cannot orphan it.
  assert.equal(h.edited[0]?.channelId, "chan-old");
});

test("posts fresh when the remembered message has been deleted", async () => {
  const h = harness({ event: row({ channelId: "chan-old", messageId: "gone" }), editOk: false });

  const result = await h.gateway.publish("g1", "e1");
  assert.equal(result.ok && result.edited, false);
  assert.equal(h.posted.length, 1);
  assert.deepEqual(h.bound, [{ channelId: "chan-old", messageId: "msg-1", final: false }]);
});

test("un-records a board that could not be posted", async () => {
  const h = harness({ postId: null });

  const result = await h.gateway.publish("g1", "e1");
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.problem, "NOT_POSTED");
  assert.deepEqual(h.bound, [{ channelId: "chan-1", messageId: null, final: false }]);
});

test("refuses an event belonging to another server", async () => {
  const h = harness({ event: row({ guildId: "g2" }) });

  const result = await h.gateway.publish("g1", "e1");
  assert.equal(result.ok === false && result.problem, "NO_EVENT");
  assert.equal(h.posted.length, 0);
});

test("refuses an event that does not exist", async () => {
  const h = harness({ event: null });

  const result = await h.gateway.publish("g1", "e1");
  assert.equal(result.ok === false && result.problem, "NO_EVENT");
});

test("says so when the guild has bound no events channel", async () => {
  const h = harness({ channel: null });

  const result = await h.gateway.publish("g1", "e1");
  assert.equal(result.ok === false && result.problem, "NO_CHANNEL");
  assert.equal(h.posted.length, 0);
});

test("a scheduled event with no board yet is left alone", async () => {
  const h = harness({ event: row({ status: "SCHEDULED" }) });

  const result = await h.gateway.publish("g1", "e1");
  assert.equal(result.ok === false && result.problem, "NOT_TRACKED");
  assert.equal(h.posted.length, 0);
});

test("a completed event's board is marked final so it is written once", async () => {
  const h = harness({ event: row({ status: "COMPLETED", channelId: "chan-1", messageId: "msg-9" }) });

  const result = await h.gateway.publish("g1", "e1");
  assert.equal(result.ok && result.final, true);
  assert.match(String(h.edited[0]?.embed.title), /final results/);
  assert.deepEqual(h.bound, [{ channelId: "chan-1", messageId: "msg-9", final: true }]);
});

test("a board left orphaned by a crash is adopted rather than posted twice", async () => {
  // The window: `post` returned an id and the process died before
  // `bindBoardMessage` stored it, so Postgres says there is no board and
  // Discord has one. Without the adopt, the next pass posts a second.
  const h = harness({ orphan: "msg-orphan" });

  const result = await h.gateway.publish("g1", "e1");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.messageId, "msg-orphan");
  assert.equal(h.posted.length, 0);
  assert.deepEqual(
    h.edited.map((e) => e.messageId),
    ["msg-orphan"],
  );
  assert.deepEqual(
    h.bound.map((b) => b.messageId),
    ["msg-orphan"],
  );
});

test("an orphan that cannot be edited falls through to a fresh post", async () => {
  const h = harness({ orphan: "msg-orphan", editOk: false });

  const result = await h.gateway.publish("g1", "e1");
  assert.equal(result.ok, true);
  assert.equal(h.posted.length, 1);
});

test("every configured metric gets its own table, in the organiser's order", async () => {
  // The bug this replaced: the board asked for `trackedMetrics[0]` and rendered
  // one column, so a three-metric contest silently published a third of itself.
  const h = harness({ event: row({ trackedMetrics: ["networth", "catacombsLevel"] }) });

  const result = await h.gateway.publish("g1", "e1");
  assert.equal(result.ok, true);
  assert.deepEqual(h.asked, [
    { eventId: "e1", metric: "networth" },
    { eventId: "e1", metric: "catacombsLevel" },
  ]);
  const names = (h.posted[0]?.embed.fields ?? []).map((f) => f.name);
  assert.ok(names.some((n) => n.includes("networth")));
  assert.ok(names.some((n) => n.includes("catacombs level")));
});

test("a metric the tracker does not recognise is dropped, not rendered empty", async () => {
  // An empty table under "weight" reads as "nobody has gained any weight yet"
  // about a metric that was never polled at all.
  const h = harness({ event: row({ trackedMetrics: ["catacombsLevel", "notAMetric"] }) });

  await h.gateway.publish("g1", "e1");
  assert.deepEqual(h.asked, [{ eventId: "e1", metric: "catacombsLevel" }]);
});

test("participants with no linked account are named rather than dropped", async () => {
  const h = harness({ unlinked: [{ discordId: "u9" }] });

  await h.gateway.publish("g1", "e1");
  const field = (h.posted[0]?.embed.fields ?? []).find((f) => f.name.startsWith("Not scored"));
  assert.ok(field !== undefined);
  assert.match(field.value, /u9/);
});

test("the prize is shown on the board", async () => {
  const h = harness({ event: row({ prize: "500k coins" }) });

  await h.gateway.publish("g1", "e1");
  const field = (h.posted[0]?.embed.fields ?? []).find((f) => f.name === "Prize");
  assert.equal(field?.value, "500k coins");
});

test("an event tracking nothing still gets a board, without a standings query", async () => {
  const h = harness({ event: row({ trackedMetrics: [] }) });

  const result = await h.gateway.publish("g1", "e1");
  assert.equal(result.ok, true);
  assert.deepEqual(h.asked, []);
});
