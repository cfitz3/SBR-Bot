import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGuildChat } from "./transport.js";

test("parses a plain guild chat line", () => {
  assert.deepEqual(parseGuildChat("Guild > Steve: hello there"), { name: "Steve", message: "hello there" });
});

test("parses a line with Discord rank and guild rank", () => {
  assert.deepEqual(parseGuildChat("Guild > [MVP+] Aria [Officer]: gg all"), { name: "Aria", message: "gg all" });
});

test("ignores non-guild-chat lines", () => {
  assert.equal(parseGuildChat("Friend > Steve: hi"), null);
  assert.equal(parseGuildChat("random server message"), null);
});
