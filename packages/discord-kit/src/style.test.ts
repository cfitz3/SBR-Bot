/**
 * Two things are proved here.
 *
 * First, that the palette and the house style have exactly one origin — these
 * fail the moment a second copy reappears, which is what happened last time.
 *
 * Second, one case per rule id in `checkEmbed`. The checker is the thing that
 * decides whether every card in the platform is acceptable, so a rule that
 * silently stopped firing would be worse than no checker at all: it would report
 * a clean gallery that isn't.
 */
import { theme } from "@sbr/brand";
import { FLATTEN_SEPARATOR, INLINE_ROW, padInlineRow, type EmbedView } from "@sbr/shared-types";
import assert from "node:assert/strict";
import { test } from "node:test";

import { toEmbed } from "./render.js";
import { checkEmbed, checkEmbeds, EMBED_LIMITS, EMBED_STYLE, VIEW_COLORS, type StyleIssue } from "./style.js";

/** A card that passes cleanly, so each case below differs in exactly one way. */
function clean(over: Partial<EmbedView> = {}): EmbedView {
  return { title: "Roster", description: "42 members", color: "INFO", ...over };
}

function rules(view: EmbedView): readonly string[] {
  return checkEmbed(view).map((i) => i.rule);
}

function only(view: EmbedView, rule: string): StyleIssue {
  const hits = checkEmbed(view).filter((i) => i.rule === rule);
  assert.equal(hits.length, 1, `expected exactly one ${rule}, got ${JSON.stringify(checkEmbed(view))}`);
  return hits[0]!;
}

test("the exported palette is the resolved theme, not a copy of it", () => {
  assert.equal(VIEW_COLORS, theme.embed.colors);
});

test("a rendered embed takes its colour from the palette", () => {
  // `render.ts` used to hold a third copy of these five numbers. This asserts it
  // is reading the shared one, at the only place the value can be observed.
  const embed = toEmbed({ title: "Card", color: "DANGER" });
  assert.equal(embed.data.color, theme.embed.colors.DANGER);
});

test("an embed with no stated colour falls back to NEUTRAL", () => {
  assert.equal(toEmbed({ title: "Card" }).data.color, theme.embed.colors.NEUTRAL);
});

test("the house style is the resolved theme's", () => {
  assert.equal(EMBED_STYLE, theme.embed.style);
});

test("shared-types' flatten separator agrees with the theme", () => {
  // `flattenEmbed` cannot import the theme — `@sbr/brand` depends on
  // `@sbr/shared-types`, so reading it back would be a cycle. Its default is
  // therefore a second declaration of the same choice, and this is what stops the
  // two drifting apart the way the palette copies did.
  assert.equal(FLATTEN_SEPARATOR, theme.embed.style.separator);
});

test("shared-types' inline row width agrees with the theme", () => {
  // Same cycle, same remedy as the separator above: `padInlineRow` is used by
  // renderers in packages that cannot see the theme, so its default width is a
  // second declaration of `inlineRow` and this is what pins the two together.
  assert.equal(INLINE_ROW, theme.embed.style.inlineRow);
});

test("padding a short inline run satisfies the rule that motivated it", () => {
  // The pairing that matters: `padInlineRow` exists because `inline.ragged`
  // fires, so the fix and the rule are asserted against each other rather than
  // each being tested against its own idea of a row.
  const fields = Array.from({ length: 4 }, (_, i) => ({ name: `f${i}`, value: "v", inline: true }));
  const ragged: EmbedView = { title: "Card", color: "INFO", fields };
  const padded: EmbedView = { title: "Card", color: "INFO", fields: padInlineRow(fields) };

  assert.ok(checkEmbed(ragged).some((i) => i.rule === "inline.ragged"));
  assert.deepEqual(checkEmbed(padded), []);
});

test("padInlineRow leaves a run that already fills its row alone", () => {
  const fields = Array.from({ length: 3 }, (_, i) => ({ name: `f${i}`, value: "v", inline: true }));
  assert.equal(padInlineRow(fields), fields);
  assert.equal(padInlineRow([{ name: "a", value: "b" }]).length, 1);
});

