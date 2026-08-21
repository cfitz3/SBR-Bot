/**
 * The hot-path properties: read rarely, answer once, and never widen a tag's
 * scope on the way through.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TicketTagDTO } from "@sbr/shared-types";
import {
  createAutoresponder,
  MAX_SCANNED_LENGTH,
  TAG_CACHE_MS,
  TAG_COOLDOWN_MS,
} from "./autoresponder.js";

const GUILD = "g1";
const CHANNEL = "chan-1";

function tag(over: Partial<TicketTagDTO> = {}): TicketTagDTO {
  return {
    id: "t1",
    guildId: GUILD,
    name: "link",
    content: "Run /link to connect your account.",
    autoPattern: "how do i link",
    scope: "SERVER",
    enabled: true,
    ...over,
  };
}

interface Harness {
  readonly responder: ReturnType<typeof createAutoresponder>;
  readonly reads: number[];
  set(tags: readonly TicketTagDTO[]): void;
  advance(ms: number): void;
  fail(on: boolean): void;
}

function harness(initial: readonly TicketTagDTO[] = [tag()]): Harness {
  let tags = [...initial];
  let clock = 1_000_000;
  let failing = false;
  const reads: number[] = [];

  const responder = createAutoresponder({
    async listTags() {
      reads.push(clock);
      if (failing) throw new Error("db down");
      return tags;
    },
    now: () => clock,
  });

  return {
    responder,
    reads,
    set(next) {
      tags = [...next];
    },
    advance(ms) {
      clock += ms;
    },
    fail(on) {
      failing = on;
    },
  };
}

test("a message matching a SERVER tag in an open channel is answered", async () => {
  const h = harness();
  const answer = await h.responder.respond(GUILD, CHANNEL, "hey, how do i link my account?", "SERVER");
  assert.equal(answer, "Run /link to connect your account.");
});

test("a SERVER tag does not fire inside a ticket, and a TICKET tag does not fire outside one", async () => {
  const h = harness([tag({ id: "server", scope: "SERVER" })]);
  assert.equal(await h.responder.respond(GUILD, CHANNEL, "how do i link", "TICKET"), null);

  const g = harness([tag({ id: "ticket", scope: "TICKET" })]);
  assert.equal(await g.responder.respond(GUILD, CHANNEL, "how do i link", "SERVER"), null);
});

test("ANY fires in both", async () => {
  const h = harness([tag({ scope: "ANY" })]);
  assert.ok(await h.responder.respond(GUILD, CHANNEL, "how do i link", "SERVER"));
  h.advance(TAG_COOLDOWN_MS);
  assert.ok(await h.responder.respond(GUILD, CHANNEL, "how do i link", "TICKET"));
});

test("a tag answers once per channel, then stays quiet for its cooldown", async () => {
  const h = harness();
  assert.ok(await h.responder.respond(GUILD, CHANNEL, "how do i link", "SERVER"));
  assert.equal(await h.responder.respond(GUILD, CHANNEL, "how do i link", "SERVER"), null);

  // A different channel is a different conversation and is answered.
  assert.ok(await h.responder.respond(GUILD, "chan-2", "how do i link", "SERVER"));

  h.advance(TAG_COOLDOWN_MS + 1);
  assert.ok(await h.responder.respond(GUILD, CHANNEL, "how do i link", "SERVER"));
});

test("the tag list is read at most once per cache window, however chatty the channel is", async () => {
  const h = harness();
  for (let i = 0; i < 20; i += 1) await h.responder.respond(GUILD, CHANNEL, "nothing to match", "SERVER");
  assert.equal(h.reads.length, 1);

  h.advance(TAG_CACHE_MS + 1);
  await h.responder.respond(GUILD, CHANNEL, "still nothing", "SERVER");
  assert.equal(h.reads.length, 2);
});

test("invalidate makes the next message re-read, so a panel edit takes effect at once", async () => {
  const h = harness();
  await h.responder.respond(GUILD, CHANNEL, "x", "SERVER");
  h.set([tag({ id: "t2", content: "Updated." })]);
  h.responder.invalidate(GUILD);

  assert.equal(await h.responder.respond(GUILD, CHANNEL, "how do i link", "SERVER"), "Updated.");
  assert.equal(h.reads.length, 2);
});

test("a failed read reuses the last good list rather than falling silent", async () => {
  const h = harness();
  await h.responder.respond(GUILD, CHANNEL, "x", "SERVER");

  h.fail(true);
  h.advance(TAG_CACHE_MS + 1);
  assert.equal(await h.responder.respond(GUILD, CHANNEL, "how do i link", "SERVER"), "Run /link to connect your account.");
});

test("a first read that fails answers nothing rather than throwing into the message path", async () => {
  const h = harness();
  h.fail(true);
  assert.equal(await h.responder.respond(GUILD, CHANNEL, "how do i link", "SERVER"), null);
});

test("a disabled tag and a tag with no pattern never fire", async () => {
  const off = harness([tag({ enabled: false })]);
  assert.equal(await off.responder.respond(GUILD, CHANNEL, "how do i link", "SERVER"), null);

  const bare = harness([tag({ autoPattern: null })]);
  assert.equal(await bare.responder.respond(GUILD, CHANNEL, "how do i link", "SERVER"), null);
});

test("a long paste is skipped without being matched against anything", async () => {
  const h = harness([tag({ autoPattern: "link" })]);
  const paste = `how do i link ${"x".repeat(MAX_SCANNED_LENGTH)}`;

  assert.equal(await h.responder.respond(GUILD, CHANNEL, paste, "SERVER"), null);
  assert.equal(await h.responder.respond(GUILD, CHANNEL, "", "SERVER"), null);
  // Neither one was worth a database read.
  assert.equal(h.reads.length, 0);
});
