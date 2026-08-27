import assert from "node:assert/strict";
import test from "node:test";
import {
  FEATURE_CATALOGUE,
  FEATURE_KEYS,
  featureDefault,
  featureDefinition,
  isKnownFeature,
  resolveFeatures,
  unrecognizedFeatures,
} from "./features.js";

test("every catalogue entry is addressable and says what it does", () => {
  // The catalogue is the contract between the switch and the reader. An entry
  // with no description is a switch the operator has to guess at, which is the
  // state this module was written to end.
  for (const def of FEATURE_CATALOGUE) {
    assert.match(def.key, /^[a-z][a-z0-9_]*$/, `${def.key} is not a stable key`);
    assert.ok(def.label.length > 0, `${def.key} has no label`);
    assert.ok(def.description.length > 0, `${def.key} has no description`);
    assert.equal(featureDefinition(def.key), def);
  }
  assert.deepEqual([...FEATURE_KEYS], FEATURE_CATALOGUE.map((d) => d.key));
  assert.equal(new Set(FEATURE_KEYS).size, FEATURE_KEYS.length, "two entries share a key");
});

test("an unknown key is not a feature, and defaults to off", () => {
  // Defaulting an unrecognised key to *on* would mean a typo switches something
  // on somewhere. Off is the only safe reading of a key nobody declared.
  assert.equal(isKnownFeature("events"), false);
  assert.equal(featureDefinition("events"), null);
  assert.equal(featureDefault("events"), false);
});

test("resolve fills the gaps from the catalogue and says which came from the row", () => {
  const state = resolveFeatures({ welcome: false, beta_ui: true });
  assert.deepEqual(
    state.map((s) => s.key),
    [...FEATURE_KEYS],
    "catalogue order, so the card does not reshuffle between calls",
  );
  const welcome = state.find((s) => s.key === "welcome");
  assert.equal(welcome?.enabled, false);
  assert.equal(welcome?.configured, true);
  const untouched = state.find((s) => s.key === "autoresponder");
  assert.equal(untouched?.enabled, featureDefault("autoresponder"));
  assert.equal(untouched?.configured, false);
  assert.equal(state.some((s) => s.key === "beta_ui"), false, "a stored key is not a feature");
});

test("keys stored by an older build are named rather than dropped", () => {
  // Silently hiding them would leave the operator's own words in the row with
  // nothing on screen to explain why nothing happens.
  assert.deepEqual(unrecognizedFeatures({ welcome: true, events: true, beta_ui: false }), [
    "beta_ui",
    "events",
  ]);
  assert.deepEqual(unrecognizedFeatures({ welcome: true }), []);
});
