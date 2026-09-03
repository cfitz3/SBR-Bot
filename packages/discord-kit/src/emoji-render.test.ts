/**
 * One bad emoji may cost its own button. It may never cost the message.
 *
 * The failure this pins down: Discord answers a malformed component emoji with
 * `components[0].components[0].emoji.name[COMPONENT_INVALID_EMOJI]` and rejects
 * the entire payload, so a single mistyped ticket category used to take the
 * whole panel down.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionRowView } from "@sbr/shared-types";
import { toActionRow, setEmojiWarningSink } from "./render.js";

function firstButton(row: ActionRowView): any {
  return (toActionRow(row).toJSON() as any).components[0];
}

test("a unicode emoji reaches the payload as a name", () => {
  const json = firstButton({ buttons: [{ label: "Open", style: "PRIMARY", customId: "a", emoji: "🎫" }] });
  assert.deepEqual(json.emoji, { name: "🎫" });
});

test("a custom emoji reaches the payload as an id", () => {
  const json = firstButton({
    buttons: [{ label: "Open", style: "PRIMARY", customId: "a", emoji: "<a:spin:123456789012345>" }],
  });
  assert.equal(json.emoji.id, "123456789012345");
  assert.equal(json.emoji.animated, true);
});

test("an emoji Discord would reject is dropped, and the button still sends", () => {
  const warnings: string[] = [];
  setEmojiWarningSink((_message, context) => warnings.push(context.emoji));
  try {
    const json = firstButton({ buttons: [{ label: "Open", style: "PRIMARY", customId: "a", emoji: ":)" }] });
    assert.equal(json.emoji, undefined);
    assert.equal(json.label, "Open");
    assert.deepEqual(warnings, [":)"]);
  } finally {
    setEmojiWarningSink(() => undefined);
  }
});

test("a select option drops its bad emoji rather than the menu", () => {
  setEmojiWarningSink(() => undefined);
  const row = toActionRow({
    buttons: [],
    select: {
      customId: "pick",
      options: [
        { label: "Support", value: "support", emoji: ":tada:" },
        { label: "Report", value: "report", emoji: "⚠️" },
      ],
    },
  });
  const options = (row.toJSON() as any).components[0].options;
  assert.equal(options.length, 2);
  assert.equal(options[0].emoji, undefined);
  assert.deepEqual(options[1].emoji, { name: "⚠️" });
});
