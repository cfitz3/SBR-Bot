/**
 * In-game `!` surface. The interesting assertions here are the *refusals*: what
 * guild chat cannot reach, and what it stays silent about.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "@sbr/observability";
import { CommandDispatcher } from "./dispatcher.js";
import {
  InGameDispatcher,
  INGAME_MAX_CHARS,
  parseInGameCommand,
  positionalArgs,
  toGameLine,
  type InGameIdentity,
} from "./ingame.js";
import { InMemoryCooldownGate } from "./cooldown.js";
import type { CommandReply, CommandSpec, HandlerDeps } from "./types.js";

const silent: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
  child() { return silent; },
};

// ───────────────────────────── parsing ─────────────────────────────

test("parses a command and its positional tokens", () => {
  assert.deepEqual(parseInGameCommand("!stats Steve"), { name: "stats", tokens: ["Steve"] });
});

test("resolves the documented short aliases", () => {
  assert.equal(parseInGameCommand("!nw")?.name, "networth");
  assert.equal(parseInGameCommand("!bz gold")?.name, "bazaar");
  assert.equal(parseInGameCommand("!lbin hyperion")?.name, "lowestbin");
});

test("ordinary chat, bare prefixes and punctuation are not commands", () => {
  assert.equal(parseInGameCommand("anyone for f7?"), null);
  assert.equal(parseInGameCommand("!"), null);
  assert.equal(parseInGameCommand("!!!"), null);
  assert.equal(parseInGameCommand("! stats"), null); // a space means it's chat
});

test("the prefix is configurable", () => {
  assert.equal(parseInGameCommand("?stats Steve", "?")?.name, "stats");
  assert.equal(parseInGameCommand("!stats Steve", "?"), null);
});

const priceSpec: CommandSpec = {
  name: "price",
  description: "price",
  options: [{ name: "item", description: "item", type: "string", required: true }],
  cooldownMs: 5_000,
  inGame: true,
  async handler() { return { ephemeral: false, text: "" }; },
};

test("the last option absorbs the rest of the line, so multi-word values work", () => {
  const args = positionalArgs(priceSpec, ["enchanted", "diamond", "block"]);
  assert.equal(args.getString("item"), "enchanted diamond block");
});

test("earlier options take one token each", () => {
  const spec: CommandSpec = {
    ...priceSpec,
    options: [
      { name: "player", description: "p", type: "string" },
      { name: "note", description: "n", type: "string" },
    ],
  };
  const args = positionalArgs(spec, ["Steve", "needs", "carry"]);
  assert.equal(args.getString("player"), "Steve");
  assert.equal(args.getString("note"), "needs carry");
});

test("a Discord-only option takes no token, so the free-text one still absorbs the line", () => {
  // Regression: /lfg gained title/perm/permname for Discord. Positionally those
  // would have eaten "need" and "a healer", leaving details empty.
  const spec: CommandSpec = {
    ...priceSpec,
    options: [
      { name: "activity", description: "a", type: "string", required: true },
      { name: "title", description: "t", type: "string", inGamePositional: false },
      { name: "details", description: "d", type: "string" },
      { name: "permname", description: "p", type: "string", inGamePositional: false },
    ],
  };
  const args = positionalArgs(spec, ["dungeons", "need", "a", "healer"]);
  assert.equal(args.getString("activity"), "dungeons");
  assert.equal(args.getString("details"), "need a healer");
  assert.equal(args.getString("title"), null);
  assert.equal(args.getString("permname"), null);
});

// ───────────────────────────── flattening ─────────────────────────────

test("an embed collapses to title — fields, joined with pipes", () => {
  const reply: CommandReply = {
    ephemeral: false,
    text: "Here you go:",
    embed: {
      title: "Steve",
      fields: [
        { name: "Cata", value: "**42**" },
        { name: "SA", value: "45.3" },
      ],
      footer: "as of 3m ago",
    },
  };
  assert.equal(toGameLine(reply), "Steve — Cata: 42 | SA: 45.3 — (as of 3m ago)");
});

test("a text-only reply passes through with markdown stripped", () => {
  assert.equal(toGameLine({ ephemeral: true, text: "That event is **full**." }), "That event is full.");
});

test("mentions and timestamp tags become something readable in Minecraft chat", () => {
  const line = toGameLine({
    ephemeral: false,
    text: "<@123456789> starts <t:1756742400:R>",
  });
  assert.match(line, /@user/);
  assert.doesNotMatch(line, /<[@t#]/);
});

test("a long line is cut on a separator and marked as truncated", () => {
  const fields = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}`, value: "1234567890" }));
  const line = toGameLine({ ephemeral: false, text: "", embed: { title: "Long", fields } });
  assert.ok(line.length <= INGAME_MAX_CHARS, `line was ${line.length}`);
  assert.ok(line.endsWith("…"));
  // The cut lands between fields, not inside a value.
  assert.doesNotMatch(line, /: \d{1,9}…$/);
});

// ───────────────────────────── dispatch ─────────────────────────────

const deps = {} as HandlerDeps;

function specs(over: readonly CommandSpec[]): Map<string, CommandSpec> {
  return new Map(over.map((s) => [s.name, s]));
}

const linked: InGameIdentity = { async resolveDiscordIdByIgn() { return "111"; } };
const unlinked: InGameIdentity = { async resolveDiscordIdByIgn() { return null; } };

function make(registry: Map<string, CommandSpec>, identity: InGameIdentity = linked): InGameDispatcher {
  return new InGameDispatcher({
    dispatcher: new CommandDispatcher({
      registry,
      cooldowns: new InMemoryCooldownGate(),
      capabilities: { async can() { return true; } },
      handlerDeps: deps,
      logger: silent,
    }),
    identity,
    cooldowns: new InMemoryCooldownGate(),
    logger: silent,
    minCooldownMs: 0,
  });
}

const lookup: CommandSpec = {
  name: "stats",
  description: "stats",
  options: [{ name: "player", description: "p", type: "string" }],
  cooldownMs: 0,
  inGame: true,
  async handler(ctx) {
    return { ephemeral: false, text: `caller=${ctx.userId} player=${ctx.args.getString("player") ?? "self"}` };
  },
};

test("a lookup runs and answers in one line", async () => {
  const r = await make(specs([lookup])).handle("g1", "Steve", "!stats Alex");
  assert.equal(r, "caller=111 player=Alex");
});

test("the caller's linked Discord id is what the handler sees", async () => {
  const r = await make(specs([lookup])).handle("g1", "Steve", "!stats");
  assert.match(r ?? "", /caller=111 /);
});

test("an unlinked player can still run public lookups", async () => {
  const r = await make(specs([lookup]), unlinked).handle("g1", "Nobody", "!stats Alex");
  assert.match(r ?? "", /player=Alex/);
});

test("commands not marked inGame are unreachable and answer with silence", async () => {
  const moderation: CommandSpec = { ...lookup, name: "ban", inGame: false };
  const d = make(specs([moderation]));
  assert.equal(await d.handle("g1", "Steve", "!ban Alex"), null);
});

test("an unknown word after the prefix says nothing", async () => {
  assert.equal(await make(specs([lookup])).handle("g1", "Steve", "!nonsense"), null);
});

test("a missing required option gets a usage hint, not a stack trace", async () => {
  const d = make(specs([{ ...priceSpec, cooldownMs: 0 }]));
  assert.equal(await d.handle("g1", "Steve", "!price"), "Usage: !price <item>");
});

test("a second call inside the cooldown is silent rather than noisy", async () => {
  const d = new InGameDispatcher({
    dispatcher: new CommandDispatcher({
      registry: specs([lookup]),
      cooldowns: new InMemoryCooldownGate(),
      capabilities: { async can() { return true; } },
      handlerDeps: deps,
      logger: silent,
    }),
    identity: linked,
    cooldowns: new InMemoryCooldownGate(),
    logger: silent,
    minCooldownMs: 60_000,
  });
  assert.notEqual(await d.handle("g1", "Steve", "!stats"), null);
  assert.equal(await d.handle("g1", "Steve", "!stats"), null);
});

test("the cooldown is per IGN, so one spammer doesn't mute the guild", async () => {
  const d = new InGameDispatcher({
    dispatcher: new CommandDispatcher({
      registry: specs([lookup]),
      cooldowns: new InMemoryCooldownGate(),
      capabilities: { async can() { return true; } },
      handlerDeps: deps,
      logger: silent,
    }),
    identity: linked,
    cooldowns: new InMemoryCooldownGate(),
    logger: silent,
    minCooldownMs: 60_000,
  });
  assert.notEqual(await d.handle("g1", "Steve", "!stats"), null);
  assert.notEqual(await d.handle("g1", "Alex", "!stats"), null);
});

test("a capability-gated command tells an unlinked player how to fix it", async () => {
  const write: CommandSpec = {
    name: "lfg",
    description: "lfg",
    options: [{ name: "activity", description: "a", type: "string", required: true }],
    capability: "RUN_COMMAND",
    cooldownMs: 0,
    inGame: "linked",
    async handler() { return { ephemeral: false, text: "posted" }; },
  };
  const r = await make(specs([write]), unlinked).handle("g1", "Nobody", "!lfg F7");
  assert.match(r ?? "", /Link your account on Discord first/);
});

test("an identity lookup failure degrades to anonymous rather than erroring in chat", async () => {
  const broken: InGameIdentity = { async resolveDiscordIdByIgn() { throw new Error("db down"); } };
  const r = await make(specs([lookup]), broken).handle("g1", "Steve", "!stats Alex");
  assert.match(r ?? "", /player=Alex/);
});

test("a handler that throws answers with a short message, never a stack trace", async () => {
  const boom: CommandSpec = {
    ...lookup,
    async handler() { throw new Error("upstream exploded at line 42"); },
  };
  const r = await make(specs([boom])).handle("g1", "Steve", "!stats");
  assert.ok(r !== null);
  assert.doesNotMatch(r, /line 42|Error/);
});

test("the real registry exposes only lookups in-game, and every write requires a link", async () => {
  const { buildBridgeRegistry } = await import("./handlers.js");
  const exposed = [...buildBridgeRegistry().values()].filter((s) => s.inGame !== undefined && s.inGame !== false);
  const names = exposed.map((s) => s.name).sort();

  // The documented §17 set. Pinned exactly, because widening it is a security
  // decision — guild chat proves guild membership and nothing else.
  assert.deepEqual(names, [
    "bazaar", "dungeons", "events", "help", "lfg", "lowestbin",
    "networth", "perm", "price", "profile", "runs", "skills", "slayer", "stats",
  ]);

  // Anything that writes is `"linked"`, never `true`. `/perm` is here rather
  // than in the `true` set because its read actions share one command with its
  // writes, and the weaker of the two requirements would govern the pair.
  assert.deepEqual(exposed.filter((s) => s.inGame === "linked").map((s) => s.name).sort(), ["lfg", "perm"]);

  // And the identity commands stay Discord-only: `/link` in guild chat would
  // invite people to type an IGN at a surface that can't verify who they are.
  for (const forbidden of ["link", "unlink", "verify", "setprofile"]) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not be reachable in-game`);
  }
});
