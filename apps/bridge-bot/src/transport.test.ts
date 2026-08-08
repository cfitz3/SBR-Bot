import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBridgeRegistry } from "@sbr/commands-bridge";
import { buildCommands, parseGuildChat } from "./transport.js";

test("parses a plain guild chat line", () => {
  assert.deepEqual(parseGuildChat("Guild > Steve: hello there"), {
    name: "Steve",
    rank: null,
    message: "hello there",
  });
});

test("parses a line with Discord rank and guild rank", () => {
  assert.deepEqual(parseGuildChat("Guild > [MVP+] Aria [Officer]: gg all"), {
    name: "Aria",
    rank: "Officer",
    message: "gg all",
  });
});

test("ignores non-guild-chat lines", () => {
  assert.equal(parseGuildChat("Friend > Steve: hi"), null);
  assert.equal(parseGuildChat("random server message"), null);
});

/**
 * The duplicate this pass fixed, expressed as the two rules that fix it: the
 * bot's own relayed line comes back looking exactly like ordinary guild chat,
 * so only the author check can tell them apart.
 */
test("the bot's own echo of a relayed Discord message is still parseable chat", () => {
  const echoed = parseGuildChat("Guild > SBRBridge [Member]: [D] Alice: hey all");
  assert.deepEqual(echoed, { name: "SBRBridge", rank: "Member", message: "[D] Alice: hey all" });
});

test("ignores non-guild-chat lines that mention a guild", () => {
  assert.equal(parseGuildChat("Guild > Steve joined."), null);
  assert.equal(parseGuildChat("Officer > Steve: hi"), null);
});

test("every registered command has a handler behind it", () => {
  const registry = buildBridgeRegistry();
  const names = (buildCommands() as { name: string }[]).map((c) => c.name);
  assert.deepEqual([...names].sort(), [...registry.keys()].sort());
});

test("link publishes its required ign option", () => {
  const link = (buildCommands() as { name: string; options?: { name: string; required?: boolean }[] }[]).find(
    (c) => c.name === "link",
  );
  assert.ok(link);
  assert.deepEqual(link.options?.map((o) => [o.name, o.required]), [["ign", true]]);
});
