/**
 * The link-to-role invariants, read off the source.
 *
 * These are database reads with no database on the build host, so — following
 * `schema-shape.test.ts` — the claims are asserted against the repository text.
 * Each one is a property that, when it broke, produced the bug this file exists
 * to fix: a member who linked and was already in the Hypixel guild received no
 * in-guild role until the next day's full sweep.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../../src/repositories/role-sync.ts", import.meta.url), "utf8");

function body(name: string): string {
  const start = src.indexOf(`async ${name}(`);
  assert.ok(start > 0, `${name} is gone or renamed`);
  const end = src.indexOf("\n  },", start);
  assert.ok(end > start, `${name} has an unexpected shape`);
  // Comments in this file quote the guards they explain, so strip them before
  // counting anything.
  return src
    .slice(start, end)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

test("the rank is adopted before the mark, not after", () => {
  // The mark triggers a reconcile that reads the member's facts once. A rank
  // written after it is a fact that arrived too late to be used, which is
  // exactly the failure this ordering fixes.
  const marker = src.slice(src.indexOf("export function memberRoleDirtyMarker"));
  const adopt = marker.indexOf("adoptCachedGuildRank");
  const mark = marker.indexOf("sink.mark(");
  assert.ok(adopt > 0, "the link path no longer adopts a cached rank");
  assert.ok(mark > 0, "the link path no longer marks the member dirty");
  assert.ok(adopt < mark, "the rank is adopted after the mark, so the reconcile cannot see it");
});

test("adopting a rank can never lose one, or resurrect a departed member", () => {
  const fn = body("adoptCachedGuildRank");
  // Both the read and the write are guarded on the rank still being absent:
  // the read so a member who has one is not touched, the write so two
  // concurrent links cannot both decide they are the one setting it.
  assert.equal(fn.split("guildRank: null").length - 1, 2);
  // Narrow on purpose. Status belongs to the roster pass; adopting it here
  // would undo a departure somebody recorded deliberately.
  assert.ok(!fn.includes("status:") || !/data: \{[^}]*status/.test(fn));
  // And it reads the cache the roster pass already filled, keyed by the pair.
  assert.match(fn, /guildMemberCache\.findUnique\(\{\s*where: \{ guildId_uuid:/);
});

test("in-guild still means a rank the roster wrote, not merely a link", () => {
  // The adoption fills the fact earlier; it does not redefine it. If this
  // check ever loosened to `linked`, every linked stranger would qualify for
  // an in-guild role.
  assert.match(src, /inGuild: member\.status === "ACTIVE" && member\.guildRank !== null/);
});
