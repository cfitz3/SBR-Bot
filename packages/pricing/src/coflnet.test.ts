import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "@sbr/observability";
import { CoflnetHistory, parseCoflnetTime } from "./coflnet.js";
import type { HistoryHttp } from "./ports.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

/** One real bucket, copied from a live `history/week` response. */
const BUCKET = { min: 1112000000, max: 1182000000, avg: 1147000000, volume: 2, time: "2026-08-21T03:00:00" };

function http(answer: (url: string) => { status: number; json: unknown }) {
  const urls: string[] = [];
  const fetcher: HistoryHttp = {
    async get(url) {
      urls.push(url);
      return answer(url);
    },
  };
  return { fetcher, urls };
}

function client(fetcher: HistoryHttp): CoflnetHistory {
  return new CoflnetHistory({ fetch: fetcher, logger: silent, baseUrl: "https://sky.example" });
}

test("a bucket keeps its numbers and its place on the clock", async () => {
  const { fetcher, urls } = http(() => ({ status: 200, json: [BUCKET] }));
  const points = await client(fetcher).history("hyperion", "WEEK");

  assert.deepEqual(urls, ["https://sky.example/api/item/price/HYPERION/history/week"]);
  assert.deepEqual(points, [
    { at: Date.UTC(2026, 7, 21, 3), min: 1112000000, max: 1182000000, avg: 1147000000, volume: 2 },
  ]);
});

test("a zoneless upstream timestamp is read as UTC, not as the host's clock", () => {
  // The whole series shifts by the host offset otherwise — invisible on a chart
  // and wrong on the axis, which is the worst combination.
  assert.equal(parseCoflnetTime("2026-08-21T03:00:00"), Date.UTC(2026, 7, 21, 3));
  // An explicit zone is honoured rather than having a second one stapled on.
  assert.equal(parseCoflnetTime("2026-08-21T03:00:00Z"), Date.UTC(2026, 7, 21, 3));
  assert.equal(parseCoflnetTime("2026-08-21T05:00:00+02:00"), Date.UTC(2026, 7, 21, 3));
  assert.equal(parseCoflnetTime("not a date"), null);
  assert.equal(parseCoflnetTime(undefined), null);
});

test("each range asks for its own path", async () => {
  const { fetcher, urls } = http(() => ({ status: 200, json: [] }));
  const c = client(fetcher);
  await c.history("HYPERION", "DAY");
  await c.history("HYPERION", "WEEK");
  await c.history("HYPERION", "MONTH");

  assert.deepEqual(urls.map((u) => u.split("/").pop()), ["day", "week", "month"]);
});

test("an item Coflnet has never seen has no history, which is not an outage", async () => {
  // 400 `item_not_found` is a real answer about a real question. Counting it as
  // a failure would let three obscure lookups open the breaker for everybody.
  const { fetcher } = http(() => ({
    status: 400,
    json: { slug: "item_not_found", message: "could not find the item", trace: null },
  }));
  assert.deepEqual(await client(fetcher).history("MADE_UP", "WEEK"), []);
});

test("any other rejection is a failure, so the breaker can see it", async () => {
  for (const status of [400, 429, 500, 503]) {
    const { fetcher } = http(() => ({ status, json: { slug: "rate_limited" } }));
    assert.equal(await client(fetcher).history("HYPERION", "WEEK"), null, `status ${String(status)}`);
  }
});

test("a 200 that is not a series is a failure rather than a quiet empty answer", async () => {
  // Reporting "no history" for every item on the server is the failure mode of
  // trusting an unexpected shape.
  const { fetcher } = http(() => ({ status: 200, json: { message: "maintenance" } }));
  assert.equal(await client(fetcher).history("HYPERION", "WEEK"), null);
});

test("an undated bucket is dropped rather than dated to now", async () => {
  const { fetcher } = http(() => ({ status: 200, json: [BUCKET, { ...BUCKET, time: null }] }));
  assert.equal((await client(fetcher).history("HYPERION", "WEEK"))?.length, 1);
});

test("a missing number is null, never zero", async () => {
  // Zero volume and unknown volume are different facts about an hour.
  const { fetcher } = http(() => ({ status: 200, json: [{ time: BUCKET.time, avg: 5, volume: null }] }));
  assert.deepEqual(await client(fetcher).history("HYPERION", "DAY"), [
    { at: Date.UTC(2026, 7, 21, 3), min: null, max: null, avg: 5, volume: null },
  ]);
});

test("a transport that throws answers null instead of escaping the port", async () => {
  const c = client({
    async get() {
      throw new Error("ECONNRESET");
    },
  });
  assert.equal(await c.history("HYPERION", "DAY"), null);
});

test("an item id with a slash cannot walk out of its own path", async () => {
  const { fetcher, urls } = http(() => ({ status: 200, json: [] }));
  await client(fetcher).history("../../prices/change", "DAY");
  assert.equal(urls[0], "https://sky.example/api/item/price/..%2F..%2FPRICES%2FCHANGE/history/day");
});
