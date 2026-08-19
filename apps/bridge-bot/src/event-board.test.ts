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
    postId?: string | null;
    editOk?: boolean;
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

test("orders the table by the first configured metric", async () => {
  const h = harness({ event: row({ trackedMetrics: ["networth", "catacombsLevel"] }) });

  await h.gateway.publish("g1", "e1");
  assert.deepEqual(h.asked, [{ eventId: "e1", metric: "networth" }]);
});

test("an event tracking nothing still gets a board, without a standings query", async () => {
  const h = harness({ event: row({ trackedMetrics: [] }) });

  const result = await h.gateway.publish("g1", "e1");
  assert.equal(result.ok, true);
  assert.deepEqual(h.asked, []);
});
