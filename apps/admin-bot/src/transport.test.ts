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

test("the renamed note command is the one published, and the old name is gone", () => {
  // `rest.put` replaces the whole scope, so a spec that is no longer built is
  // deregistered rather than merely inert — which is what a rename has to mean.
  const names = payload().map((c) => c.name);
  assert.equal(names.includes("member-note"), false);
  assert.ok(names.includes("note"));
});

test("the staff utilities publish no action option — the verbs live on the card", () => {
  for (const name of ["tickets", "rolemenu", "sticky"]) {
    const command = payload().find((c) => c.name === name);
    assert.ok(command, `${name} should be registered`);
    assert.equal(
      command.options?.some((o) => o.name === "action"),
      false,
      `${name} still asks for an action up front`,
    );
  }
});

test("tickets takes only the nouns it needs", () => {
  const tickets = payload().find((c) => c.name === "tickets");
  assert.deepEqual(tickets?.options?.map((o) => o.name), ["id", "reason"]);
});
