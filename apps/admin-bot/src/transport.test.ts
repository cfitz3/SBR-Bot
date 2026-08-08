import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAdminRegistry } from "@sbr/commands-admin";
import { buildCommands } from "./transport.js";

interface Payload {
  name: string;
  description: string;
  options?: { name: string; required?: boolean }[];
}

const payload = (): Payload[] => buildCommands() as Payload[];

test("every registered command has a handler behind it", () => {
  const registry = buildAdminRegistry();
  const names = payload().map((c) => c.name);
  assert.deepEqual([...names].sort(), [...registry.keys()].sort());
});

test("required options precede optional ones (Discord rejects otherwise)", () => {
  for (const command of payload()) {
    const flags = (command.options ?? []).map((o) => o.required ?? false);
    const sorted = [...flags].sort((a, b) => Number(b) - Number(a));
    assert.deepEqual(flags, sorted, `${command.name} has a required option after an optional one`);
  }
});

test("ban is published with a confirm option, matching the destructive gate", () => {
  const ban = payload().find((c) => c.name === "ban");
  assert.ok(ban, "ban should be registered");
  assert.ok(ban.options?.some((o) => o.name === "confirm"));
});
