import assert from "node:assert/strict";
import test from "node:test";
import type { TicketCategoryDTO } from "@sbr/shared-types";
import {
  TICKET_NAMESPACE,
  newTicketId,
  panelCategories,
  panelSelectId,
  renderPanel,
  suggestedStyle,
  ticketControls,
} from "./panel.js";
import { category, panel } from "./fixtures.test.js";

function many(count: number): readonly TicketCategoryDTO[] {
  return Array.from({ length: count }, (_, i) =>
    category({ id: `c${i}`, key: `K${i}`, name: `Category ${i}`, position: i }),
  );
}

function keys(count: number): readonly string[] {
  return Array.from({ length: count }, (_, i) => `K${i}`);
}

test("component ids are namespaced and carry their state", () => {
  assert.equal(newTicketId("SUPPORT"), `${TICKET_NAMESPACE}:new:SUPPORT`);
  assert.equal(panelSelectId("p1"), `${TICKET_NAMESPACE}:pick:p1`);
});

test("a panel keeps its own category order, not the global position order", () => {
  const rows = [
    category({ id: "a", key: "A", name: "A", position: 0 }),
    category({ id: "b", key: "B", name: "B", position: 1 }),
  ];
  const { resolved, missing } = panelCategories(panel({ categoryKeys: ["B", "A"] }), rows);
  assert.deepEqual(
    resolved.map((c) => c.key),
    ["B", "A"],
  );
  assert.deepEqual(missing, []);
});

test("a disabled category drops off the panel; a deleted one is reported", () => {
  const rows = [category({ id: "a", key: "A", enabled: false })];
  const off = panelCategories(panel({ categoryKeys: ["A"] }), rows);
  assert.deepEqual(off.resolved, []);
  assert.deepEqual(off.missing, []);

  const gone = panelCategories(panel({ categoryKeys: ["NOPE"] }), rows);
  assert.deepEqual(gone.missing, ["NOPE"]);
});

test("a panel pointing at a category that no longer exists refuses rather than renders", () => {
  const result = renderPanel(panel({ categoryKeys: ["GONE"] }), many(1));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.problem : null, "UNKNOWN_CATEGORY");
});

test("a panel with no enabled category refuses", () => {
  const result = renderPanel(panel({ categoryKeys: ["K0"] }), [category({ id: "c0", key: "K0", enabled: false })]);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.problem : null, "NO_CATEGORIES");
});

test("one category renders one button that says what it does", () => {
  const result = renderPanel(panel({ style: "BUTTONS", categoryKeys: keys(1) }), many(1));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const row = result.value.components[0];
  assert.equal(row?.buttons.length, 1);
  assert.equal(row?.buttons[0]?.label, "Create a ticket");
  assert.equal(row?.buttons[0]?.customId, newTicketId("K0"));
});

test("two to five categories each get their own named button", () => {
  const result = renderPanel(panel({ style: "BUTTONS", categoryKeys: keys(5) }), many(5));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.components[0]?.buttons.length, 5);
  assert.deepEqual(
    result.value.components[0]?.buttons.map((b) => b.label),
    ["Category 0", "Category 1", "Category 2", "Category 3", "Category 4"],
  );
});

test("a sixth button is refused, not silently dropped", () => {
  const result = renderPanel(panel({ style: "BUTTONS", categoryKeys: keys(6) }), many(6));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.problem : null, "TOO_MANY_BUTTONS");
  // The refusal has to tell the admin what to do about it.
  assert.match(result.ok === false ? result.detail : "", /menu/i);
});

test("a menu holds up to twenty-five categories", () => {
  const result = renderPanel(panel({ style: "SELECT", categoryKeys: keys(25) }), many(25));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const select = result.value.components[0]?.select;
  assert.equal(select?.options.length, 25);
  assert.equal(select?.customId, panelSelectId("p1"));
  assert.equal(select?.minValues, 1);
  assert.equal(select?.maxValues, 1);
});

test("a twenty-sixth option is refused", () => {
  const result = renderPanel(panel({ style: "SELECT", categoryKeys: keys(26) }), many(26));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.problem : null, "TOO_MANY_OPTIONS");
});

test("menu option descriptions are clipped to Discord's hundred characters", () => {
  const long = category({ id: "c0", key: "K0", name: "K", description: "x".repeat(150) });
  const result = renderPanel(panel({ style: "SELECT", categoryKeys: ["K0"] }), [long]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.components[0]?.select?.options[0]?.description?.length, 100);
});

test("a blank description is omitted rather than sent as an empty string", () => {
  const blank = category({ id: "c0", key: "K0", description: "   " });
  const result = renderPanel(panel({ style: "SELECT", categoryKeys: ["K0"] }), [blank]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.components[0]?.select?.options[0]?.description, undefined);
});

test("suggestedStyle switches at the button cap", () => {
  assert.equal(suggestedStyle(1), "BUTTONS");
  assert.equal(suggestedStyle(5), "BUTTONS");
  assert.equal(suggestedStyle(6), "SELECT");
});

test("staff get a close button, members get a close request", () => {
  const staff = ticketControls({ claimable: true, claimed: false, closeButton: true, isStaff: true });
  assert.deepEqual(
    staff[0]?.buttons.map((b) => b.customId),
    [`${TICKET_NAMESPACE}:claim`, `${TICKET_NAMESPACE}:close`],
  );

  const member = ticketControls({ claimable: true, claimed: false, closeButton: true, isStaff: false });
  assert.deepEqual(
    member[0]?.buttons.map((b) => b.customId),
    [`${TICKET_NAMESPACE}:closereq`],
  );
});

test("a claimed ticket offers release; a guild with both buttons off gets no row", () => {
  const claimed = ticketControls({ claimable: true, claimed: true, closeButton: false, isStaff: true });
  assert.deepEqual(
    claimed[0]?.buttons.map((b) => b.customId),
    [`${TICKET_NAMESPACE}:release`],
  );
  assert.deepEqual(ticketControls({ claimable: false, claimed: false, closeButton: false, isStaff: true }), []);
});