test("the spacer padInlineRow adds is legal to send", () => {
  // A literal empty string here would make Discord reject the whole message —
  // which is `field.empty`, an error, so the cure would be worse than the
  // symptom. The zero-width space is deliberate and this is what says so.
  const padded = padInlineRow([{ name: "only", value: "one", inline: true }]);
  const errors = checkEmbed({ title: "Card", color: "INFO", fields: padded }).filter(
    (i) => i.severity === "error",
  );
  assert.deepEqual(errors, []);
});

test("the separator is not the one the style checker rejects", () => {
  // The old hardcoded value. Named explicitly so a revert is a red test rather
  // than a quiet regression.
  assert.notEqual(theme.embed.style.separator, " | ");
});

// ── The checker: one case per rule id ────────────────────────────────────────

test("a card that follows the house style reports nothing", () => {
  assert.deepEqual(rules(clean()), []);
});

test("limit.title — over Discord's cap, and it is an error", () => {
  const issue = only(clean({ title: "x".repeat(EMBED_LIMITS.title + 1) }), "limit.title");
  assert.equal(issue.severity, "error");
});

test("limit.description", () => {
  assert.ok(rules(clean({ description: "x".repeat(EMBED_LIMITS.description + 1) })).includes("limit.description"));
});

test("limit.footer", () => {
  // Also trips footer.length; the limit is the one that matters, and both fire
  // because a 2049-character footer is wrong twice over.
  const found = rules(clean({ footer: "x".repeat(EMBED_LIMITS.footer + 1) }));
  assert.ok(found.includes("limit.footer"));
  assert.ok(found.includes("footer.length"));
});

test("limit.fields", () => {
  const fields = Array.from({ length: EMBED_LIMITS.fields + 1 }, (_, i) => ({ name: `f${i}`, value: "v" }));
  assert.equal(only(clean({ fields }), "limit.fields").severity, "error");
});

test("limit.field-name and limit.field-value", () => {
  const found = rules(
    clean({
      fields: [
        { name: "n".repeat(EMBED_LIMITS.fieldName + 1), value: "v" },
        { name: "n", value: "v".repeat(EMBED_LIMITS.fieldValue + 1) },
      ],
    }),
  );
  assert.ok(found.includes("limit.field-name"));
  assert.ok(found.includes("limit.field-value"));
});

test("limit.total — each part legal, the sum is not", () => {
  const fields = Array.from({ length: 8 }, (_, i) => ({ name: `f${i}`, value: "v".repeat(1000) }));
  assert.ok(rules(clean({ fields })).includes("limit.total"));
});

test("field.empty — a blank name or value is rejected by Discord, not by taste", () => {
  assert.equal(only(clean({ fields: [{ name: "  ", value: "v" }] }), "field.empty").severity, "error");
  assert.ok(rules(clean({ fields: [{ name: "n", value: "" }] })).includes("field.empty"));
});

test("empty — nothing to render", () => {
  assert.equal(only({ color: "INFO" }, "empty").severity, "error");
});

test("color.missing — absence is an oversight, NEUTRAL is a choice", () => {
  assert.ok(rules({ title: "Roster", description: "42 members" }).includes("color.missing"));
  assert.ok(!rules(clean({ color: "NEUTRAL" })).includes("color.missing"));
});

test("url.scheme", () => {
  assert.equal(only(clean({ url: "http://example.com" }), "url.scheme").severity, "error");
  assert.ok(!rules(clean({ url: "https://example.com" })).includes("url.scheme"));
});

test("raw-id — a bare snowflake, but not a wrapped mention", () => {
  assert.ok(rules(clean({ description: "banned 123456789012345678" })).includes("raw-id"));
  assert.ok(!rules(clean({ description: "banned <@123456789012345678>" })).includes("raw-id"));
  assert.ok(!rules(clean({ description: "in <#123456789012345678>" })).includes("raw-id"));
});

test("placeholder — another project's dialect for 'unknown'", () => {
  for (const text of ["N/A", "null", "TBD", "--"]) {
    assert.ok(rules(clean({ fields: [{ name: "Networth", value: text }] })).includes("placeholder"), text);
  }
  // Ours is not a placeholder — it is the answer.
  assert.ok(
    !rules(clean({ fields: [{ name: "Networth", value: EMBED_STYLE.unknown }] })).includes("placeholder"),
  );
});

