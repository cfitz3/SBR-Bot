import assert from "node:assert/strict";
import { test } from "node:test";

import { applyCommandCopy, withCommandCopy, type CommandCopyTable, type CopyableSpec } from "./commands-overlay.js";

/** A spec with fields the overlay knows nothing about — they must survive it. */
interface Spec extends CopyableSpec {
  readonly cooldownMs: number;
  readonly handler: () => string;
}

const spec: Spec = {
  name: "networth",
  description: "the literal in the handler file",
  options: [
    { name: "player", description: "handler wording" },
    { name: "profile", description: "handler wording" },
  ],
  cooldownMs: 5_000,
  handler: () => "ran",
};

const table: CommandCopyTable = {
  networth: { description: "Networth estimate", option: { player: "Minecraft username" } },
};

test("copy replaces the description a spec declares", () => {
  assert.equal(applyCommandCopy(spec, table).description, "Networth estimate");
});

test("an option with a key is overridden and one without keeps its literal", () => {
  const options = applyCommandCopy(spec, table).options ?? [];
  assert.deepEqual(
    options.map((o) => [o.name, o.description]),
    [
      ["player", "Minecraft username"],
      ["profile", "handler wording"],
    ],
  );
});

test("everything that is not prose is carried through untouched", () => {
  const out = applyCommandCopy(spec, table);
  assert.equal(out.cooldownMs, 5_000);
  assert.equal(out.handler(), "ran");
});

test("a command with no entry is returned as-is", () => {
  // The honest default for a newly added command: it works, it is simply not
  // overridable until somebody adds it to `defaults/commands.ts`.
  const orphan: Spec = { ...spec, name: "brand-new" };
  assert.equal(applyCommandCopy(orphan, table), orphan);
});

test("a spec with no options gains none", () => {
  const bare: CopyableSpec = { name: "networth", description: "x" };
  assert.equal(applyCommandCopy(bare, table).options, undefined);
});

test("overlaying a registry preserves its keys and their order", () => {
  const registry = new Map<string, Spec>([
    ["networth", spec],
    ["other", { ...spec, name: "other" }],
  ]);
  assert.deepEqual([...withCommandCopy(registry, table).keys()], ["networth", "other"]);
});

test("the input registry is not mutated", () => {
  const registry = new Map<string, Spec>([["networth", spec]]);
  withCommandCopy(registry, table);
  assert.equal(registry.get("networth")?.description, "the literal in the handler file");
});
