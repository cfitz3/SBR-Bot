/**
 * The command-copy layer, checked against both real registries.
 *
 * This lives in the gallery package for the same reason the gallery does: it is
 * the only package that can see the bridge and admin registries at once. Neither
 * command package may import the other, and `@sbr/brand` may not import either
 * (they depend on it), so a test that needs both has exactly one home.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { copy } from "@sbr/brand";
import { buildAdminRegistry } from "@sbr/commands-admin";
import { BUG_TICKET_BUTTON_ID } from "@sbr/embed-kit";
import { isPermanentCategory, newTicketId, SEED_CATEGORIES } from "@sbr/tickets";
import { buildBridgeRegistry } from "@sbr/commands-bridge";

/** The resolved table — defaults with `brand/copy.ts` merged over it. */
const COMMANDS = copy.command;

const bridge = buildBridgeRegistry();
const admin = buildAdminRegistry();

/** Discord's cap. `builders.ts` truncates past this, silently, at registration. */
const DESCRIPTION_MAX = 100;

test("the two registries do not share a command name", () => {
  // `command.<name>` is one flat namespace, so a collision would silently give
  // both commands the same words. Nothing prevents one at the type level; this
  // is the thing that notices.
  const shared = [...bridge.keys()].filter((name) => admin.has(name));
  assert.deepEqual(shared, []);
});

test("every command description comes from the copy layer", () => {
  for (const [name, spec] of [...bridge, ...admin]) {
    const entry = COMMANDS[name];
    if (entry === undefined) continue; // covered by the coverage test below
    assert.equal(spec.description, entry.description, name);
    for (const opt of spec.options ?? []) {
      const text: string | undefined = entry.option?.[opt.name];
      if (text !== undefined) assert.equal(opt.description, text, `${name}.${opt.name}`);
    }
  }
});

test("every command and option is behind a key", () => {
  // Part II decision 2 is exhaustive coverage. A command added without copy
  // still works — the overlay falls through to its literal — so only a test can
  // tell you it happened.
  const missing: string[] = [];
  for (const [name, spec] of [...bridge, ...admin]) {
    const entry = COMMANDS[name];
    if (entry === undefined) {
      missing.push(name);
      continue;
    }
    for (const opt of spec.options ?? []) {
      if (entry.option?.[opt.name] === undefined) missing.push(`${name}.${opt.name}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("no copy key names a command that no longer exists", () => {
  const dead = Object.keys(COMMANDS).filter((name) => !bridge.has(name) && !admin.has(name));
  assert.deepEqual(dead, []);
});

test("no description exceeds what Discord will accept", () => {
  const long = [...bridge, ...admin].flatMap(([name, spec]) => [
    ...(spec.description.length > DESCRIPTION_MAX ? [name] : []),
    ...(spec.options ?? [])
      .filter((o) => o.description.length > DESCRIPTION_MAX)
      .map((o) => `${name}.${o.name}`),
  ]);
  assert.deepEqual(long, []);
});

test("the failure button opens the category that cannot be taken away", () => {
  // `@sbr/embed-kit` writes the id out rather than importing `@sbr/tickets`,
  // because it sits under both command packages and the gallery and a ticket
  // dependency for one string would be the wrong trade. This is the check that
  // makes the trade safe: renaming the namespace fails here, not in production
  // as a button that answers "that control is no longer in use".
  assert.equal(BUG_TICKET_BUTTON_ID, newTicketId("BUG"));

  // And the category it opens is seeded everywhere and cannot be removed or
  // disabled, which is what stops the button from being a dead end.
  assert.ok(SEED_CATEGORIES.some((c) => c.key === "BUG"));
  assert.ok(isPermanentCategory("BUG"));
});