test("separator — the wrong join character, reported once per text", () => {
  assert.equal(only(clean({ description: "cata 42 | sa 51.3 | nw 8.2b" }), "separator").severity, "warning");
  assert.ok(!rules(clean({ description: `cata 42${EMBED_STYLE.separator}sa 51.3` })).includes("separator"));
});

test("title.punctuation — a title is a label, not a sentence", () => {
  assert.ok(rules(clean({ title: "Roster." })).includes("title.punctuation"));
  assert.ok(!rules(clean({ title: "Who's next?" })).includes("title.punctuation"));
});

test("title.shouting", () => {
  assert.ok(rules(clean({ title: "GUILD ROSTER" })).includes("title.shouting"));
  // Short all-caps is an acronym, not a raised voice.
  assert.ok(!rules(clean({ title: "XP" })).includes("title.shouting"));
});

test("description.lines", () => {
  const long = Array.from({ length: EMBED_STYLE.descriptionLines + 1 }, (_, i) => `line ${i}`).join("\n");
  assert.ok(rules(clean({ description: long })).includes("description.lines"));
});

test("markdown.heading — a heading inside a card competes with its title", () => {
  assert.ok(rules(clean({ description: "## Skills\nfoo" })).includes("markdown.heading"));
  assert.ok(!rules(clean({ description: "**Skills**\nfoo" })).includes("markdown.heading"));
});

test("field.count — legal for Discord, still a wall", () => {
  const fields = Array.from({ length: EMBED_STYLE.fields + 1 }, (_, i) => ({ name: `f${i}`, value: "v" }));
  const issue = only(clean({ fields }), "field.count");
  assert.equal(issue.severity, "warning");
  assert.ok(!rules(clean({ fields })).includes("limit.fields"));
});

test("inline.ragged — a run that leaves one field alone on its own row", () => {
  const inline = (n: number): EmbedView =>
    clean({ fields: Array.from({ length: n }, (_, i) => ({ name: `f${i}`, value: "v", inline: true })) });

  assert.ok(rules(inline(4)).includes("inline.ragged"));
  assert.ok(rules(inline(7)).includes("inline.ragged"));
  for (const n of [3, 5, 6]) assert.ok(!rules(inline(n)).includes("inline.ragged"), `${n} inline fields`);
  // One inline field fills its row alone by design — a single stat tile.
  assert.ok(!rules(inline(1)).includes("inline.ragged"));
});

test("a non-inline field breaks the run rather than continuing it", () => {
  const fields = [
    { name: "a", value: "v", inline: true },
    { name: "b", value: "v", inline: true },
    { name: "spacer", value: "v" },
    { name: "c", value: "v", inline: true },
    { name: "d", value: "v", inline: true },
  ];
  // Two runs of two. Neither is ragged; a naive count of five inline fields would
  // have called it one run and been wrong.
  assert.ok(!rules(clean({ fields })).includes("inline.ragged"));
});

test("footer.length — legal, but a footer is a caption", () => {
  const footer = "x".repeat(EMBED_STYLE.footer + 1);
  assert.ok(rules(clean({ footer })).includes("footer.length"));
  assert.ok(!rules(clean({ footer })).includes("limit.footer"));
});

test("ignore drops the named rule and leaves the others", () => {
  const view = clean({ title: "GUILD ROSTER", url: "http://x.com" });
  const found = checkEmbed(view, { ignore: ["title.shouting"] }).map((i) => i.rule);
  assert.ok(!found.includes("title.shouting"));
  assert.ok(found.includes("url.scheme"));
});

test("a card is reviewed whole — every issue is returned, not the first", () => {
  const found = rules({ title: "SHOUTING.", description: "a | b", fields: [{ name: "n", value: "N/A" }] });
  for (const rule of ["title.shouting", "title.punctuation", "separator", "placeholder", "color.missing"]) {
    assert.ok(found.includes(rule), rule);
  }
});

