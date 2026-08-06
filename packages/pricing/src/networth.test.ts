import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "@sbr/observability";
import { NetworthServiceImpl, buildNetworth } from "./networth.js";
import type { NetworthEngine } from "./ports.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

const REQUIRED = ["inventory", "armor", "museum", "bank"];

function engine(total: number, breakdown: Record<string, number> = {}): NetworthEngine {
  return { async compute() { return { total, breakdown }; } };
}

test("buildNetworth is exact only when nothing is missing", () => {
  const dto = buildNetworth(1_000, { armor: 1_000 }, REQUIRED, REQUIRED);
  assert.equal(dto.exact, true);
  assert.deepEqual(dto.missing, []);
  assert.equal(dto.total, 1_000);
});

test("buildNetworth is a lower-bound estimate when a section is unreadable", () => {
  const readable = ["armor", "museum", "bank"]; // inventory hidden
  const dto = buildNetworth(500, { armor: 500 }, readable, REQUIRED);
  assert.equal(dto.exact, false);
  assert.deepEqual(dto.missing, ["inventory"]);
  assert.equal(dto.total, 500); // engine total stands, but flagged non-exact
});

test("buildNetworth is never exact when total is unknown", () => {
  const dto = buildNetworth(null, {}, REQUIRED, REQUIRED);
  assert.equal(dto.exact, false);
  assert.equal(dto.total, null);
});

test("service returns an exact valuation when all sections are readable", async () => {
  const svc = new NetworthServiceImpl({ engine: engine(8_200_000_000, { gear: 8.2e9 }), logger: silent });
  const r = await svc.getNetworth({ engineInput: { profile: {} }, readableSections: REQUIRED, requiredSections: REQUIRED });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.exact, true);
    assert.equal(r.value.total, 8_200_000_000);
  }
});

test("service flags partial data as an estimate", async () => {
  const svc = new NetworthServiceImpl({ engine: engine(3_000), logger: silent });
  const r = await svc.getNetworth({
    engineInput: { profile: {} },
    readableSections: ["armor"],
    requiredSections: REQUIRED,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.exact, false);
    assert.ok(r.value.missing.includes("inventory"));
    assert.ok(r.value.missing.includes("museum"));
  }
});

test("service returns unknown total (never exact) when the engine throws", async () => {
  const failing: NetworthEngine = { async compute() { throw new Error("engine down"); } };
  const svc = new NetworthServiceImpl({ engine: failing, logger: silent });
  const r = await svc.getNetworth({ engineInput: { profile: {} }, readableSections: REQUIRED, requiredSections: REQUIRED });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.total, null);
    assert.equal(r.value.exact, false);
  }
});
