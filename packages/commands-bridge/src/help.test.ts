/**
 * `/help`'s contract, most of which is a contract about every *other* command.
 *
 * The old help list was seven hand-written lines that went stale silently. The
 * replacement can only stay true if two things hold, and neither is visible in
 * a code review of the file that breaks them: every reachable command declares
 * a category, and no retired one leaks into the list. Both are asserted here,
 * so adding a command without thinking about help fails a test rather than
 * quietly dropping the command out of the only list members read.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { copy } from "@sbr/brand";
import { ok } from "@sbr/shared-types";
import { HELP_CATEGORIES } from "@sbr/shared-types";
import { buildBridgeRegistry } from "./handlers.js";
import { buildHelp, groupCommands, renderHelpEmbed } from "./help.js";
import type { CommandSpec, HandlerDeps } from "./types.js";

const C = copy.embed.card;

const registry = (): readonly CommandSpec[] => [...buildBridgeRegistry().values()];

function deps(ign: string | null): HandlerDeps {
  return {
    identity: {
      async resolveByDiscordId() {
        return ok(ign === null ? null : { ign, minecraftUuid: "uuid-1" });
      },
    },
  } as unknown as HandlerDeps;
}

test("every reachable command declares a help category", () => {
  const missing = registry()
    .filter((spec) => spec.enabled !== false && spec.category === undefined)
    .map((spec) => spec.name);
  assert.deepEqual(
    missing,
    [],
    `these commands would not appear in /help: ${missing.join(", ")}`,
  );
});

test("retired commands are not listed", () => {
  const retired = registry().filter((spec) => spec.enabled === false).map((spec) => spec.name);
  assert.ok(retired.length > 0, "the fixture is only meaningful while something is retired");
  const listed = new Set([...groupCommands(registry()).values()].flat());
  for (const name of retired) assert.equal(listed.has(name), false, `${name} is retired but listed`);
});

test("categories are named, and every one used has a label", () => {
  const grouped = groupCommands(registry());
  for (const category of grouped.keys()) {
    assert.ok(HELP_CATEGORIES.includes(category));
    assert.ok(C.helpCategory[category].length > 0);
  }
});

test("the card stays inside the field budget and lists in category order", () => {
  const embed = renderHelpEmbed({ specs: registry(), ign: null });
  const fields = embed.fields ?? [];
  assert.ok(fields.length > 0);
  assert.ok(fields.length <= 6, `help card has ${fields.length} fields`);
  const order = fields.map((f) => f.name);
  const expected = HELP_CATEGORIES.map((c) => C.helpCategory[c]).filter((label) => order.includes(label));
  assert.deepEqual(order, expected);
});

test("the headline points an unlinked member at /link, and stops once they have", async () => {
  const unlinked = await buildHelp(registry(), "u1", deps(null));
  assert.equal(unlinked.embed?.description, C.helpUnlinked);
  assert.ok(C.helpUnlinked.includes("/link"));

  const linked = await buildHelp(registry(), "u1", deps("Refraction"));
  assert.equal(linked.embed?.description, C.helpLinked.replace("{ign}", "Refraction"));
});

test("a failed identity read still answers with the command list", async () => {
  const broken = {
    identity: {
      async resolveByDiscordId() {
        throw new Error("db down");
      },
    },
  } as unknown as HandlerDeps;
  const reply = await buildHelp(registry(), "u1", broken);
  assert.equal(reply.embed?.description, C.helpUnlinked);
  assert.ok((reply.embed?.fields ?? []).length > 0);
});

test("the in-game text names every listed category and no retired command", async () => {
  const reply = await buildHelp(registry(), "u1", deps(null));
  const grouped = groupCommands(registry());
  for (const category of grouped.keys()) assert.ok(reply.text?.includes(C.helpCategory[category]));
  for (const spec of registry()) {
    if (spec.enabled === false) assert.equal(reply.text?.includes(`/${spec.name} `), false);
  }
});

test("the link button is always offered", async () => {
  const reply = await buildHelp(registry(), "u1", deps("Refraction"));
  const buttons = (reply.components ?? []).flatMap((row) => row.buttons);
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0]?.customId, "help:link");
});
