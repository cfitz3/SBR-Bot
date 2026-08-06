import assert from "node:assert/strict";
import { test } from "node:test";
import { buildArgs, type OptionReader } from "./transport.js";

function reader(over: Partial<Record<string, string | boolean>> = {}): OptionReader {
  return {
    getUserId: (n) => (typeof over[n] === "string" ? (over[n] as string) : null),
    getString: (n) => (typeof over[n] === "string" ? (over[n] as string) : null),
    getBoolean: (n) => (typeof over[n] === "boolean" ? (over[n] as boolean) : null),
  };
}

test("buildArgs maps target/reason/duration", () => {
  const args = buildArgs(reader({ target: "123", reason: "spam", duration: "1h" }));
  assert.deepEqual(args, { target: "123", reason: "spam", duration: "1h" });
});

test("buildArgs sets confirm only when boolean true", () => {
  assert.equal(buildArgs(reader({ target: "1", confirm: true })).confirm, "true");
  assert.equal(buildArgs(reader({ target: "1", confirm: false })).confirm, undefined);
});

test("buildArgs omits absent options", () => {
  assert.deepEqual(buildArgs(reader({ target: "1" })), { target: "1" });
});
