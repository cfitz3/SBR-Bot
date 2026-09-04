import assert from "node:assert/strict";
import { test } from "node:test";
import { isPublishable, withholdReason } from "./rules.js";

test("a verified record with a source is publishable", () => {
  assert.equal(isPublishable({ status: "verified", sources: ["https://wiki.hypixel.net/Foraging"] }), true);
});

test("an unverified record is withheld even when it cites a source", () => {
  const record = { status: "unverified" as const, sources: ["https://wiki.hypixel.net/Foraging"] };
  assert.equal(isPublishable(record), false);
  assert.equal(withholdReason(record), "status is unverified");
});

test("a verified record with no sources is withheld — the citation is the point", () => {
  const record = { status: "verified" as const, sources: [] };
  assert.equal(isPublishable(record), false);
  assert.equal(withholdReason(record), "no sources");
});

test("a blank string is not a source", () => {
  assert.equal(isPublishable({ status: "verified", sources: ["  "] }), false);
});

test("a publishable record has no withhold reason to report", () => {
  assert.equal(withholdReason({ status: "verified", sources: ["NEU-REPO constants/misc.json"] }), null);
});
