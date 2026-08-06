import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "@sbr/observability";
import { BridgeService } from "./service.js";
import type { BridgeGuard, FilterVerdict, FloodControl, InboundMessage, WordlistFilter } from "./types.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

interface GuardState {
  suspended?: boolean;
  muted?: Set<string>;
  cannotRelay?: Set<string>;
}
function guard(s: GuardState = {}): BridgeGuard {
  return {
    async isSuspended() { return s.suspended ?? false; },
    async isMuted(_g, id) { return s.muted?.has(id) ?? false; },
    async canRelay(_g, id) { return !(s.cannotRelay?.has(id) ?? false); },
  };
}
function wordlist(verdict: FilterVerdict = { action: "ALLOW" }): WordlistFilter {
  return { async check() { return verdict; } };
}
function flood(result: { allowed: boolean; reason?: "RATE" | "DUPLICATE" } = { allowed: true }): FloodControl {
  return { async allow() { return result; } };
}

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    guildId: "g1",
    direction: "DISCORD_TO_GAME",
    authorId: "111",
    authorName: "Aria",
    content: "hello world",
    ...over,
  };
}

function svc(over: { guard?: BridgeGuard; wordlist?: WordlistFilter; flood?: FloodControl } = {}) {
  return new BridgeService({
    guard: over.guard ?? guard(),
    wordlist: over.wordlist ?? wordlist(),
    flood: over.flood ?? flood(),
    logger: silent,
  });
}

test("delivers a clean Discord→game message with the [D] tag", async () => {
  const d = await svc().processInbound(msg());
  assert.equal(d.action, "DELIVER");
  if (d.action === "DELIVER") {
    assert.equal(d.formatted, "[D] Aria: hello world");
    assert.equal(d.flagged, false);
  }
});

test("game→discord strips colour codes and omits the tag (webhook renders identity)", async () => {
  const d = await svc().processInbound(msg({ direction: "GAME_TO_DISCORD", content: "§aGG §rall" }));
  assert.equal(d.action, "DELIVER");
  if (d.action === "DELIVER") assert.equal(d.formatted, "GG all");
});

test("drops empty messages", async () => {
  const d = await svc().processInbound(msg({ content: "   " }));
  assert.deepEqual(d, { action: "DROP", reason: "EMPTY" });
});

test("drops when the author lacks RELAY_MESSAGE", async () => {
  const d = await svc({ guard: guard({ cannotRelay: new Set(["111"]) }) }).processInbound(msg());
  assert.deepEqual(d, { action: "DROP", reason: "NO_PERMISSION" });
});

test("drops when the bridge is suspended", async () => {
  const d = await svc({ guard: guard({ suspended: true }) }).processInbound(msg());
  assert.deepEqual(d, { action: "DROP", reason: "BRIDGE_SUSPENDED" });
});

test("drops when the author is muted", async () => {
  const d = await svc({ guard: guard({ muted: new Set(["111"]) }) }).processInbound(msg());
  assert.deepEqual(d, { action: "DROP", reason: "MUTED" });
});

test("drops BLOCK/SHADOW_MUTE filter verdicts", async () => {
  const blocked = await svc({ wordlist: wordlist({ action: "BLOCK" }) }).processInbound(msg());
  assert.deepEqual(blocked, { action: "DROP", reason: "FILTERED" });
  const shadow = await svc({ wordlist: wordlist({ action: "SHADOW_MUTE" }) }).processInbound(msg());
  assert.deepEqual(shadow, { action: "DROP", reason: "FILTERED" });
});

test("REPLACE verdict rewrites the delivered content", async () => {
  const d = await svc({ wordlist: wordlist({ action: "REPLACE", replacement: "cleaned" }) }).processInbound(msg());
  assert.equal(d.action, "DELIVER");
  if (d.action === "DELIVER") assert.equal(d.formatted, "[D] Aria: cleaned");
});

test("FLAG verdict delivers but marks flagged", async () => {
  const d = await svc({ wordlist: wordlist({ action: "FLAG" }) }).processInbound(msg());
  assert.equal(d.action, "DELIVER");
  if (d.action === "DELIVER") assert.equal(d.flagged, true);
});

test("drops on flood (rate and duplicate)", async () => {
  const rate = await svc({ flood: flood({ allowed: false, reason: "RATE" }) }).processInbound(msg());
  assert.deepEqual(rate, { action: "DROP", reason: "RATE_LIMITED" });
  const dup = await svc({ flood: flood({ allowed: false, reason: "DUPLICATE" }) }).processInbound(msg());
  assert.deepEqual(dup, { action: "DROP", reason: "DUPLICATE" });
});

test("defangs mass pings in Discord→game formatting", async () => {
  const d = await svc().processInbound(msg({ content: "@everyone look" }));
  assert.equal(d.action, "DELIVER");
  // The zero-width joiner between @ and everyone breaks the ping.
  if (d.action === "DELIVER") assert.notEqual(d.formatted, "[D] Aria: @everyone look");
});
