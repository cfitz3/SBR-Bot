/**
 * SkyKings client. The assertions that matter here are about *not knowing*:
 * every way the API can fail has to reach the caller as UNKNOWN, because the
 * one thing a screening policy must never be told is that an unreachable
 * scammer database had nothing on file.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "@sbr/observability";
import { SkykingsClient, normalizeUuid } from "./client.js";
import type { HttpFetcher, HttpResponse } from "./ports.js";

const silent: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
  child() { return silent; },
};

interface Call {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>> | undefined;
}

function http(reply: (url: string) => HttpResponse | Promise<HttpResponse>): { fetch: HttpFetcher; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: {
      async get(url, headers) {
        calls.push({ url, headers });
        return reply(url);
      },
    },
  };
}

const okBody = (json: unknown): HttpResponse => ({ status: 200, headers: {}, json });

function client(fetch: HttpFetcher): SkykingsClient {
  return new SkykingsClient({ apiKey: "test-key", fetch, logger: silent });
}

/**
 * Separate from `client` on purpose: a default parameter would swallow an
 * explicit `undefined`, which is exactly the case the unconfigured tests are
 * about — they would have constructed a working client and passed anyway.
 */
function unkeyedClient(fetch: HttpFetcher, apiKey: string | undefined): SkykingsClient {
  return new SkykingsClient({ apiKey, fetch, logger: silent });
}

const UUID = "747cf094-48c2-4405-9b5a-67c53f509c6e";

// ── the verdict ──

test("a clear player reports CLEAR", async () => {
  const { fetch } = http(() => okBody({ success: true, result: { scammer: false, message: "not flagged", reason: null } }));
  assert.deepEqual(await client(fetch).checkUuid(UUID), { status: "CLEAR" });
});

test("a flagged player carries the reason through, so staff see why", async () => {
  const { fetch } = http(() =>
    okBody({
      success: true,
      result: { scammer: true, message: "User is flagged as a scammer", reason: "IRL trading and account compromise" },
    }),
  );
  const verdict = await client(fetch).checkUuid(UUID);
  assert.equal(verdict.status, "FLAGGED");
  assert.equal(verdict.status === "FLAGGED" ? verdict.reason : null, "IRL trading and account compromise");
});

test("the uuid is sent undashed and lower-cased, however it arrives", async () => {
  const { fetch, calls } = http(() => okBody({ success: true, result: { scammer: false } }));
  await client(fetch).checkUuid("747CF094-48C2-4405-9B5A-67C53F509C6E");
  assert.match(calls[0]?.url ?? "", /uuid=747cf09448c244059b5a67c53f509c6e$/);
});

test("the key travels in the Authorization header, never in the query string", async () => {
  const { fetch, calls } = http(() => okBody({ success: true, result: { scammer: false } }));
  await client(fetch).checkUuid(UUID);
  assert.equal(calls[0]?.headers?.["Authorization"], "test-key");
  assert.doesNotMatch(calls[0]?.url ?? "", /api_key/);
});

// ── every way of not knowing ──

test("an unconfigured key is NOT_CONFIGURED, and no request is attempted", async () => {
  const { fetch, calls } = http(() => okBody({}));
  const verdict = await unkeyedClient(fetch, undefined).checkUuid(UUID);
  assert.deepEqual(verdict, { status: "UNKNOWN", cause: "NOT_CONFIGURED" });
  assert.equal(calls.length, 0);
});

test("a blank key counts as unconfigured rather than being sent", async () => {
  const { fetch, calls } = http(() => okBody({}));
  assert.equal((await unkeyedClient(fetch, "   ").checkUuid(UUID)).status, "UNKNOWN");
  assert.equal(calls.length, 0);
});

test("each failure status maps to its own cause", async () => {
  const cases: readonly (readonly [number, string])[] = [
    [401, "UNAUTHORIZED"],
    [403, "UNAUTHORIZED"],
    [429, "RATE_LIMITED"],
    [500, "UNAVAILABLE"],
    [504, "UNAVAILABLE"], // the fetcher's synthetic timeout
  ];
  for (const [status, cause] of cases) {
    const { fetch } = http(() => ({ status, headers: {}, json: null }));
    const verdict = await client(fetch).checkUuid(UUID);
    assert.equal(verdict.status, "UNKNOWN", `status ${status}`);
    assert.equal(verdict.status === "UNKNOWN" ? verdict.cause : null, cause, `status ${status}`);
  }
});

