/**
 * The render layer's job at the edges: never hand Discord a payload it will
 * reject wholesale. Every current call site clamps its own lists, so these cover
 * the floor underneath them rather than any live caller.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionRowView, SelectMenuView } from "@sbr/shared-types";
import { replyOptions, toActionRow } from "./render.js";

function buttons(count: number): ActionRowView {
  return {
    buttons: Array.from({ length: count }, (_, i) => ({
      label: `Button ${i}`,
      style: "SECONDARY" as const,
      customId: `b-${i}`,
    })),
  };
}

function select(optionCount: number, overrides: Partial<SelectMenuView> = {}): ActionRowView {
  return {
    buttons: [],
    select: {
      customId: "picker",
      options: Array.from({ length: optionCount }, (_, i) => ({ label: `Option ${i}`, value: `v-${i}` })),
      ...overrides,
    },
  };
}

test("a row takes at most five buttons", () => {
  const row = toActionRow(buttons(8));
  assert.equal(row.components.length, 5);
});

test("a select takes at most twenty-five options", () => {
  const row = toActionRow(select(40));
  const json = row.toJSON().components[0] as { options: unknown[] };
  assert.equal(json.options.length, 25);
});

test("maxValues cannot outrun the options that survived truncation", () => {
  const row = toActionRow(select(40, { maxValues: 40 }));
  const json = row.toJSON().components[0] as { max_values?: number };
  assert.equal(json.max_values, 25);
});

test("an over-long button label is truncated rather than rejected", () => {
  const row = toActionRow({
    buttons: [{ label: "x".repeat(200), style: "PRIMARY", customId: "b" }],
  });
  const json = row.toJSON().components[0] as { label: string };
  assert.equal(json.label.length, 80);
});

test("an over-long option label and description are truncated too", () => {
  const row = toActionRow({
    buttons: [],
    select: {
      customId: "picker",
      options: [{ label: "l".repeat(200), value: "v", description: "d".repeat(200) }],
    },
  });
  const json = row.toJSON().components[0] as { options: { label: string; description: string }[] };
  assert.equal(json.options[0]?.label.length, 100);
  assert.equal(json.options[0]?.description.length, 100);
});

test("a reply carries at most five rows", () => {
  const options = replyOptions({
    text: "hello",
    ephemeral: true,
    components: [buttons(1), buttons(1), buttons(1), buttons(1), buttons(1), buttons(1), buttons(1)],
  });
  assert.equal(options.components?.length, 5);
});

test("every reply suppresses mentions, whatever the text says", () => {
  const options = replyOptions({ text: "@everyone welcome", ephemeral: false });
  assert.deepEqual(options.allowedMentions, { parse: [] });
  assert.equal(options.content, "@everyone welcome");
});
