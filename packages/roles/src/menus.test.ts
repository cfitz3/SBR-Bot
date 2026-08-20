import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ROLE_MENUS,
  MAX_MENUS,
  decideMenuPress,
  findRoleMenu,
  parseRoleMenus,
  validateRoleMenus,
  type RoleMenu,
} from "./menus.js";

const option = (over: Partial<RoleMenu["options"][number]> = {}) => ({
  key: "red",
  roleId: "111111111111111111",
  label: "Red",
  description: null,
  emoji: null,
  ...over,
});

const menu = (over: Partial<RoleMenu> = {}): RoleMenu => ({
  id: "colours",
  title: "Pick a colour",
  body: "",
  channelId: null,
  messageId: null,
  exclusive: false,
  options: [option(), option({ key: "blue", roleId: "222222222222222222", label: "Blue" })],
  ...over,
});

test("a guild that has never opened the page has no menus", () => {
  assert.deepEqual(parseRoleMenus(null), DEFAULT_ROLE_MENUS);
  assert.deepEqual(parseRoleMenus({ menus: "nonsense" }), DEFAULT_ROLE_MENUS);
});

test("parse drops only what it cannot understand", () => {
  const doc = parseRoleMenus({
    menus: [
      { id: "colours", title: "Pick a colour", options: [{ key: "red", roleId: "1", label: "Red" }] },
      // No id at all: unroutable, so unpublishable.
      { title: "Nameless", options: [{ key: "x", roleId: "2" }] },
      { id: "pings", options: [{ key: "events", roleId: "3" }, { roleId: "4" }] },
    ],
  });
  assert.deepEqual(
    doc.menus.map((m) => m.id),
    ["colours", "pings"],
  );
  // A missing title falls back to the id rather than rendering a blank embed.
  assert.equal(doc.menus[1]?.title, "pings");
  // A label-less option keeps its key as the button text; the unkeyed one goes.
  assert.deepEqual(doc.menus[1]?.options.map((o) => o.key), ["events"]);
  assert.equal(doc.menus[1]?.options[0]?.label, "events");
});

test("duplicate ids and duplicate option keys collapse to the first", () => {
  const doc = parseRoleMenus({
    menus: [
      { id: "colours", title: "First", options: [{ key: "red", roleId: "1", label: "Red" }] },
      { id: "colours", title: "Second", options: [{ key: "red", roleId: "9", label: "Nope" }] },
    ],
  });
  assert.equal(doc.menus.length, 1);
  assert.equal(doc.menus[0]?.title, "First");
});

test("an id that could not survive a custom id is refused on write", () => {
  // A colon would split the custom id into segments the router misreads.
  assert.match(validateRoleMenus({ menus: [{ ...menu(), id: "colour:picker" }] }) ?? "", /needs an id/);
  assert.match(validateRoleMenus({ menus: [{ ...menu(), id: "a".repeat(40) }] }) ?? "", /needs an id/);
  // Case is not a mistake, it is normalised — the panel should not reject it.
  assert.equal(validateRoleMenus({ menus: [{ ...menu(), id: "Colours" }] }), null);
  assert.equal(parseRoleMenus({ menus: [{ ...menu(), id: "Colours" }] }).menus[0]?.id, "colours");
});

test("write refuses what read would silently drop", () => {
  assert.equal(validateRoleMenus({ menus: [menu()] }), null);
  assert.match(validateRoleMenus({ menus: [{ ...menu(), title: "  " }] }) ?? "", /needs a title/);
  assert.match(validateRoleMenus({ menus: [{ ...menu(), options: [] }] }) ?? "", /no roles on it/);
  assert.match(
    validateRoleMenus({ menus: [{ ...menu(), options: [option(), option({ key: "crimson" })] }] }) ?? "",
    /already offers/,
  );
  assert.match(
    validateRoleMenus({ menus: [{ ...menu(), options: [option({ roleId: "" })] }] }) ?? "",
    /needs a role/,
  );
  assert.match(
    validateRoleMenus({ menus: Array.from({ length: MAX_MENUS + 1 }, (_, i) => ({ ...menu(), id: `m${String(i)}` })) }) ??
      "",
    /at most/,
  );
});

test("a press on a menu that no longer offers that option is not an error", () => {
  assert.equal(decideMenuPress(menu(), "green", []), null);
});

test("a toggle menu adds what you do not have and removes what you do", () => {
  const on = decideMenuPress(menu(), "red", []);
  assert.deepEqual(on, { option: option(), add: ["111111111111111111"], remove: [], granted: true });

  const off = decideMenuPress(menu(), "red", ["111111111111111111", "222222222222222222"]);
  // Only the pressed role moves: holding both is legal on a toggle menu.
  assert.deepEqual(off?.remove, ["111111111111111111"]);
  assert.deepEqual(off?.add, []);
  assert.equal(off?.granted, false);
});

test("an exclusive menu swaps in one decision", () => {
  const press = decideMenuPress(menu({ exclusive: true }), "blue", ["111111111111111111", "999"]);
  assert.deepEqual(press?.add, ["222222222222222222"]);
  // The unrelated role is untouched: a menu speaks only for its own options.
  assert.deepEqual(press?.remove, ["111111111111111111"]);
});

test("an exclusive menu still lets you put the last one down", () => {
  const press = decideMenuPress(menu({ exclusive: true }), "red", ["111111111111111111"]);
  assert.deepEqual(press?.remove, ["111111111111111111"]);
  assert.deepEqual(press?.add, []);
});

test("findRoleMenu answers null rather than throwing on a stale id", () => {
  const doc = { menus: [menu()] };
  assert.equal(findRoleMenu(doc, "colours")?.title, "Pick a colour");
  assert.equal(findRoleMenu(doc, "gone"), null);
});
