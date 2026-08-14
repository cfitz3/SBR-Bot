import assert from "node:assert/strict";
import test from "node:test";
import type { TicketCategoryInput } from "@sbr/shared-types";
import {
  CATEGORY_LIMITS,
  SEED_CATEGORIES,
  categoryById,
  categoryByKey,
  findCategory,
  openableCategories,
  orderCategories,
  validateCategory,
} from "./categories.js";
import { category } from "./fixtures.test.js";

test("the five former enum values are seeded, in a stable order", () => {
  assert.deepEqual(
    SEED_CATEGORIES.map((c) => c.key),
    ["SUPPORT", "REPORT", "APPEAL", "APPLICATION", "OTHER"],
  );
  assert.deepEqual(
    SEED_CATEGORIES.map((c) => c.position),
    [0, 1, 2, 3, 4],
  );
});

test("ordering is by position, then by name", () => {
  const rows = [
    category({ id: "b", key: "B", name: "Beta", position: 1 }),
    category({ id: "c", key: "C", name: "Alpha", position: 1 }),
    category({ id: "a", key: "A", name: "Zulu", position: 0 }),
  ];
  assert.deepEqual(
    orderCategories(rows).map((c) => c.id),
    ["a", "c", "b"],
  );
});

test("openableCategories drops disabled ones", () => {
  const rows = [
    category({ id: "a", key: "A", position: 0 }),
    category({ id: "b", key: "B", position: 1, enabled: false }),
  ];
  assert.deepEqual(
    openableCategories(rows).map((c) => c.id),
    ["a"],
  );
});

test("findCategory matches key, name, emoji and substring, case-insensitively", () => {
  const rows = [
    category({ id: "a", key: "SUPPORT", name: "Support", emoji: "🎫", position: 0 }),
    category({ id: "b", key: "APPEAL", name: "Ban Appeal", emoji: null, position: 1 }),
  ];
  assert.equal(findCategory(rows, "support")?.id, "a");
  assert.equal(findCategory(rows, "  APPEAL ")?.id, "b");
  assert.equal(findCategory(rows, "ban appeal")?.id, "b");
  assert.equal(findCategory(rows, "🎫")?.id, "a");
  assert.equal(findCategory(rows, "appea")?.id, "b");
  assert.equal(findCategory(rows, "nothing at all"), null);
});

test("a blank query picks the guild's first openable category", () => {
  const rows = [
    category({ id: "a", key: "A", name: "A", position: 5 }),
    category({ id: "b", key: "B", name: "B", position: 1 }),
  ];
  assert.equal(findCategory(rows, null)?.id, "b");
  assert.equal(findCategory(rows, "   ")?.id, "b");
  assert.equal(findCategory([], null), null);
});

test("a disabled category reads as absent, not as an error", () => {
  const rows = [category({ id: "a", key: "SUPPORT", enabled: false })];
  assert.equal(findCategory(rows, "SUPPORT"), null);
  // ...but an open ticket can still resolve the category it was opened under.
  assert.equal(categoryById(rows, "a")?.id, "a");
  assert.equal(categoryByKey(rows, "SUPPORT")?.id, "a");
  assert.equal(categoryById(rows, null), null);
  assert.equal(categoryByKey(rows, "MISSING"), null);
});

function input(over: Partial<TicketCategoryInput> = {}): TicketCategoryInput {
  const base = category();
  const { id: _id, guildId: _guildId, ...rest } = base;
  return { ...rest, ...over };
}

test("a well-formed category has no problems", () => {
  assert.deepEqual(validateCategory(input()), []);
});

test("validateCategory reports every problem in one pass", () => {
  const problems = validateCategory(
    input({ key: "bad key!", name: "  ", channelNameTemplate: " ", memberLimit: 0, totalLimit: 0 }),
  );
  assert.ok(problems.length >= 5, `expected several problems, got ${problems.length}`);
  assert.ok(problems.some((p) => p.includes("letters, numbers")));
  assert.ok(problems.some((p) => p.includes("name is required")));
  assert.ok(problems.some((p) => p.includes("channel name template")));
});

test("the total limit is capped at Discord's channels-per-category ceiling", () => {
  assert.deepEqual(validateCategory(input({ totalLimit: CATEGORY_LIMITS.channelsPerParent })), []);
  const problems = validateCategory(input({ totalLimit: CATEGORY_LIMITS.channelsPerParent + 1 }));
  assert.ok(problems.some((p) => p.includes("cannot exceed 50")));
});

test("a description longer than Discord's select-menu cap is refused", () => {
  const problems = validateCategory(input({ description: "x".repeat(CATEGORY_LIMITS.description + 1) }));
  assert.ok(problems.some((p) => p.includes("100 characters or fewer")));
  assert.deepEqual(validateCategory(input({ description: "x".repeat(CATEGORY_LIMITS.description) })), []);
});

test("a category may ask at most five questions, and their ids must be unique", () => {
  const q = (id: string) =>
    ({ id, label: "Why?", placeholder: null, style: "SHORT", required: true, maxLength: null }) as const;
  assert.deepEqual(validateCategory(input({ questions: [q("a"), q("b"), q("c"), q("d"), q("e")] })), []);
  const tooMany = validateCategory(input({ questions: [q("a"), q("b"), q("c"), q("d"), q("e"), q("f")] }));
  assert.ok(tooMany.some((p) => p.includes("at most 5 questions")));
  const dupes = validateCategory(input({ questions: [q("a"), q("a")] }));
  assert.ok(dupes.some((p) => p.includes('duplicate question id "a"')));
});

test("negative cooldowns and out-of-range slow mode are refused", () => {
  assert.ok(validateCategory(input({ cooldownSeconds: -1 })).some((p) => p.includes("cooldown")));
  assert.deepEqual(validateCategory(input({ cooldownSeconds: 0 })), []);
  assert.ok(validateCategory(input({ slowModeSeconds: 21601 })).some((p) => p.includes("slow mode")));
  assert.deepEqual(validateCategory(input({ slowModeSeconds: 21600 })), []);
});
