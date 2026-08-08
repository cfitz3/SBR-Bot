/**
 * The default fetcher is the one place the platform touches the network without
 * a port in front of it, so its failure modes are asserted directly against a
 * stubbed global fetch. The property that matters: a request that never settles
 * must become a retryable response, not a promise that hangs a worker slot.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createFetchHttp } from "./http.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stand in for a server that accepts the connection and then goes quiet. */
function stubHangingFetch(): void {
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    })) as typeof fetch;
}

test("a hung request times out instead of blocking forever", async () => {
  stubHangingFetch();
  const http = createFetchHttp(50);

  const started = Date.now();
  const res = await http.get("https://api.hypixel.net/player");
  const elapsed = Date.now() - started;

  assert.equal(res.status, 504, "a timeout should look like a gateway timeout");
  assert.ok(elapsed < 2_000, `took ${elapsed}ms — the deadline did not fire`);
  assert.deepEqual((res.json as { cause?: string }).cause, "timeout");
});

test("the timeout status is one the client already retries", async () => {
  // The client's ladder retries 429 and >=500. If a timeout surfaced as, say,
  // 400, a transient network blip would be treated as a permanent failure.
  stubHangingFetch();
  const res = await createFetchHttp(20).get("https://api.hypixel.net/player");
  assert.ok(res.status >= 500, `status ${res.status} would not be retried`);
});

test("a transport failure becomes a response rather than an exception", async () => {
  globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
  const res = await createFetchHttp(1_000).get("https://api.hypixel.net/player");

  assert.equal(res.status, 504);
  assert.equal((res.json as { cause?: string }).cause, "network");
});

test("a normal response passes through with lower-cased headers", async () => {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "RateLimit-Remaining": "42" },
      }),
    )) as typeof fetch;

  const res = await createFetchHttp(1_000).get("https://api.hypixel.net/player");
  assert.equal(res.status, 200);
  assert.equal(res.headers["ratelimit-remaining"], "42");
  assert.deepEqual(res.json, { success: true });
});

test("a non-JSON body is reported as undefined, not thrown", async () => {
  globalThis.fetch = (() =>
    Promise.resolve(new Response("<html>502 Bad Gateway</html>", { status: 502 }))) as typeof fetch;

  const res = await createFetchHttp(1_000).get("https://api.hypixel.net/player");
  assert.equal(res.status, 502);
  assert.equal(res.json, undefined);
});
