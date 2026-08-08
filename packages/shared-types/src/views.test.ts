import assert from "node:assert/strict";
import { test } from "node:test";
import type { DataEnvelope } from "./common.js";
import { describeAge, flattenEmbed, stalenessFooter, type EmbedView } from "./views.js";

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

test("stalenessFooter marks STALE data explicitly", () => {
  const footer = stalenessFooter(envelope({ freshness: "STALE", fetchedAt: "2026-08-06T11:00:00.000Z" }), NOW);
  assert.match(footer, /^⚠ cached data — as of 1h ago$/);
});

test("stalenessFooter distinguishes live from cache-served", () => {
  assert.equal(stalenessFooter(envelope(), NOW), "as of just now");
  assert.equal(stalenessFooter(envelope({ source: "CACHE" }), NOW), "cached — as of just now");
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
  assert.equal(flattenEmbed(embed), "Aria | Ironman | Cata 42 | NW 8.2b");
});

test("flattenEmbed truncates to the guild-chat cap with an ellipsis", () => {
  const flat = flattenEmbed({ description: "a".repeat(400) }, 256);
  assert.equal(flat.length, 256);
  assert.ok(flat.endsWith("…"));
});

test("flattenEmbed normalises the whitespace Minecraft chat would collapse anyway", () => {
  assert.equal(flattenEmbed({ description: "spaced   out\n\nlines" }), "spaced out lines");
});
