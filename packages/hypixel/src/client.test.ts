/**
 * HypixelClient unit tests — the centralized data-layer behaviors:
 * uuid resolution, social extraction, caching, rate-limit fallbacks, retries,
 * and stale-if-error. Fully offline via fake HTTP/cache/rate-gate ports.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "@sbr/observability";
import { HypixelClient, HypixelUnavailableError } from "./client.js";
import { InMemoryHypixelCache } from "./memory.js";
import type { CacheEntry, HttpFetcher, HttpResponse, HypixelCache, RateAcquire, RateGate } from "./ports.js";

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger; },
};

const noopSleep = async (): Promise<void> => {};

function res(status: number, json: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, json };
}

/** Scriptable fetcher. `script(url, nthCallForUrl)` returns the response. */
function fakeFetcher(script: (url: string, n: number) => HttpResponse | Error): {
  fetcher: HttpFetcher;
  count: (match: string) => number;
} {
  const counts = new Map<string, number>();
  return {
    fetcher: {
      async get(url) {
        const key = url.includes("mojang") ? "mojang" : "hypixel";
        const n = counts.get(key) ?? 0;
        counts.set(key, n + 1);
        const out = script(url, n);
        if (out instanceof Error) throw out;
        return out;
      },
    },
    count: (match) => counts.get(match) ?? 0,
  };
}

class FakeGate implements RateGate {
  constructor(private readonly allow: boolean, private readonly retryAfterMs = 1000) {}
  async acquire(): Promise<RateAcquire> {
    return this.allow ? { allowed: true } : { allowed: false, retryAfterMs: this.retryAfterMs };
  }
  observe(): void {}
}

class PreloadCache implements HypixelCache {
  private readonly entries = new Map<string, { data: unknown; expired: boolean }>();
  preload(key: string, data: unknown, expired: boolean): void {
    this.entries.set(key, { data, expired });
  }
  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const e = this.entries.get(key);
    return e ? { data: e.data as T, fetchedAt: "2020-01-01T00:00:00.000Z", expired: e.expired } : null;
  }
  async set<T>(key: string, data: T): Promise<void> {
    this.entries.set(key, { data, expired: false });
  }
}

const mojangOk = (uuid: string, name: string) => res(200, { id: uuid, name });
const hypixelPlayer = (discord?: string) =>
  res(200, { success: true, player: { displayname: "Aria", socialMedia: { links: discord ? { DISCORD: discord } : {} } } });

test("resolveUuid returns uuid on success and null on 404", async () => {
  const a = fakeFetcher(() => mojangOk("uuid-aria", "Aria"));
  const client = new HypixelClient({ logger: silentLogger, http: a.fetcher, sleep: noopSleep });
  assert.deepEqual(await client.resolveUuid("Aria"), { uuid: "uuid-aria", name: "Aria" });

  const b = fakeFetcher(() => res(404, undefined));
  const client2 = new HypixelClient({ logger: silentLogger, http: b.fetcher, sleep: noopSleep });
  assert.equal(await client2.resolveUuid("Ghost"), null);
});

test("getLinkedDiscord returns the Discord social value when set", async () => {
  const { fetcher } = fakeFetcher((url) =>
    url.includes("mojang") ? mojangOk("uuid-aria", "Aria") : hypixelPlayer("aria#handle"),
  );
  const client = new HypixelClient({ logger: silentLogger, http: fetcher, sleep: noopSleep });
  const result = await client.getLinkedDiscord("Aria");
  assert.deepEqual(result, { kind: "FOUND", uuid: "uuid-aria", ign: "Aria", discordId: "aria#handle" });
});

test("getLinkedDiscord returns discordId null when the social field is unset", async () => {
  const { fetcher } = fakeFetcher((url) =>
    url.includes("mojang") ? mojangOk("uuid-aria", "Aria") : hypixelPlayer(undefined),
  );
  const client = new HypixelClient({ logger: silentLogger, http: fetcher, sleep: noopSleep });
  const result = await client.getLinkedDiscord("Aria");
  assert.equal(result.kind, "FOUND");
  if (result.kind === "FOUND") assert.equal(result.discordId, null);
});