test("checkEmbeds tags each issue with the card it came from", () => {
  const found = checkEmbeds([
    { name: "roster", view: clean() },
    { name: "stats", view: clean({ title: "SHOUTING" }) },
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.card, "stats");
  assert.equal(found[0]?.rule, "title.shouting");
});

// ── Rules added with the shared card layer ───────────────────────────────────

test("footer.time-relative — an age baked into a footer is wrong by tomorrow", () => {
  // This is the rule that retires `stalenessFooter`. A footer is written once;
  // the card is read for as long as the channel is scrolled.
  for (const footer of ["as of 4m ago", "updated 3 days ago", "just now", "Last updated 12h ago"]) {
    assert.ok(rules(clean({ footer })).includes("footer.time-relative"), footer);
  }
  // A caveat that does not decay is exactly what a footer is for.
  assert.ok(!rules(clean({ footer: "⚠ cached — refresh failed" })).includes("footer.time-relative"));
});

test("timestamp.invalid — discord.js throws on an unparseable date", () => {
  assert.ok(rules(clean({ timestamp: "yesterday" })).includes("timestamp.invalid"));
  assert.ok(!rules(clean({ timestamp: "2026-08-06T11:00:00.000Z" })).includes("timestamp.invalid"));
});

test("field.name-data — the reading belongs in the value, not the label", () => {
  const data = clean({ fields: [{ name: "Combat 60", value: "maxed" }] });
  assert.ok(rules(data).includes("field.name-data"));
  const marked = clean({ fields: [{ name: `Combat ${theme.embed.glyphs.marker}`, value: "60" }] });
  assert.ok(rules(marked).includes("field.name-data"));
  // A label may hold a single digit — `F7` and `Tier 4` are the same on every
  // card, which is the whole test of whether something is a label.
  assert.ok(!rules(clean({ fields: [{ name: "F7", value: "12 runs" }] })).includes("field.name-data"));
});

test("field.budget — under four is a sentence, over six is a scan", () => {
  const fields = (n: number): EmbedView =>
    clean({ fields: Array.from({ length: n }, (_, i) => ({ name: `Label ${String.fromCharCode(97 + i)}`, value: "x" })) });
  assert.ok(rules(fields(2)).includes("field.budget"));
  assert.ok(!rules(fields(EMBED_STYLE.minFields)).includes("field.budget"));
  assert.ok(!rules(fields(EMBED_STYLE.maxFields)).includes("field.budget"));
  assert.ok(rules(fields(EMBED_STYLE.maxFields + 1)).includes("field.budget"));
  // A card with no fields at all is a sentence on purpose, not a card missing
  // its grid — plenty of replies are one line and should stay one line.
  assert.ok(!rules(clean()).includes("field.budget"));
});

test("url.scheme covers the author icon and the image, not just the thumbnail", () => {
  assert.ok(rules(clean({ author: { name: "Aria", iconUrl: "http://x/head.png" } })).includes("url.scheme"));
  assert.ok(rules(clean({ imageUrl: "http://x/graph.png" })).includes("url.scheme"));
});

test("the author name counts toward Discord's 6000-character total", () => {
  const view = clean({ description: "x".repeat(EMBED_LIMITS.total - 10), author: { name: "y".repeat(100) } });
  assert.ok(rules(view).includes("limit.total"));
});

test("toEmbed carries author, image and timestamp through to discord.js", () => {
  const embed = toEmbed(
    clean({
      author: { name: "Aria", iconUrl: "https://mc-heads.net/avatar/abc" },
      imageUrl: "https://example.com/graph.png",
      timestamp: "2026-08-06T11:00:00.000Z",
    }),
  ).toJSON();
  assert.equal(embed.author?.name, "Aria");
  assert.equal(embed.image?.url, "https://example.com/graph.png");
  assert.equal(embed.timestamp, new Date("2026-08-06T11:00:00.000Z").toISOString());
});

test("toEmbed drops an unparseable timestamp rather than throwing the reply away", () => {
  // The checker flags it; the renderer must still send a card, because a member
  // asked a question and a missing age is not a reason to answer nothing.
  assert.doesNotThrow(() => toEmbed(clean({ timestamp: "yesterday" })));
  assert.equal(toEmbed(clean({ timestamp: "yesterday" })).toJSON().timestamp, undefined);
});
