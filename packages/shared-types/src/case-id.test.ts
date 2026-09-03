/**
 * The id has to survive the round trip through a human: printed on a card,
 * read aloud, typed back into a search box. These tests are about that trip,
 * not about the format for its own sake.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  caseUuidFragment,
  formatCaseCode,
  looksLikeCaseCode,
  parseCaseCode,
  sanitizeCaseName,
} from "./case-id.js";

test("an id reads the way staff say it", () => {
  assert.equal(
    formatCaseCode({ name: "DrJay", uuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", sequence: 2 }),
    "CASE-DrJay-a1b2c3d4-2",
  );
});

test("a dashed and an undashed uuid give the same id", () => {
  const dashed = formatCaseCode({ name: "x", uuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", sequence: 1 });
  const flat = formatCaseCode({ name: "x", uuid: "a1b2c3d4e5f67890abcdef1234567890", sequence: 1 });
  assert.equal(dashed, flat);
});

test("the separator can never appear inside a segment", () => {
  const code = formatCaseCode({ name: "Dr-Jay the 3rd!", uuid: "a1b2c3d4", sequence: 1 });
  assert.equal(code.split("-").length, 4);
  assert.equal(code, "CASE-DrJaythe3rd-a1b2c3d4-1");
});

test("a name that survives nothing still gets an id", () => {
  assert.equal(sanitizeCaseName("!!!"), "unknown");
  assert.equal(sanitizeCaseName(null), "unknown");
  assert.equal(caseUuidFragment(null), "00000000");
  assert.equal(formatCaseCode({ name: null, uuid: null, sequence: 1 }), "CASE-unknown-00000000-1");
});

test("a long name is cut rather than allowed to run", () => {
  assert.equal(sanitizeCaseName("A".repeat(40)).length, 16);
});

test("a sequence is never zero or negative, whatever the caller passes", () => {
  assert.equal(formatCaseCode({ name: "x", uuid: "ab", sequence: 0 }), "CASE-x-ab-1");
  assert.equal(formatCaseCode({ name: "x", uuid: "ab", sequence: -4 }), "CASE-x-ab-1");
  assert.equal(formatCaseCode({ name: "x", uuid: "ab", sequence: Number.NaN }), "CASE-x-ab-1");
});

test("an id typed back in parses, whatever case it was typed in", () => {
  const parsed = parseCaseCode("case-DrJay-A1B2C3D4-2");
  assert.deepEqual(parsed, { name: "DrJay", uuidFragment: "a1b2c3d4", sequence: 2 });
});

test("something that is not an id parses as nothing", () => {
  assert.equal(parseCaseCode("cmt7k3brh00dtb0uixiys3dbr"), null);
  assert.equal(parseCaseCode("CASE-DrJay-a1b2c3d4"), null);
  assert.equal(parseCaseCode("CASE-DrJay-zzzz-2"), null);
  assert.equal(parseCaseCode("CASE-DrJay-a1b2c3d4-0"), null);
});

test("a search box can tell an id from a name", () => {
  assert.equal(looksLikeCaseCode("  case-DrJay-a1b2c3d4-2 "), true);
  assert.equal(looksLikeCaseCode("DrJay"), false);
});

test("every id we format is an id we can read back", () => {
  for (const seq of [1, 9, 10, 137]) {
    const code = formatCaseCode({ name: "Dr_Jay", uuid: "A1B2C3D4E5F6", sequence: seq });
    assert.equal(parseCaseCode(code)?.sequence, seq);
    assert.equal(looksLikeCaseCode(code), true);
  }
});