test("getLinkedDiscord treats a missing Hypixel profile as social-unset (discordId null)", async () => {
  const { fetcher } = fakeFetcher((url) =>
    url.includes("mojang") ? mojangOk("uuid-aria", "Aria") : res(200, { success: true, player: null }),
  );
  const client = new HypixelClient({ logger: silentLogger, http: fetcher, sleep: noopSleep });
  const result = await client.getLinkedDiscord("Aria");
  assert.equal(result.kind, "FOUND");
  if (result.kind === "FOUND") assert.equal(result.discordId, null);
});

test("getLinkedDiscord returns IGN_NOT_FOUND for an unknown name", async () => {
  const { fetcher } = fakeFetcher(() => res(404, undefined));
  const client = new HypixelClient({ logger: silentLogger, http: fetcher, sleep: noopSleep });
  assert.deepEqual(await client.getLinkedDiscord("Ghost"), { kind: "IGN_NOT_FOUND" });
});

test("getPlayer serves the second call from cache (one upstream fetch)", async () => {
  const f = fakeFetcher(() => hypixelPlayer("x"));
  const client = new HypixelClient({
    logger: silentLogger,
    http: f.fetcher,
    cache: new InMemoryHypixelCache(),
    sleep: noopSleep,
  });
  const first = await client.getPlayer("uuid-aria");
  const second = await client.getPlayer("uuid-aria");
  assert.equal(first.ok && first.value.freshness, "LIVE");
  assert.equal(second.ok && second.value.source, "CACHE");
  assert.equal(f.count("hypixel"), 1);
});

test("getPlayer returns RATE_LIMITED when the gate denies and there is no cache", async () => {
  const f = fakeFetcher(() => hypixelPlayer("x"));
  const client = new HypixelClient({ logger: silentLogger, http: f.fetcher, rateGate: new FakeGate(false, 500), sleep: noopSleep });
  const result = await client.getPlayer("uuid-aria");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.state, "RATE_LIMITED");
    assert.equal(result.error.retryAfterMs, 500);
  }
  assert.equal(f.count("hypixel"), 0); // never hit the network
});

test("getPlayer serves STALE cache when rate-limited", async () => {
  const cache = new PreloadCache();
  cache.preload("player:uuid-aria", { uuid: "uuid-aria", ign: "Aria", discordSocial: "x" }, true);
  const f = fakeFetcher(() => hypixelPlayer("x"));
  const client = new HypixelClient({ logger: silentLogger, http: f.fetcher, cache, rateGate: new FakeGate(false), sleep: noopSleep });
  const result = await client.getPlayer("uuid-aria");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.freshness, "STALE");
});

test("getPlayer retries a transient 500 then succeeds", async () => {
  let sleeps = 0;
  const f = fakeFetcher((_url, n) => (n === 0 ? res(500, undefined) : hypixelPlayer("x")));
  const client = new HypixelClient({
    logger: silentLogger,
    http: f.fetcher,
    sleep: async () => { sleeps += 1; },
    maxRetries: 3,
  });
  const result = await client.getPlayer("uuid-aria");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.freshness, "LIVE");
  assert.equal(sleeps, 1);
  assert.equal(f.count("hypixel"), 2);
});

test("getPlayer serves STALE on persistent upstream error (stale-if-error)", async () => {
  const cache = new PreloadCache();
  cache.preload("player:uuid-aria", { uuid: "uuid-aria", ign: "Aria", discordSocial: "x" }, true);
  const f = fakeFetcher(() => res(500, undefined));
  const client = new HypixelClient({ logger: silentLogger, http: f.fetcher, cache, sleep: noopSleep, maxRetries: 2 });
  const result = await client.getPlayer("uuid-aria");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.freshness, "STALE");
});

test("getPlayer throws HypixelUnavailableError on persistent error with no cache", async () => {
  const f = fakeFetcher(() => res(500, undefined));
  const client = new HypixelClient({ logger: silentLogger, http: f.fetcher, sleep: noopSleep, maxRetries: 1 });
  await assert.rejects(() => client.getPlayer("uuid-aria"), HypixelUnavailableError);
});
