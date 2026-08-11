import assert from "node:assert/strict";
import test from "node:test";
import { summariseNetworth } from "./skyhelper.js";

const result = {
  networth: 10_000_000_000,
  purse: 5_000_000,
  bank: 1_000_000_000,
  personalBank: 0,
  types: {
    inventory: {
      total: 3_000_000_000,
      items: [
        { name: "§dHyperion", price: 2_000_000_000 },
        { name: "Terminator", price: 1_000_000_000 },
      ],
    },
    wardrobe: { total: 0, items: [] },
  },
};

test("categories and coin sections both land in the breakdown", () => {
  const c = summariseNetworth(result);
  assert.equal(c.total, 10_000_000_000);
  assert.deepEqual(c.breakdown, {
    purse: 5_000_000,
    bank: 1_000_000_000,
    inventory: 3_000_000_000,
  });
});

test("a worthless category is left out rather than shown as zero", () => {
  // A wardrobe costed at 0 is noise in an embed with six slots for real value.
  assert.equal("wardrobe" in summariseNetworth(result).breakdown, false);
  assert.equal("personalBank" in summariseNetworth(result).breakdown, false);
});

test("item names lose their colour codes", () => {
  assert.equal(summariseNetworth(result).items?.["inventory"]?.[0]?.name, "Hyperion");
});

test("an unrecognisable result degrades to an unknown total, not a throw", () => {
  const c = summariseNetworth(null);
  assert.equal(c.total, null);
  assert.deepEqual(c.breakdown, {});
  assert.deepEqual(c.items, {});
});

test("a total-only run reports categories with no items rather than fake ones", () => {
  const c = summariseNetworth({ networth: 5, types: { inventory: { total: 5 } } });
  assert.deepEqual(c.breakdown, { inventory: 5 });
  assert.deepEqual(c.items, {});
});
