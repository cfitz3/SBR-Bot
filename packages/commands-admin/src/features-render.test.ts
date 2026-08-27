import assert from "node:assert/strict";
import test from "node:test";
import { FEATURE_CATALOGUE, featureDefault } from "@sbr/shared-types";
import { parseFeatureChoice, renderFeatureSelectRow, renderFeaturesEmbed } from "./render.js";

const NOW = new Date("2026-08-13T18:00:00.000Z");

test("the card is one field of switches, not one field per switch", () => {
  // Six features at one field each would eat the whole card budget on data that
  // reads better as a list. The lines are the switches; the field is the header.
  const view = renderFeaturesEmbed({}, { now: NOW });
  assert.equal(view.fields?.length, 1);
  const lines = (view.fields?.[0]?.value ?? "").split("\n");
  assert.equal(lines.length, FEATURE_CATALOGUE.length);
  for (const def of FEATURE_CATALOGUE) {
    assert.ok(lines.some((l) => l.includes(def.label) && l.includes(def.description)));
  }
});

test("the headline counts what is on, and the timestamp is the card's own", () => {
  const on = FEATURE_CATALOGUE.filter((d) => featureDefault(d.key)).length;
  const view = renderFeaturesEmbed({}, { now: NOW });
  assert.match(view.description ?? "", new RegExp(`^${on} of ${FEATURE_CATALOGUE.length} on\.`));
  assert.equal(view.timestamp, NOW.toISOString());
});

test("a switched-off feature draws a different glyph from a switched-on one", () => {
  const off = renderFeaturesEmbed({ welcome: false }, { now: NOW }).fields?.[0]?.value ?? "";
  const on = renderFeaturesEmbed({ welcome: true }, { now: NOW }).fields?.[0]?.value ?? "";
  const line = (v: string) => v.split("\n").find((l) => l.includes("Welcome"));
  assert.notEqual(line(off), line(on));
});

test("keys the build no longer knows get their own field rather than a switch", () => {
  // They came from the old free-text box. Rendering them as switches would
  // promise a write that setFeature now refuses.
  const view = renderFeaturesEmbed({ events: true, beta_ui: false }, { now: NOW });
  const stale = view.fields?.find((f) => /recognis/i.test(f.name));
  assert.match(stale?.value ?? "", /beta_ui/);
  assert.match(stale?.value ?? "", /events/);
  assert.equal(view.fields?.[0]?.value.includes("events"), false);
});

test("a notice sits above the count rather than replacing it", () => {
  const view = renderFeaturesEmbed({}, { notice: "Couldn't save that.", now: NOW });
  assert.match(view.description ?? "", /^Couldn't save that\./);
  assert.match(view.description ?? "", /on\./);
});

test("the menu is one row of every feature, each carrying its destination", () => {
  const rows = renderFeatureSelectRow({ welcome: false });
  assert.equal(rows.length, 1);
  const options = rows[0]?.select?.options ?? [];
  assert.equal(options.length, FEATURE_CATALOGUE.length);
  for (const o of options) {
    assert.ok(o.label.length <= 100 && (o.description ?? "").length <= 100, "Discord truncates past 100");
    assert.ok(parseFeatureChoice(o.value), `${o.value} does not round-trip`);
  }
  assert.equal(options.find((o) => o.value.startsWith("welcome:"))?.value, "welcome:on");
});

test("parseFeatureChoice refuses anything that is not a declared key and a state", () => {
  assert.deepEqual(parseFeatureChoice("welcome:off"), { key: "welcome", enabled: false });
  assert.equal(parseFeatureChoice("welcome"), null);
  assert.equal(parseFeatureChoice("welcome:maybe"), null);
  assert.equal(parseFeatureChoice("beta_ui:on"), null);
  assert.equal(parseFeatureChoice(":on"), null);
});
