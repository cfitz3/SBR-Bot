import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "@sbr/observability";
import type { PriceDTO } from "@sbr/shared-types";
import { PricingServiceImpl } from "./pricing.js";
import type { PriceLookup, PriceSource } from "./ports.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

function source(map: Record<string, PriceLookup>): PriceSource {
  return { async getItem(id) { return map[id] ?? null; } };
}

const hyperion: PriceDTO = {
  itemId: "HYPERION",
  bazaarInstantSell: null,
  bazaarInstantBuy: null,
  lowestBin: 900_000_000,
  estimatedValue: 950_000_000,
};

test("getPrice returns LIVE data on a fresh cache hit", async () => {
  const svc = new PricingServiceImpl({ source: source({ HYPERION: { price: hyperion, stale: false } }), logger: silent });
  const r = await svc.getPrice("HYPERION");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.freshness, "LIVE");
    assert.equal(r.value.data.lowestBin, 900_000_000);
  }
});

test("getPrice marks stale cache hits STALE", async () => {
  const svc = new PricingServiceImpl({ source: source({ HYPERION: { price: hyperion, stale: true } }), logger: silent });
  const r = await svc.getPrice("HYPERION");
  assert.equal(r.ok && r.value.freshness, "STALE");
});

test("getPrice returns an all-null PriceDTO when there is no data (unknown != zero)", async () => {
  const svc = new PricingServiceImpl({ source: source({}), logger: silent });
  const r = await svc.getPrice("UNKNOWN_ITEM");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.data.itemId, "UNKNOWN_ITEM");
    assert.equal(r.value.data.lowestBin, null);
    assert.equal(r.value.data.estimatedValue, null);
  }
});
