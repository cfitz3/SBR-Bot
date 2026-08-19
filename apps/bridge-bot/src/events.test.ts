/**
 * Two halves of one path: what the bus will accept off the wire, and what the
 * bridge does with it once it has. The parse tests matter more than they look —
 * this payload decides who gets pinged, so anything that is not a snowflake has
 * to be gone before it reaches `allowedMentions`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBridgeBusMessage, type EventReminderMessage } from "@sbr/redis";
import type { EmbedView } from "@sbr/shared-types";
import { deliverEventReminder, REMINDER_MENTION_LIMIT, type EventReminderDeps } from "./events.js";

const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLog;
  },
} as unknown as EventReminderDeps["log"];

function message(over: Partial<EventReminderMessage> = {}): EventReminderMessage {
  return {
    kind: "event-reminder",
    guildId: "g1",
    eventId: "e1",
    title: "Dungeon night",
    startsAt: "2026-08-19T20:00:00.000Z",
    offsetMinutes: 15,
    discordIds: ["111111111111111111"],
    ...over,
  };
}

interface Posted {
  readonly channelId: string;
  readonly embed: EmbedView;
  readonly mentions: readonly string[];
}

function deps(over: { channel?: string | null; ok?: boolean } = {}) {
  const posts: Posted[] = [];
  const d: EventReminderDeps = {
    async getChannel() {
      return over.channel === undefined ? "chan-1" : over.channel;
    },
    async post(channelId, embed, mentions) {
      posts.push({ channelId, embed, mentions });
      return over.ok ?? true;
    },
    log: silentLog,
  };
  return { deps: d, posts };
}

test("posts the reminder into the guild's events channel, pinging the attendees", async () => {
  const h = deps();

  assert.equal(await deliverEventReminder(h.deps, message()), true);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0]?.channelId, "chan-1");
  assert.deepEqual(h.posts[0]?.mentions, ["111111111111111111"]);
  assert.match(String(h.posts[0]?.embed.title), /Dungeon night/);
  assert.match(String(h.posts[0]?.embed.title), /in 15 minutes/);
});

test("says 'in 1 hour' rather than 'in 60 minutes'", async () => {
  const h = deps();

  await deliverEventReminder(h.deps, message({ offsetMinutes: 60 }));
  assert.match(String(h.posts[0]?.embed.title), /in 1 hour/);
});

test("drops the reminder when the guild has bound no events channel", async () => {
  const h = deps({ channel: null });

  assert.equal(await deliverEventReminder(h.deps, message()), false);
  assert.equal(h.posts.length, 0);
});

test("reports a post that did not land", async () => {
  const h = deps({ ok: false });

  assert.equal(await deliverEventReminder(h.deps, message()), false);
  assert.equal(h.posts.length, 1);
});

test("posts without mentions rather than pinging a crowd", async () => {
  const h = deps();
  const many = Array.from({ length: REMINDER_MENTION_LIMIT + 1 }, (_, i) => `${100000000000000000 + i}`);

  assert.equal(await deliverEventReminder(h.deps, message({ discordIds: many })), true);
  assert.deepEqual(h.posts[0]?.mentions, []);
});

test("a thrown post is a false, not a crash", async () => {
  const d: EventReminderDeps = {
    async getChannel() {
      return "chan-1";
    },
    async post() {
      throw new Error("discord said no");
    },
    log: silentLog,
  };

  assert.equal(await deliverEventReminder(d, message()), false);
});

test("parseBridgeBusMessage accepts a well-formed reminder", () => {
  const parsed = parseBridgeBusMessage(JSON.stringify(message()));
  assert.deepEqual(parsed, message());
});

test("parseBridgeBusMessage drops ids that are not snowflakes", () => {
  const raw = JSON.stringify(message({ discordIds: ["111111111111111111", "<@everyone>", "", "42"] as string[] }));
  const parsed = parseBridgeBusMessage(raw);
  assert.deepEqual(parsed?.discordIds, ["111111111111111111"]);
});

test("parseBridgeBusMessage refuses anything malformed", () => {
  const bad = [
    "not json",
    JSON.stringify({ kind: "something-else", guildId: "g1" }),
    JSON.stringify({ ...message(), guildId: "" }),
    JSON.stringify({ ...message(), eventId: 7 }),
    JSON.stringify({ ...message(), title: "" }),
    JSON.stringify({ ...message(), startsAt: "not a date" }),
    JSON.stringify({ ...message(), offsetMinutes: "15" }),
  ];
  for (const raw of bad) assert.equal(parseBridgeBusMessage(raw), null, raw);
});

test("a reminder with no attendee list is still delivered", async () => {
  const h = deps();
  const parsed = parseBridgeBusMessage(JSON.stringify({ ...message(), discordIds: undefined }));

  assert.deepEqual(parsed?.discordIds, []);
  assert.equal(await deliverEventReminder(h.deps, parsed!), true);
  assert.deepEqual(h.posts[0]?.mentions, []);
});
