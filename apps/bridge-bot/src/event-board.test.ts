/**
 * The event message's promises: it is posted once and edited for the rest of
 * the event's life, it carries the signup buttons for exactly as long as
 * signing up means something, it heals when the message it remembers has been
 * deleted, it never posts another server's event into this one's channel, and a
 * finished event gets exactly one result card.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionRowView, EmbedView } from "@sbr/shared-types";
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
    description: null,
    hostDiscordId: null,
    capacity: null,
    going: [],
    maybe: [],
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
  const posted: { channelId: string; embed: EmbedView; components: readonly ActionRowView[] }[] = [];
  const edited: {
    channelId: string;
    messageId: string;
    embed: EmbedView;
    components: readonly ActionRowView[];
  }[] = [];
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
      async post(channelId, embed, components) {
        posted.push({ channelId, embed, components: components ?? [] });
        return options.postId === undefined ? "msg-1" : options.postId;
      },
      async edit(channelId, messageId, embed, components) {
        edited.push({ channelId, messageId, embed, components: components ?? [] });
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
  assert.equal(h.posted[0]?.embed.title, "Dungeon night");
  assert.match(String(h.posted[0]?.embed.description), /Live now/);
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

/**
 * The merge, asserted from both ends: a scheduled event gets the message that
 * used to be a separate signup post, and it is the same message the standings
 * later appear in.
 */
test("a scheduled event is posted as the signup sheet, buttons and all", async () => {
  const h = harness({
    event: row({ status: "SCHEDULED", going: [{ discordId: "u1" }], maybe: [{ discordId: "u2" }] }),
  });

  const result = await h.gateway.publish("g1", "e1");
  assert.equal(result.ok, true);
  assert.equal(h.posted.length, 1);
  const names = (h.posted[0]?.embed.fields ?? []).map((f) => f.name);
  assert.ok(names.includes("Who's coming"), "the signup message shows who is coming");
  assert.ok(!names.includes("Standings"), "and nothing to rank before it starts");
  assert.deepEqual(
    (h.posted[0]?.components ?? []).flatMap((r) => r.buttons.map((b) => b.customId)),
    ["rsvp:e1:GOING", "rsvp:e1:MAYBE", "rsvp:e1:NOT_GOING"],
  );
});

test("the same message becomes the leaderboard, in place", async () => {
  const h = harness({
    event: row({ channelId: "chan-1", messageId: "msg-9" }),
    standings: [{ discordId: "111", uuid: "u1", delta: 3 }],
  });

  const result = await h.gateway.publish("g1", "e1");
  assert.equal(result.ok && result.edited, true);
  assert.equal(h.posted.length, 0);
  const names = (h.edited[0]?.embed.fields ?? []).map((f) => f.name);
  assert.ok(names.includes("Standings"));
  assert.ok(!names.includes("Who's coming"));
});

/**
 * A button that can no longer mean anything must not be pressable. The empty
 * row is sent rather than omitted, because omitting it leaves the buttons on
 * the message Discord already has.
 */
test("a finished event's message loses its buttons in the same edit", async () => {
  const h = harness({ event: row({ status: "COMPLETED", channelId: "chan-1", messageId: "msg-9" }) });

  await h.gateway.publish("g1", "e1");
  assert.deepEqual(h.edited[0]?.components, []);
});

test("a cancelled event's message loses them too", async () => {
  const h = harness({ event: row({ status: "CANCELLED", channelId: "chan-1", messageId: "msg-9" }) });

  await h.gateway.publish("g1", "e1");
  assert.deepEqual(h.edited[0]?.components, []);
});

test("a completed event's board is marked final so it is written once", async () => {
  const h = harness({ event: row({ status: "COMPLETED", channelId: "chan-1", messageId: "msg-9" }) });

  const result = await h.gateway.publish("g1", "e1");
  assert.equal(result.ok && result.final, true);
  assert.match(String(h.edited[0]?.embed.description), /Finished/);
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

/**
 * An event is one activity now, so a card is one table. A row created before
 * that could name several metrics, and the first is the one its board has been
 * sorting by — keeping that one means the ranking members have been watching
 * does not silently change on the day this ships.
 */
test("a legacy multi-metric event is scored on the metric its board already ranked", async () => {
  const h = harness({ event: row({ trackedMetrics: ["networth", "catacombsLevel"] }) });

  const result = await h.gateway.publish("g1", "e1");
  assert.equal(result.ok, true);
  assert.deepEqual(h.asked, [{ eventId: "e1", metric: "networth" }]);
  const scoring = (h.posted[0]?.embed.fields ?? []).find((f) => f.name === "Scoring");
  assert.equal(scoring?.value, "networth");
});

test("a metric the tracker does not recognise is skipped, not rendered empty", async () => {
  // An empty table under "weight" reads as "nobody has gained any weight yet"
  // about a metric that was never polled at all.
  const h = harness({ event: row({ trackedMetrics: ["notAMetric", "catacombsLevel"] }) });

  await h.gateway.publish("g1", "e1");
  assert.deepEqual(h.asked, [{ eventId: "e1", metric: "catacombsLevel" }]);
});

test("participants with no linked account are named rather than dropped", async () => {
  const h = harness({ unlinked: [{ discordId: "u9" }] });

  await h.gateway.publish("g1", "e1");
  const field = (h.posted[0]?.embed.fields ?? []).find((f) => f.name === "Not scored");
  assert.ok(field !== undefined);
  assert.match(field.value, /u9/);
});

test("the prize is one line in the details rather than a field of its own", async () => {
  const h = harness({ event: row({ prize: "500k coins", hostDiscordId: "u7" }) });

  await h.gateway.publish("g1", "e1");
  const details = (h.posted[0]?.embed.fields ?? []).find((f) => f.name === "Details");
  assert.match(details?.value ?? "", /500k coins/);
  assert.match(details?.value ?? "", /<@u7>/);
});

test("an event tracking nothing still gets a message, without a standings query", async () => {
  const h = harness({ event: row({ trackedMetrics: [] }) });

  const result = await h.gateway.publish("g1", "e1");
  assert.equal(result.ok, true);
  assert.deepEqual(h.asked, []);
});
