import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBridgeRegistry } from "@sbr/commands-bridge";
import { buildCommands, parseGuildChat, staffPing } from "./transport.js";
import { parseRoleBindings } from "@sbr/guild-config";

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

test("every registered command has a handler behind it, and every retired one is gone", () => {
  const registry = buildBridgeRegistry();
  const names = (buildCommands() as { name: string }[]).map((c) => c.name);
  const registrable = [...registry.values()].filter((s) => s.enabled !== false).map((s) => s.name);
  assert.deepEqual([...names].sort(), [...registrable].sort());

  // The other half of the same claim: a retired command is absent from what we
  // send Discord, not merely present and answering with an error. Discord's
  // registry is what a member's picker is built from, so this is the only place
  // the withdrawal is actually visible to them.
  const retired = [...registry.values()].filter((s) => s.enabled === false).map((s) => s.name);
  assert.ok(retired.length > 0, "nothing is retired — this test would pass vacuously");
  for (const name of retired) assert.ok(!names.includes(name), `${name} is still registered`);
});

test("link publishes its required ign option", () => {
  const link = (buildCommands() as { name: string; options?: { name: string; required?: boolean }[] }[]).find(
    (c) => c.name === "link",
  );
  assert.ok(link);
  assert.deepEqual(link.options?.map((o) => [o.name, o.required]), [["ign", true]]);
});

test("a join notice is addressed to the widest staff audience the guild has bound", () => {
  const bindings = parseRoleBindings({ MODERATOR: ["10"], ADMIN: ["20"], OWNER: ["30"] });
  const ping = staffPing(bindings);
  // Moderator, not Admin: the point of the ping is that somebody sees it.
  assert.deepEqual(ping, { text: "<@&10>", roleIds: ["10"] });
});

test("every role bound at the chosen level is mentioned, not one of them", () => {
  const ping = staffPing(parseRoleBindings({ OFFICER: ["11", "12"], ADMIN: ["20"] }));
  assert.equal(ping?.text, "<@&11> <@&12>");
  assert.deepEqual(ping?.roleIds, ["11", "12"]);
});

test("a guild with only an owner role still gets told", () => {
  assert.equal(staffPing(parseRoleBindings({ OWNER: ["30"] }))?.text, "<@&30>");
});

test("a guild that has bound no staff roles gets the notice unpinged", () => {
  // Null rather than a mention of @everyone or of the member role: an unpinged
  // card in the staff channel is a smaller failure than pinging the server.
  assert.equal(staffPing(parseRoleBindings({ MEMBER: ["9"] })), null);
  assert.equal(staffPing(parseRoleBindings(null)), null);
});
