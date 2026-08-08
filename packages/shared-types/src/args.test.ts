import assert from "node:assert/strict";
import { test } from "node:test";
import { noArgs, recordArgs } from "./args.js";

test("getString trims and treats blank as absent", () => {
  const args = recordArgs({ ign: "  Aria  ", note: "   " });
  assert.equal(args.getString("ign"), "Aria");
  assert.equal(args.getString("note"), null);
  assert.equal(args.getString("missing"), null);
});

test("getNumber rejects garbage rather than yielding NaN", () => {
  const args = recordArgs({ count: "50", price: "1.5", junk: "abc", empty: "" });
  assert.equal(args.getNumber("count"), 50);
  assert.equal(args.getNumber("price"), 1.5);
  assert.equal(args.getNumber("junk"), null);
  assert.equal(args.getNumber("empty"), null);
});

test("getBoolean accepts the spellings a chat user would actually type", () => {
  const args = recordArgs({ a: "true", b: "yes", c: "1", d: "off", e: "NO", f: "maybe" });
  assert.equal(args.getBoolean("a"), true);
  assert.equal(args.getBoolean("b"), true);
  assert.equal(args.getBoolean("c"), true);
  assert.equal(args.getBoolean("d"), false);
  assert.equal(args.getBoolean("e"), false);
  // Unrecognised is null, not false — "maybe" must not silently mean "no".
  assert.equal(args.getBoolean("f"), null);
});

test("getUser accepts a snowflake or a mention, and rejects anything else", () => {
  const args = recordArgs({ a: "123456789012345678", b: "<@123456789012345678>", c: "<@!987654321098765>", d: "Aria" });
  assert.equal(args.getUser("a"), "123456789012345678");
  assert.equal(args.getUser("b"), "123456789012345678");
  assert.equal(args.getUser("c"), "987654321098765");
  assert.equal(args.getUser("d"), null);
});

test("getChannel accepts a snowflake or a channel mention", () => {
  const args = recordArgs({ a: "<#123456789012345678>", b: "123456789012345678", c: "#general" });
  assert.equal(args.getChannel("a"), "123456789012345678");
  assert.equal(args.getChannel("b"), "123456789012345678");
  assert.equal(args.getChannel("c"), null);
});

test("subcommand is null unless supplied", () => {
  assert.equal(recordArgs({}).subcommand(), null);
  assert.equal(recordArgs({}, "open").subcommand(), "open");
});

test("noArgs answers null for everything", () => {
  assert.equal(noArgs.getString("x"), null);
  assert.equal(noArgs.getNumber("x"), null);
  assert.equal(noArgs.getBoolean("x"), null);
  assert.equal(noArgs.subcommand(), null);
});
