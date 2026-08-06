import assert from "node:assert/strict";
import { test } from "node:test";
import {
  err,
  hypixelFailure,
  ok,
  type DataEnvelope,
  type IdentityService,
  type LinkError,
  type LinkedIdentityDTO,
  type NetworthDTO,
  type ProgressionService,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { CommandDispatcher } from "./dispatcher.js";
import { buildBridgeRegistry } from "./handlers.js";
import { InMemoryCooldownGate } from "./cooldown.js";
import type { CapabilityChecker, CommandContext, UsageSink } from "./types.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

const linkedDto: LinkedIdentityDTO = {
  discordId: "111",
  minecraftUuid: "uuid-aria",
  ign: "Aria",
  status: "VERIFIED",
  primary: true,
  verifiedAt: "t",
};

function identity(over: Partial<IdentityService> = {}): IdentityService {
  return {
    async resolveByDiscordId() { return ok(linkedDto); },
    async linkByIgn() { return ok(linkedDto); },
    async unlink() { return ok(undefined); },
    async hasCapability() { return true; },
    ...over,
  };
}

function progression(over: Partial<ProgressionService> = {}): ProgressionService {
  return {
    async getProfileSummary() { return hypixelFailure("MISSING_PROFILE"); },
    async getNetworth() {
      const env: DataEnvelope<NetworthDTO> = {
        data: { total: 8_200_000_000, exact: false, missing: ["inventory"], breakdown: {} },
        freshness: "LIVE",
        source: "LIVE",
        fetchedAt: "t",
      };
      return ok(env);
    },
    ...over,
  };
}

const allowAll: CapabilityChecker = { async can() { return true; } };
const denyAll: CapabilityChecker = { async can() { return false; } };

function makeDispatcher(over: {
  identity?: IdentityService;
  progression?: ProgressionService;
  capabilities?: CapabilityChecker;
  usage?: UsageSink;
  now?: () => number;
} = {}) {
  return new CommandDispatcher({
    registry: buildBridgeRegistry(),
    cooldowns: new InMemoryCooldownGate(over.now),
    capabilities: over.capabilities ?? allowAll,
    handlerDeps: {
      identity: over.identity ?? identity(),
      progression: over.progression ?? progression(),
      logger: silent,
    },
    logger: silent,
    ...(over.usage ? { usage: over.usage } : {}),
    ...(over.now ? { now: over.now } : {}),
  });
}

const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({
  guildId: "g1",
  userId: "111",
  surface: "BRIDGE_BOT",
  args: {},
  ...over,
});

test("unknown command replies helpfully", async () => {
  const r = await makeDispatcher().dispatch("frobnicate", ctx());
  assert.match(r.text, /Unknown command/);
});

test("help returns the command list", async () => {
  const r = await makeDispatcher().dispatch("help", ctx());
  assert.match(r.text, /\/link/);
});

test("networth is refused without RUN_COMMAND capability", async () => {
  const r = await makeDispatcher({ capabilities: denyAll }).dispatch("networth", ctx());
  assert.match(r.text, /don't have permission/);
});

test("cooldown blocks a rapid second invocation", async () => {
  const d = makeDispatcher();
  const first = await d.dispatch("networth", ctx());
  assert.match(first.text, /Networth/);
  const second = await d.dispatch("networth", ctx());
  assert.match(second.text, /Slow down/);
});

test("link success confirms the IGN", async () => {
  const r = await makeDispatcher().dispatch("link", ctx({ args: { ign: "Aria" } }));
  assert.match(r.text, /Linked to Aria/);
});

test("link surfaces SOCIAL_UNSET guidance", async () => {
  const failing = identity({
    async linkByIgn() { return err<LinkError>({ kind: "SOCIAL_UNSET" }); },
  });
  const r = await makeDispatcher({ identity: failing }).dispatch("link", ctx({ args: { ign: "Aria" } }));
  assert.match(r.text, /Set your Discord in-game/);
});

test("networth tells unlinked users to link first", async () => {
  const unlinked = identity({ async resolveByDiscordId() { return ok(null); } });
  const r = await makeDispatcher({ identity: unlinked }).dispatch("networth", ctx());
  assert.match(r.text, /not linked/);
});

test("networth renders an estimate for partial data", async () => {
  const r = await makeDispatcher().dispatch("networth", ctx());
  assert.match(r.text, /8\.20b/);
  assert.match(r.text, /est, some data hidden/);
});

test("networth marks stale data as cached", async () => {
  const stale = progression({
    async getNetworth() {
      return ok({
        data: { total: 1_000_000_000, exact: true, missing: [], breakdown: {} },
        freshness: "STALE",
        source: "CACHE",
        fetchedAt: "t",
      });
    },
  });
  const r = await makeDispatcher({ progression: stale }).dispatch("networth", ctx());
  assert.match(r.text, /\(cached\)/);
});

test("handler errors are caught and reported gracefully", async () => {
  const throwing = progression({ async getNetworth() { throw new Error("hypixel down"); } });
  const r = await makeDispatcher({ progression: throwing }).dispatch("networth", ctx());
  assert.match(r.text, /Something went wrong/);
});

test("usage is captured for each dispatch", async () => {
  const captured: Array<{ command: string; success: boolean }> = [];
  const usage: UsageSink = { async capture(u) { captured.push({ command: u.command, success: u.success }); } };
  await makeDispatcher({ usage }).dispatch("help", ctx());
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.command, "help");
  assert.equal(captured[0]?.success, true);
});
