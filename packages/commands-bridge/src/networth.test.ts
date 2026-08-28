import assert from "node:assert/strict";
import { test } from "node:test";
import type { HypixelResult, NetworthDTO } from "@sbr/shared-types";
import {
  categoryLabel,
  NETWORTH_NAMESPACE,
  networthComponents,
  renderNetworthCategoryEmbed,
  renderNetworthEmbed,
} from "./networth.js";

const IGN = "Aria";
const UUID = "4d9a51f6a1b7482c9e0b1d3c5f7a9b2e";
const TARGET = { uuid: UUID, ign: IGN };
const AT = "2026-08-13T17:59:00.000Z";

function nw(over: Partial<NetworthDTO> = {}): NetworthDTO {
  return {
    total: 8_240_000_000,
    exact: false,
    missing: ["Wardrobe", "Pets"],
    breakdown: { Purse: 140_000_000, Bank: 2_100_000_000, Inventory: 900_000_000, Storage: 5_100_000_000 },
    topItems: {
      Storage: [
        { name: "Hyperion", price: 1_100_000_000 },
        { name: "Necron's Chestplate", price: 640_000_000 },
      ],
      Inventory: [{ name: "Terminator", price: 420_000_000 }],
    },
    ...over,
  };
}

const live = (data: NetworthDTO): HypixelResult<NetworthDTO> => ({
  ok: true,
  value: { data, freshness: "LIVE", fetchedAt: AT, source: "LIVE" },
});

const failed = (): HypixelResult<NetworthDTO> => ({ ok: false, error: { state: "RATE_LIMITED" } });

const field = (view: { fields?: readonly { name: string; value: string }[] }, name: string) =>
  view.fields?.find((f) => f.name === name)?.value;

test("the breakdown is one column, richest first, with each share beside its value", () => {
  const view = renderNetworthEmbed(IGN, live(nw()), UUID);
  const lines = (field(view, "Where it is") ?? "").split("\n");

  assert.deepEqual(
    lines.map((l) => l.split(" ")[0]),
    ["**Storage**", "**Bank**", "**Inventory**", "**Purse**"],
  );
  assert.match(lines[0] ?? "", /\*\*Storage\*\* 5\.10b \(62%\)/);
});

test("every category is listed, not the six that happened to fit two rows", () => {
  // The old card capped at six to make two clean rows of three, so an account
  // with more sections was shown a breakdown that did not add up to its own
  // headline and said nothing about it.
  const breakdown = Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`cat_${String(i)}`, (9 - i) * 1_000_000]),
  );
  const view = renderNetworthEmbed(IGN, live(nw({ breakdown, total: 45_000_000, topItems: {} })), UUID);
  assert.equal((field(view, "Where it is") ?? "").split("\n").length, 9);
});

test("no percentage, and no other data, ends up in a field name", () => {
  // `field.name-data`: Discord bolds a field name with no room around it, so a
  // share parked there is the hardest thing on the card to compare.
  const view = renderNetworthEmbed(IGN, live(nw()), UUID);
  assert.equal(view.fields?.some((f) => /\d/.test(f.name)), false);
});

test("identity is the author row, and the title says what the card is", () => {
  const view = renderNetworthEmbed(IGN, live(nw()), UUID);
  assert.equal(view.title, "Networth");
  assert.equal(view.author?.name, IGN);
  assert.match(view.author?.iconUrl ?? "", new RegExp(UUID));
});

test("an estimate says so in the headline and names what is missing on the card", () => {
  const view = renderNetworthEmbed(IGN, live(nw()), UUID);
  assert.match(view.description ?? "", /\*\*8\.24b\*\* — estimate/);
  assert.equal(field(view, "Not counted"), "Wardrobe, Pets");
  assert.equal(view.color, "INFO");
});

test("a complete reading carries no caveat and reads as complete", () => {
  const view = renderNetworthEmbed(IGN, live(nw({ exact: true, missing: [] })), UUID);
  assert.equal(view.description, "**8.24b**");
  assert.equal(field(view, "Not counted"), undefined);
  assert.equal(view.color, "SUCCESS");
});

