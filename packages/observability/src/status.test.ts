import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComponentHealthDTO, HealthReportDTO } from "@sbr/shared-types";
import { curateStatus, MEMBER_STATUS_ROWS } from "./status.js";

const AT = "2026-08-22T09:00:00.000Z";

function report(components: readonly ComponentHealthDTO[]): HealthReportDTO {
  const status = components.some((c) => c.status === "down")
    ? "down"
    : components.some((c) => c.status === "degraded")
      ? "degraded"
      : "ok";
  return { status, checkedAt: AT, components };
}

function up(name: string): ComponentHealthDTO {
  return { name, status: "ok", latencyMs: 4 };
}

test("the curated card carries no probe detail, whatever the probe threw", () => {
  const status = curateStatus(
    report([
      { name: "postgres", status: "down", latencyMs: null, detail: "connect ECONNREFUSED db.internal:5432" },
      up("bridge"),
      up("discord"),
      up("hypixel"),
    ]),
  );

  // Not "the renderer doesn't print it" — there is nowhere for it to be.
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /db\.internal|ECONNREFUSED|postgres/);
});

test("an unnamed component that is down still turns the card red", () => {
  const status = curateStatus(
    report([{ name: "redis", status: "down", latencyMs: null }, up("bridge"), up("discord"), up("hypixel")]),
  );

  // The failure this card exists to prevent: three green rows over an outage.
  assert.equal(status.overall, "down");
  assert.equal(status.otherUnhealthy, 1);
  assert.deepEqual(
    status.lines.map((l) => l.status),
    ["ok", "ok", "ok"],
  );
});

test("healthy components nobody names are not counted as unhealthy", () => {
  const status = curateStatus(report([up("redis"), up("postgres"), up("bridge"), up("discord"), up("hypixel")]));
  assert.equal(status.otherUnhealthy, 0);
  assert.equal(status.overall, "ok");
});

test("the rows are fixed, in order, whether or not a probe exists", () => {
  const status = curateStatus(report([up("discord")]));

  assert.deepEqual(
    status.lines.map((l) => l.label),
    MEMBER_STATUS_ROWS.map((r) => r.label),
  );
  // A deployment with no Mineflayer session has no guild chat. Omitting the row
  // would leave a member guessing whether the relay is broken or absent.
  assert.deepEqual(
    status.lines.map((l) => l.status),
    ["down", "ok", "down"],
  );
});

test("the timestamp is the check's, not the render's", () => {
  assert.equal(curateStatus(report([up("discord")])).checkedAt, AT);
});
