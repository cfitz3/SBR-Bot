/**
 * The shipper's job is to survive a storm without becoming one. These cover the
 * three hazards its header names: volume, rate limits, and recursion.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger } from "./logger.js";
import { createLogShipper, SHIP_MAX_DISTINCT } from "./shipper.js";

function record(msg: string, fields: Record<string, unknown> = {}) {
  return { level: "error" as const, time: "2026-08-21T00:00:00.000Z", name: "svc", msg, fields };
}

/** A shipper whose timer never fires, so each test flushes deliberately. */
function shipper(overrides: { maxEntries?: number } = {}) {
  const posts: string[] = [];
  const s = createLogShipper({
    service: "test-bot",
    windowMs: 60 * 60_000,
    ...(overrides.maxEntries === undefined ? {} : { maxEntries: overrides.maxEntries }),
    async post(text) {
      posts.push(text);
    },
  });
  return { posts, ...s };
}

test("nothing buffered is nothing posted", async () => {
  const s = shipper();
  assert.equal(await s.flush(), false);
  assert.equal(s.posts.length, 0);
  s.stop();
});

test("the same line a hundred times is one entry with a count", async () => {
  const s = shipper();
  for (let i = 0; i < 100; i += 1) s.sink(record("redis unreachable"));

  assert.equal(await s.flush(), true);
  assert.equal(s.posts.length, 1);
  const text = s.posts[0] ?? "";
  assert.match(text, /redis unreachable ×100/);
  // The header counts records, not distinct messages.
  assert.match(text, /100 log records/);
  s.stop();
});

test("a whole window is one post, not one per record", async () => {
  const s = shipper();
  s.sink(record("first"));
  s.sink(record("second"));
  s.sink(record("third"));

  await s.flush();
  assert.equal(s.posts.length, 1);
  const text = s.posts[0] ?? "";
  for (const msg of ["first", "second", "third"]) assert.ok(text.includes(msg), msg);
  s.stop();
});

test("distinct messages past the entry cap are counted rather than printed", async () => {
  const s = shipper({ maxEntries: 2 });
  s.sink(record("a"));
  s.sink(record("a"));
  s.sink(record("b"));
  s.sink(record("b"));
  s.sink(record("c"));

  await s.flush();
  const text = s.posts[0] ?? "";
  assert.match(text, /and 1 other distinct message/);
  s.stop();
});

test("the buffer stops growing at the distinct cap", async () => {
  const s = shipper();
  for (let i = 0; i < SHIP_MAX_DISTINCT + 25; i += 1) s.sink(record(`unique-${i}`));

  await s.flush();
  assert.match(s.posts[0] ?? "", /25 more dropped past the buffer cap/);
  s.stop();
});

test("the error field rides along; the rest of the bag does not", async () => {
  const s = shipper();
  s.sink(record("write failed", { error: "ECONNRESET", guildId: "g-1", attempt: 3 }));

  await s.flush();
  const text = s.posts[0] ?? "";
  assert.match(text, /write failed — ECONNRESET/);
  assert.ok(!text.includes("g-1"), "field bag should not be serialised onto the line");
  s.stop();
});

test("a failed post is swallowed, and the buffer is not replayed into the next one", async () => {
  const posts: string[] = [];
  let fail = true;
  const s = createLogShipper({
    service: "test-bot",
    windowMs: 60 * 60_000,
    async post(text) {
      if (fail) throw new Error("discord said no");
      posts.push(text);
    },
  });

  s.sink(record("first"));
  assert.equal(await s.flush(), true);

  fail = false;
  s.sink(record("second"));
  await s.flush();

  assert.equal(posts.length, 1);
  // The dropped batch is gone rather than repeated an hour later.
  assert.ok(!(posts[0] ?? "").includes("first"));
  s.stop();
});

test("the composed message stays inside Discord's limit", async () => {
  const s = shipper({ maxEntries: 200 });
  for (let i = 0; i < 200; i += 1) s.sink(record(`a long enough message to add up quickly — number ${i}`));

  await s.flush();
  assert.ok((s.posts[0] ?? "").length < 2000, "must fit in one Discord message");
  s.stop();
});

test("wired to a logger, only records at or above the sink level reach it", async () => {
  const s = shipper();
  const log = createLogger({ level: "error", name: "svc", sink: s.sink, sinkLevel: "warn" });

  log.debug("noise");
  log.info("also noise");
  log.warn("worth shipping");
  log.error("definitely worth shipping");

  await s.flush();
  const text = s.posts[0] ?? "";
  assert.ok(!text.includes("noise"), "below-threshold records must not ship");
  assert.match(text, /worth shipping/);
  assert.match(text, /definitely worth shipping/);
  s.stop();
});
