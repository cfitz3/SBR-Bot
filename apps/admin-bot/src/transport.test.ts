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

test("every registered command has a handler behind it, and every retired one is gone", () => {
  const registry = buildAdminRegistry();
  const names = payload().map((c) => c.name);
  const registrable = [...registry.values()].filter((s) => s.enabled !== false).map((s) => s.name);
  assert.deepEqual([...names].sort(), [...registrable].sort());

  // The other half of the same claim, as on the bridge: a retired command is
  // absent from what Discord is sent, not merely present and answering with an
  // error. Discord's registry is what a staffer's picker is built from, so this
  // is the only place the withdrawal is visible to them.
  const retired = [...registry.values()].filter((s) => s.enabled === false).map((s) => s.name);
  assert.ok(retired.length > 0, "nothing is retired — this test would pass vacuously");
  for (const name of retired) assert.ok(!names.includes(name), `${name} is still registered`);
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
