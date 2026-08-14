/**
 * The specimen reader is the teaching channel, and its contract is narrow: it may
 * drop anything `EmbedView` cannot carry, but it may never drop it *quietly*.
 * Most of what follows checks the note, not the value — a silent drop is the
 * failure mode that makes the whole loop worthless, because the operator would
 * see their design come back subtly different and have nothing to read.
 */
import { theme } from "@sbr/brand";
import assert from "node:assert/strict";
import { test } from "node:test";

import { fromDiscordJson, nearestColor, toDiscordJson } from "./specimen.js";

const NOTES = (raw: unknown): string => fromDiscordJson(raw).notes.map((n) => n.detail).join("\n");

test("a bare embed object", () => {
  const { views, notes } = fromDiscordJson({ title: "Roster", description: "42 members" });
  assert.equal(views.length, 1);
  assert.equal(views[0]?.title, "Roster");
  assert.deepEqual(notes, []);
});

test("a Discohook payload with an embeds array", () => {
  const { views } = fromDiscordJson({ content: "", embeds: [{ title: "One" }, { title: "Two" }] });
  assert.deepEqual(views.map((v) => v.title), ["One", "Two"]);
});

test("a bare array of embeds", () => {
  const { views } = fromDiscordJson([{ title: "One" }, { title: "Two" }]);
  assert.equal(views.length, 2);
});

test("message content is named rather than absorbed into the card", () => {
  assert.match(NOTES({ content: "hey", embeds: [{ title: "One" }] }), /message content/);
  // An empty content string is not content, and should not produce a note.
  assert.deepEqual(fromDiscordJson({ content: "", embeds: [{ title: "One" }] }).notes, []);
});

test("something that is not an object at all yields no views and no crash", () => {
  assert.deepEqual(fromDiscordJson("nonsense"), { views: [], notes: [] });
  assert.deepEqual(fromDiscordJson(null).views, []);
});

test("a non-object inside an array is skipped with its index named", () => {
  const { views, notes } = fromDiscordJson([{ title: "One" }, "junk"]);
  assert.equal(views.length, 1);
  assert.equal(notes[0]?.index, 1);
});

// ── Each unsupported field produces its own note ─────────────────────────────

test("author, image, video, provider and timestamp are each reported", () => {
  const notes = NOTES({
    title: "Card",
    author: { name: "SBR" },
    image: { url: "https://example.com/i.png" },
    video: { url: "https://example.com/v.mp4" },
    provider: { name: "x" },
    timestamp: "2026-08-13T00:00:00Z",
  });
  assert.match(notes, /author line/);
  assert.match(notes, /full-width image/);
  assert.match(notes, /video/);
  assert.match(notes, /provider/);
  assert.match(notes, /timestamp/);
});

test("a null unsupported field is absent, not present-and-empty", () => {
  // Discord's own JSON is full of explicit nulls; a note for each would bury the
  // ones that mean something.
  assert.deepEqual(fromDiscordJson({ title: "Card", author: null, image: null }).notes, []);
});

test("a footer icon is dropped and said so; the footer text survives", () => {
  const { views, notes } = fromDiscordJson({
    title: "Card",
    footer: { text: "as of 4m ago", icon_url: "https://example.com/i.png" },
  });
  assert.equal(views[0]?.footer, "as of 4m ago");
  assert.match(notes.map((n) => n.detail).join(""), /footer icon/);
});

test("a field missing a name or a value is skipped by index", () => {
  const { views, notes } = fromDiscordJson({
    title: "Card",
    fields: [{ name: "Cata", value: "42" }, { name: "NW" }, { value: "orphan" }],
  });
  assert.equal(views[0]?.fields?.length, 1);
  assert.equal(notes.length, 2);
  assert.match(notes[0]!.detail, /field\[1\]/);
  assert.match(notes[1]!.detail, /field\[2\]/);
});

test("inline is carried only when it is true", () => {
  const { views } = fromDiscordJson({
    title: "Card",
    fields: [{ name: "a", value: "1", inline: true }, { name: "b", value: "2", inline: false }],
  });
  assert.equal(views[0]?.fields?.[0]?.inline, true);
  assert.equal(views[0]?.fields?.[1]?.inline, undefined);
});

// ── Colour ──────────────────────────────────────────────────────────────────

test("nearestColor is exact for every palette entry", () => {
  for (const [name, hex] of Object.entries(theme.embed.colors)) {
    assert.deepEqual(nearestColor(hex), { color: name, exact: true }, name);
  }
});

test("nearestColor picks the closest neighbour for a colour we don't have", () => {
  // A red a shade off DANGER.
  const match = nearestColor(0xee7350);
  assert.equal(match.exact, false);
  assert.equal(match.color, "DANGER");
});

test("an off-palette colour is mapped and reported, never silently accepted", () => {
  const { views, notes } = fromDiscordJson({ title: "Card", color: 0x9184d9 });
  assert.equal(views[0]?.color !== undefined, true);
  assert.match(notes.map((n) => n.detail).join(""), /not in the palette/);
});

test("an exact palette colour is silent", () => {
  assert.deepEqual(fromDiscordJson({ title: "Card", color: theme.embed.colors.SUCCESS }).notes, []);
});

// ── Round trip ──────────────────────────────────────────────────────────────

test("a view survives the trip out to Discord JSON and back", () => {
  const view = {
    title: "Roster",
    description: "42 members",
    color: "INFO" as const,
    fields: [{ name: "Cata", value: "42", inline: true }],
    footer: "as of 4m ago",
    thumbnailUrl: "https://example.com/i.png",
    url: "https://example.com",
  };
  const back = fromDiscordJson(toDiscordJson(view));
  assert.deepEqual(back.views[0], view);
  assert.deepEqual(back.notes, []);
});

test("toDiscordJson resolves the palette name to the theme's hex", () => {
  assert.equal(toDiscordJson({ title: "x", color: "DANGER" })["color"], theme.embed.colors.DANGER);
});

test("toDiscordJson omits what the view did not state rather than emitting nulls", () => {
  assert.deepEqual(toDiscordJson({ title: "x" }), { title: "x" });
});
