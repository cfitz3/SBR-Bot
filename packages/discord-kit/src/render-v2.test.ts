/**
 * The V2 renderer's job: the same card, spelled as a container, and never a
 * payload Discord rejects whole. These cover the shape decisions (what becomes
 * subtext, what becomes a heading, where the hairlines fall) and the budget,
 * which is the only place truncation is allowed to happen.
 */
import { theme } from "@sbr/brand";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionRowView, EmbedView } from "@sbr/shared-types";
import {
  V2_LIMITS,
  fieldBlocks,
  fieldContent,
  footerContent,
  headerContent,
  timestampTag,
  toContainer,
  toTextContainer,
} from "./render-v2.js";

function clean(over: Partial<EmbedView> = {}): EmbedView {
  return { title: "Roster", description: "42 members", color: "INFO", ...over };
}

/** The JSON Discord actually receives, which is what the assertions read. */
function json(view: EmbedView, rows: readonly ActionRowView[] = []): Record<string, unknown> {
  return toContainer(view, rows).toJSON() as unknown as Record<string, unknown>;
}

function children(view: EmbedView, rows: readonly ActionRowView[] = []): any[] {
  return (json(view, rows) as any).components ?? [];
}

test("the accent is the view's colour and the only colour in the container", () => {
  const built = json(clean({ color: "WARNING" })) as any;
  assert.equal(built.accent_color, theme.embed.colors.WARNING);
  const nested = JSON.stringify(built.components);
  assert.ok(!nested.includes("accent_color"));
});

test("a card with no colour is neutral, not uncoloured", () => {
  assert.equal((json({ title: "Roster", description: "42 members" }) as any).accent_color, theme.embed.colors.NEUTRAL);
});

test("the author is subtext and the title is a heading", () => {
  const header = headerContent(clean({ author: { name: "Notch" } }));
  assert.equal(header, "-# Notch\n## Roster\n42 members");
});

test("a title with a url becomes one link, not a heading plus a bare url", () => {
  const header = headerContent(clean({ url: "https://example.com/r" }));
  assert.equal(header, "## [Roster](https://example.com/r)\n42 members");
});

test("an inline field keeps its label on the value's line; a block field does not", () => {
  assert.equal(fieldContent({ name: "Catacombs", value: "42", inline: true }), "**Catacombs** 42");
  assert.equal(fieldContent({ name: "Notes", value: "None" }), "**Notes**\nNone");
});

test("a run of inline fields collapses into one text display", () => {
  const blocks = fieldBlocks([
    { name: "A", value: "1", inline: true },
    { name: "B", value: "2", inline: true },
    { name: "C", value: "3" },
    { name: "D", value: "4", inline: true },
  ]);
  assert.deepEqual(blocks, ["**A** 1\n**B** 2", "**C**\n3", "**D** 4"]);
});

test("an empty field is dropped rather than rendered as a blank line", () => {
  assert.deepEqual(fieldBlocks([{ name: "", value: "", inline: true }]), []);
});

test("the timestamp renders as a tag Discord keeps correct, not a frozen string", () => {
  assert.equal(timestampTag("2026-01-01T00:00:00.000Z"), "<t:1767225600:R>");
});

test("an unparseable timestamp is dropped rather than thrown", () => {
  assert.equal(timestampTag("not a date"), null);
  assert.equal(footerContent(clean({ timestamp: "not a date" })), "");
});

test("footer and age share one subtext line", () => {
  const footer = footerContent(clean({ footer: "Season 4", timestamp: "2026-01-01T00:00:00.000Z" }));
  assert.equal(footer, "-# Season 4 · <t:1767225600:R>");
});

test("hairlines separate the header, the facts and the footer — nothing else", () => {
  const kinds = children(
    clean({ fields: [{ name: "A", value: "1" }], footer: "Season 4" }),
  ).map((c) => c.type);
  // 10 text display, 14 separator.
  assert.deepEqual(kinds, [10, 14, 10, 14, 10]);
});

test("a card with no fields and no footer draws no separator at all", () => {
  assert.deepEqual(children(clean()).map((c) => c.type), [10]);
});

test("a thumbnail rides beside the header as a section accessory", () => {
  const first = children(clean({ thumbnailUrl: "https://example.com/a.png" }))[0];
  assert.equal(first.type, 9); // section
  assert.equal(first.accessory.media.url, "https://example.com/a.png");
});

test("the author icon serves as the thumbnail when there is no other", () => {
  const first = children(clean({ author: { name: "Notch", iconUrl: "https://ex.com/i.png" } }))[0];
  assert.equal(first.accessory.media.url, "https://ex.com/i.png");
});

test("action rows live inside the container, not beside it", () => {
  const row: ActionRowView = {
    buttons: [{ label: "Refresh", style: "SECONDARY", customId: "refresh" }],
  };
  const kinds = children(clean(), [row]).map((c) => c.type);
  assert.ok(kinds.includes(1)); // action row
});

test("a card past the character budget stops adding rather than being rejected whole", () => {
  const fields = Array.from({ length: 40 }, (_, i) => ({ name: `F${i}`, value: "x".repeat(300) }));
  const built = json(clean({ fields, footer: "Season 4" })) as any;
  const text = JSON.stringify(built.components);
  assert.ok(text.length > 0);
  const total = built.components
    .filter((c: any) => c.type === 10)
    .reduce((n: number, c: any) => n + c.content.length, 0);
  assert.ok(total <= V2_LIMITS.characters, `${total} characters`);
});

test("a card past the component budget stays inside the slot cap", () => {
  const fields = Array.from({ length: 60 }, (_, i) => ({ name: `F${i}`, value: `${i}` }));
  const built = json(clean({ fields })) as any;
  assert.ok(built.components.length + 1 <= V2_LIMITS.components, `${built.components.length}`);
});

test("a plain sentence still gets a container, because V2 forbids content", () => {
  const built = toTextContainer("Nothing to show.", "DANGER").toJSON() as any;
  assert.equal(built.accent_color, theme.embed.colors.DANGER);
  assert.equal(built.components[0].content, "Nothing to show.");
});
