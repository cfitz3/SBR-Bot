import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalyticsEvent, CommandUsageDTO } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { AnalyticsServiceImpl } from "./service.js";
import { rollupDaily } from "./rollup.js";
import type { AnalyticsBuffer } from "./ports.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

function buffer(): { buffer: AnalyticsBuffer; events: AnalyticsEvent[] } {
  const events: AnalyticsEvent[] = [];
  return { events, buffer: { async append(e) { events.push(e); } } };
}

function usage(over: Partial<CommandUsageDTO> = {}): CommandUsageDTO {
  return {
    guildId: "g1",
    discordId: "111",
    surface: "BRIDGE_BOT",
    command: "stats",
    success: true,
    latencyMs: 42,
    invokedAt: "2026-08-06T10:00:00.000Z",
    ...over,
  };
}

test("capture wraps command usage into a command.used event", async () => {
  const b = buffer();
  const svc = new AnalyticsServiceImpl({ buffer: b.buffer, logger: silent });
  await svc.capture(usage());
  assert.equal(b.events.length, 1);
  const e = b.events[0]!;
  assert.equal(e.type, "command.used");
  assert.equal(e.guildId, "g1");
  assert.equal(e.surface, "BRIDGE_BOT");
  assert.equal(e.props?.command, "stats");
});

test("capture never throws even if the buffer fails", async () => {
  const failing: AnalyticsBuffer = { async append() { throw new Error("redis down"); } };
  const svc = new AnalyticsServiceImpl({ buffer: failing, logger: silent });
  await assert.doesNotReject(() => svc.capture(usage()));
});

test("emit appends an arbitrary event", async () => {
  const b = buffer();
  const svc = new AnalyticsServiceImpl({ buffer: b.buffer, logger: silent });
  await svc.emit({ type: "bridge.relay", guildId: "g1", surface: "BRIDGE_BOT", ts: "2026-08-06T10:00:00.000Z", props: { direction: "GAME_TO_DISCORD" } });
  assert.equal(b.events[0]?.type, "bridge.relay");
});

test("rollupDaily aggregates command usage by command and day", () => {
  const day = "2026-08-06T";
  const events: AnalyticsEvent[] = [
    { type: "command.used", guildId: "g1", surface: "BRIDGE_BOT", ts: day + "10:00:00Z", props: { command: "stats", success: true } },
    { type: "command.used", guildId: "g1", surface: "BRIDGE_BOT", ts: day + "11:00:00Z", props: { command: "stats", success: true } },
    { type: "command.used", guildId: "g1", surface: "BRIDGE_BOT", ts: day + "12:00:00Z", props: { command: "networth", success: true } },
  ];
  const rows = rollupDaily(events);
  const stats = rows.find((r) => r.dims.command === "stats");
  const nw = rows.find((r) => r.dims.command === "networth");
  assert.equal(stats?.count, 2);
  assert.equal(nw?.count, 1);
  assert.equal(stats?.day, "2026-08-06");
});

test("rollupDaily keeps guilds separate", () => {
  const events: AnalyticsEvent[] = [
    { type: "command.used", guildId: "g1", surface: "BRIDGE_BOT", ts: "2026-08-06T10:00:00Z", props: { command: "stats", success: true } },
    { type: "command.used", guildId: "g2", surface: "BRIDGE_BOT", ts: "2026-08-06T10:00:00Z", props: { command: "stats", success: true } },
  ];
  const rows = rollupDaily(events);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.count === 1));
});

test("rollupDaily breaks bridge relays down by direction", () => {
  const events: AnalyticsEvent[] = [
    { type: "bridge.relay", guildId: "g1", surface: "BRIDGE_BOT", ts: "2026-08-06T10:00:00Z", props: { direction: "DISCORD_TO_GAME" } },
    { type: "bridge.relay", guildId: "g1", surface: "BRIDGE_BOT", ts: "2026-08-06T10:05:00Z", props: { direction: "DISCORD_TO_GAME" } },
    { type: "bridge.relay", guildId: "g1", surface: "BRIDGE_BOT", ts: "2026-08-06T10:06:00Z", props: { direction: "GAME_TO_DISCORD" } },
  ];
  const rows = rollupDaily(events);
  assert.equal(rows.find((r) => r.dims.direction === "DISCORD_TO_GAME")?.count, 2);
  assert.equal(rows.find((r) => r.dims.direction === "GAME_TO_DISCORD")?.count, 1);
});
