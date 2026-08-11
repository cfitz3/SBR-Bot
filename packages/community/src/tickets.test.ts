import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TICKET_TYPES,
  findTicketType,
  openableTicketTypes,
  resolveTicketTypes,
  type StoredTicketType,
} from "./tickets.js";

const G = "guild-1";

function stored(over: Partial<StoredTicketType> = {}): StoredTicketType {
  return {
    id: "t1",
    key: "support",
    label: "Support",
    emoji: null,
    category: "SUPPORT",
    parentChannelId: null,
    staffRoleIds: [],
    prompt: null,
    position: 0,
    enabled: true,
    ...over,
  };
}

test("a guild with no rows still gets the full built-in menu", () => {
  const types = resolveTicketTypes(G, []);
  assert.equal(types.length, DEFAULT_TICKET_TYPES.length);
  assert.ok(types.every((t) => t.source === "DEFAULT" && t.id === null));
});

test("a row shadows the default with the same key", () => {
  const types = resolveTicketTypes(G, [stored({ label: "Help desk", prompt: "What's up?" })]);
  const support = types.find((t) => t.key === "support");
  assert.equal(support?.label, "Help desk");
  assert.equal(support?.prompt, "What's up?");
  assert.equal(support?.source, "GUILD");
  // Shadowing one default does not remove the rest.
  assert.equal(types.length, DEFAULT_TICKET_TYPES.length);
});

test("a key that matches no default is a guild's own type", () => {
  const types = resolveTicketTypes(G, [stored({ id: "t9", key: "staff-app", label: "Staff app", position: 9 })]);
  assert.equal(types.length, DEFAULT_TICKET_TYPES.length + 1);
  assert.equal(types.at(-1)?.key, "staff-app");
});

test("the menu is ordered by position, then label", () => {
  const types = resolveTicketTypes(G, [
    stored({ id: "a", key: "support", label: "Zeta", position: 0 }),
    stored({ id: "b", key: "other", label: "Alpha", position: 0 }),
  ]);
  assert.deepEqual([types[0]?.label, types[1]?.label], ["Alpha", "Zeta"]);
});

test("a disabled type is listed for the panel but not openable", () => {
  const types = resolveTicketTypes(G, [stored({ enabled: false })]);
  assert.equal(types.find((t) => t.key === "support")?.enabled, false);
  assert.equal(openableTicketTypes(types).some((t) => t.key === "support"), false);
});

test("no argument opens the first type in the menu", () => {
  const types = resolveTicketTypes(G, []);
  assert.equal(findTicketType(types, null)?.key, "support");
  assert.equal(findTicketType(types, "  ")?.key, "support");
});

test("a type is found by key or by label, either case", () => {
  const types = resolveTicketTypes(G, []);
  assert.equal(findTicketType(types, "APPEAL")?.key, "appeal");
  assert.equal(findTicketType(types, "Report a member")?.key, "report");
});

test("a disabled type cannot be opened by naming it", () => {
  const types = resolveTicketTypes(G, [stored({ key: "appeal", label: "Appeal", enabled: false })]);
  assert.equal(findTicketType(types, "appeal"), null);
});

test("a guild that disabled everything has nothing to open", () => {
  const types = resolveTicketTypes(
    G,
    DEFAULT_TICKET_TYPES.map((d, i) => stored({ id: `d${i}`, key: d.key, label: d.label, enabled: false })),
  );
  assert.equal(findTicketType(types, null), null);
});

test("built-in keys are unique", () => {
  assert.equal(new Set(DEFAULT_TICKET_TYPES.map((d) => d.key)).size, DEFAULT_TICKET_TYPES.length);
});
