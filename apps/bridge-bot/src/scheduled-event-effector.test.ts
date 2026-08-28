/**
 * The mirror's one promise: it never costs the message.
 *
 * Every failure Discord or the admin bot can produce comes back as null, which
 * the gateway reads as "no reminder link on the card this pass". The event's
 * own message is unaffected, which is the whole reason this is a separate,
 * optional port rather than a step in publishing.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Logger } from "@sbr/observability";
import { createScheduledEventMirror } from "./scheduled-event-effector.js";
import type { ScheduledEventSpec } from "./event-board.js";

const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLog;
  },
} as unknown as Logger;

const SPEC: ScheduledEventSpec = {
  name: "Dungeon night",
  description: null,
  startsAt: "2026-08-19T23:00:00.000Z",
  endsAt: "2026-08-20T01:00:00.000Z",
  location: "Hypixel SkyBlock",
  status: "SCHEDULED",
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function stub(reply: { status?: number; json?: unknown } | Error): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> });
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return reply.json ?? {};
      },
    };
  }) as unknown as typeof globalThis.fetch;
  return sent;
}

function mirror(token: string | undefined = "t") {
  return createScheduledEventMirror({ baseUrl: "http://127.0.0.1:3011/", token, logger: silentLog });
}

/** Explicitly tokenless — `mirror(undefined)` would take the default instead. */
function tokenless() {
  return createScheduledEventMirror({ baseUrl: "http://127.0.0.1:3011/", token: undefined, logger: silentLog });
}

test("a create asks the admin bot and returns the id and the link", async () => {
  const sent = stub({ json: { ok: true, id: "gse-1", url: "https://discord.com/events/1/2" } });

  const ref = await mirror().scheduleEvent?.("g1", SPEC);
  assert.deepEqual(ref, { id: "gse-1", url: "https://discord.com/events/1/2" });
  assert.equal(sent[0]?.url, "http://127.0.0.1:3011/internal/g/g1/scheduled-event");
  // No `discordEventId` is what tells the route this is a create.
  assert.equal(sent[0]?.body["discordEventId"], undefined);
  assert.equal(sent[0]?.body["status"], "SCHEDULED");
});

test("an update names the event it is bringing in line", async () => {
  const sent = stub({ json: { ok: true, id: "gse-7", url: "https://discord.com/events/1/7" } });

  const ref = await mirror().updateScheduledEvent?.("g1", "gse-7", { ...SPEC, status: "ACTIVE" });
  assert.equal(ref?.id, "gse-7");
  assert.equal(sent[0]?.body["discordEventId"], "gse-7");
  assert.equal(sent[0]?.body["status"], "ACTIVE");
});

test("an admin bot that refuses costs the link and nothing else", async () => {
  stub({ status: 503 });
  assert.equal(await mirror().scheduleEvent?.("g1", SPEC), null);
});

test("a route that answers without a link is treated as no link", async () => {
  stub({ json: { ok: false, error: "NOT_FOUND" } });
  assert.equal(await mirror().updateScheduledEvent?.("g1", "gse-7", SPEC), null);
});

test("an unreachable admin bot is a null, not a throw", async () => {
  stub(new Error("ECONNREFUSED"));
  assert.equal(await mirror().scheduleEvent?.("g1", SPEC), null);
});

test("no internal token means no call at all", async () => {
  const sent = stub({ json: { ok: true, id: "x", url: "y" } });
  assert.equal(await tokenless().scheduleEvent?.("g1", SPEC), null);
  assert.equal(sent.length, 0);
});