test("a hidden profile is unknown rather than zero", () => {
  const view = renderNetworthEmbed(IGN, live(nw({ total: null, breakdown: {}, topItems: {} })), UUID);
  assert.match(view.description ?? "", /^Unknown/);
  // No shares to be a share of, and nothing pretending there are categories.
  assert.match(field(view, "Where it is") ?? "", /Nothing on this profile/);
});

test("an unreadable read is a card that says so, not a card of empty sections", () => {
  const view = renderNetworthEmbed(IGN, failed(), UUID);
  assert.equal(view.fields, undefined);
  assert.equal(view.color, "WARNING");
  assert.equal(view.author?.name, IGN);
});

test("the menu offers only the categories it can actually open", () => {
  // Storage and Inventory have items; Bank and Purse are money, not things.
  // They stay on the overview — the money is there, we just cannot itemise it.
  const rows = networthComponents(nw(), TARGET);
  const options = rows[0]?.select?.options ?? [];
  assert.deepEqual(options.map((o) => o.value), ["Storage", "Inventory"]);
  assert.equal(options[0]?.label, "Storage");
  // Numbers in the description, so the label stays a label.
  assert.equal(options[0]?.description, "5.10b · 62%");
});

test("nothing itemisable means no menu at all", () => {
  // A control that opens onto "no items" for every category teaches people not
  // to press controls.
  assert.deepEqual(networthComponents(nw({ topItems: {} }), TARGET), []);
});

test("the menu carries everything the reply needs and nothing it does not", () => {
  const id = networthComponents(nw(), TARGET, "Papaya")[0]?.select?.customId ?? "";
  assert.deepEqual(id.split(":"), [NETWORTH_NAMESPACE, UUID, IGN, "Papaya"]);
  assert.ok(id.length <= 100, `customId is ${String(id.length)} chars`);

  // No profile is an empty segment rather than a missing one, so the router
  // still sees the IGN in the position the handler reads it from.
  assert.deepEqual((networthComponents(nw(), TARGET)[0]?.select?.customId ?? "").split(":"), [
    NETWORTH_NAMESPACE,
    UUID,
    IGN,
    "",
  ]);
});

test("a profile name carrying the separator is dropped rather than breaking the menu", () => {
  const id = networthComponents(nw(), TARGET, "od:d")[0]?.select?.customId ?? "";
  assert.deepEqual(id.split(":"), [NETWORTH_NAMESPACE, UUID, IGN, ""]);
});

test("a category card itemises what the overview no longer crams in", () => {
  const view = renderNetworthCategoryEmbed(IGN, live(nw()), "Storage", UUID);
  assert.equal(view.title, "Networth · Storage");
  assert.match(view.description ?? "", /\*\*5\.10b\*\* — 62% of the total/);

  const items = (field(view, "Most valuable") ?? "").split("\n");
  assert.equal(items.length, 2);
  // The share is of the category, because inside a drill-down the useful
  // question is "is this one sword most of my storage".
  assert.match(items[0] ?? "", /\*\*1\.\*\* Hyperion — 1\.10b \(22%\)/);
});

test("a category with a total but no items keeps the total", () => {
  const view = renderNetworthCategoryEmbed(IGN, live(nw()), "Bank", UUID);
  assert.match(view.description ?? "", /\*\*2\.10b\*\*/);
  assert.match(field(view, "Most valuable") ?? "", /items behind it are not/);
});

test("a category that has since emptied says so instead of rendering nothing", () => {
  // The menu was drawn against an older read; the reply is a fresh one.
  const view = renderNetworthCategoryEmbed(IGN, live(nw({ breakdown: { Purse: 1 } })), "Storage", UUID);
  assert.equal(view.title, "Networth · Storage");
  assert.match(view.description ?? "", /empty on this profile now/);
  assert.equal(view.fields, undefined);
});

test("snake_case and camelCase keys both read as words", () => {
  assert.equal(categoryLabel("personal_vault"), "Personal Vault");
  assert.equal(categoryLabel("personalBank"), "Personal Bank");
  assert.equal(categoryLabel("Storage"), "Storage");
});
