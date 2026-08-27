import assert from "node:assert/strict";
import { test } from "node:test";
import type { DataEnvelope } from "./common.js";
import { describeAge, flattenEmbed, staleness, type EmbedView } from "./views.js";

const NOW = Date.parse("2026-08-06T12:00:00.000Z");

function envelope(over: Partial<DataEnvelope<string>> = {}): DataEnvelope<string> {
  return { data: "x", freshness: "LIVE", source: "LIVE", fetchedAt: "2026-08-06T12:00:00.000Z", ...over };
}

test("describeAge steps through minutes, hours and days", () => {
  assert.equal(describeAge("2026-08-06T11:59:30.000Z", NOW), "just now");
  assert.equal(describeAge("2026-08-06T11:56:00.000Z", NOW), "4m ago");
  assert.equal(describeAge("2026-08-06T09:00:00.000Z", NOW), "3h ago");
  assert.equal(describeAge("2026-08-03T12:00:00.000Z", NOW), "3d ago");
});

test("describeAge tolerates clock skew and garbage rather than rendering NaN", () => {
  assert.equal(describeAge("2026-08-06T12:05:00.000Z", NOW), "just now");
  assert.equal(describeAge("not-a-date", NOW), "just now");
});

test("staleness keeps the caveat and hands the age to Discord", () => {
  // The footer says only what stays true. The age is the envelope's own
  // fetchedAt, untouched, because a card read tomorrow must age with the reader.
  const stale = staleness(envelope({ freshness: "STALE", fetchedAt: "2026-08-06T11:00:00.000Z" }));
  assert.equal(stale.timestamp, "2026-08-06T11:00:00.000Z");
  assert.equal(stale.footer, "⚠ cached — refresh failed");
  assert.doesNotMatch(stale.footer ?? "", /ago|as of/);
});

test("staleness distinguishes live from cache-served, and live says nothing", () => {
  assert.deepEqual(staleness(envelope()), { timestamp: "2026-08-06T12:00:00.000Z" });
  assert.equal(staleness(envelope({ source: "CACHE" })).footer, "served from cache");
});

test("flattenEmbed leads with the author, since identity left the title", () => {
  const embed: EmbedView = {
    author: { name: "Aria" },
    title: "Skills",
    description: "SA 51.3",
  };
  assert.equal(flattenEmbed(embed), "Aria · Skills · SA 51.3");
});

test("flattenEmbed collapses title, description and fields to one line", () => {
  const embed: EmbedView = {
    title: "Aria",
    description: "Ironman",
    fields: [
      { name: "Cata", value: "42" },
      { name: "NW", value: "8.2b" },
    ],
  };
  assert.equal(flattenEmbed(embed), "Aria · Ironman · Cata 42 · NW 8.2b");
});

test("flattenEmbed takes the separator the caller was given", () => {
  // Renderers with the resolved theme in scope pass the operator's choice; the
  // default above is only what a caller without one falls back to.
  assert.equal(flattenEmbed({ title: "Aria", description: "Ironman" }, 256, " — "), "Aria — Ironman");
});

test("flattenEmbed truncates to the guild-chat cap with an ellipsis", () => {
  const flat = flattenEmbed({ description: "a".repeat(400) }, 256);
  assert.equal(flat.length, 256);
  assert.ok(flat.endsWith("…"));
});

test("flattenEmbed normalises the whitespace Minecraft chat would collapse anyway", () => {
  assert.equal(flattenEmbed({ description: "spaced   out\n\nlines" }), "spaced out lines");
});