test("a 200 with an unreadable body is UNKNOWN, not CLEAR", async () => {
  for (const json of [null, {}, { success: true }, { success: true, result: {} }, "nonsense"]) {
    const { fetch } = http(() => okBody(json));
    const verdict = await client(fetch).checkUuid(UUID);
    assert.equal(verdict.status, "UNKNOWN", `body ${JSON.stringify(json)} must not read as clear`);
  }
});

test("a fetcher that throws is caught rather than escaping into the caller", async () => {
  const fetch: HttpFetcher = { async get() { throw new Error("socket hang up"); } };
  assert.equal((await client(fetch).checkUuid(UUID)).status, "UNKNOWN");
});

test("a 404 on the scammer list is a failure, not an absent listing", async () => {
  // /user/lookup answers 200 for both verdicts; a 404 means the route moved,
  // and reading that as "no record" would clear everyone the day it happens.
  const { fetch } = http(() => ({ status: 404, headers: {}, json: null }));
  assert.equal((await client(fetch).checkUuid(UUID)).status, "UNKNOWN");
});

// ── caching and single-flight ──

test("a repeated check is served from cache rather than asked again", async () => {
  const { fetch, calls } = http(() => okBody({ success: true, result: { scammer: false } }));
  const c = client(fetch);
  await c.checkUuid(UUID);
  await c.checkUuid(UUID);
  assert.equal(calls.length, 1);
});

test("a failed check is not cached, so the next call can still find out", async () => {
  let status = 500;
  const { fetch, calls } = http(() =>
    status === 500 ? { status: 500, headers: {}, json: null } : okBody({ success: true, result: { scammer: true } }),
  );
  const c = client(fetch);
  assert.equal((await c.checkUuid(UUID)).status, "UNKNOWN");
  status = 200;
  assert.equal((await c.checkUuid(UUID)).status, "FLAGGED");
  assert.equal(calls.length, 2);
});

test("concurrent checks for one player cost a single request", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((r) => { release = r; });
  const { fetch, calls } = http(async () => {
    await gate;
    return okBody({ success: true, result: { scammer: false } });
  });
  const c = client(fetch);
  const both = Promise.all([c.checkUuid(UUID), c.checkUuid(UUID)]);
  release();
  const [a, b] = await both;
  assert.deepEqual(a, b);
  assert.equal(calls.length, 1);
});

// ── the other endpoints ──

test("a discord id is checked, and a non-snowflake never leaves the process", async () => {
  const { fetch, calls } = http(() => okBody({ success: true, result: { scammer: false } }));
  const c = client(fetch);
  await c.checkDiscordId("358670711109320705");
  assert.match(calls[0]?.url ?? "", /userid=358670711109320705/);

  assert.equal((await c.checkDiscordId("Steve")).status, "UNKNOWN");
  assert.equal(calls.length, 1);
});

test("an untracked player is a miss, not an error", async () => {
  const { fetch } = http(() => ({ status: 404, headers: {}, json: null }));
  const res = await client(fetch).getPlayer(UUID);
  assert.equal(res.status, "OK");
  assert.equal(res.status === "OK" ? res.data : undefined, null);
});

test("a tracked player is read into flat fields, missing ones as null", async () => {
  const { fetch } = http(() =>
    okBody({
      success: true,
      data: {
        uuid: normalizeUuid(UUID),
        username: "Jacktheguy",
        guild: "SkyKings",
        recent_data: {
          networth: 4521893054,
          lily_weight_total: 14832.5,
          senither_weight_total: 9241.3,
          profiles: [{ profile_name: "Mango", skyblock_xp: 218400, networth: 4521893054 }],
        },
        last_checked: "2026-07-13T12:00:00.000Z",
      },
    }),
  );
  const res = await client(fetch).getPlayer(UUID);
  assert.equal(res.status, "OK");
  const player = res.status === "OK" ? res.data : null;
  assert.equal(player?.username, "Jacktheguy");
  assert.equal(player?.guild, "SkyKings");
  assert.equal(player?.senitherWeight, 9241.3);
  assert.equal(player?.eliteWeight, null); // absent upstream, not zero
  assert.equal(player?.profiles[0]?.profileName, "Mango");
});

test("health is true only when the API says healthy", async () => {
  const up = http(() => okBody({ status: "healthy", database: "connected" }));
  assert.equal(await client(up.fetch).healthy(), true);

  const down = http(() => ({ status: 503, headers: {}, json: null }));
  assert.equal(await client(down.fetch).healthy(), false);
});

test("a link lookup returns null for an unknown player rather than failing", async () => {
  const { fetch } = http(() => okBody({ success: false, message: "not found" }));
  const res = await client(fetch).getLink({ uuid: UUID });
  assert.equal(res.status, "OK");
  assert.equal(res.status === "OK" ? res.data : undefined, null);
});
