/**
 * The two shapes docs/HYPIXEL_COMPLIANCE.md §1 rests on, asserted against the
 * schema itself.
 *
 * Neither claim is behavioural — "this table cannot grow per member" is a
 * property of a unique index and of the statements that write through it, and
 * there is no Postgres on the build host to demonstrate it against. So they are
 * read off `schema.prisma` and the repository source. A test that ran would be
 * better; a claim that only ever appeared in a document would be worse.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const jobsRepo = readFileSync(new URL("../src/repositories/jobs.ts", import.meta.url), "utf8");

function model(name: string): string {
  const start = schema.indexOf(`model ${name} {`);
  assert.ok(start > 0, `model ${name} is gone or renamed`);
  const end = schema.indexOf("\n}", start);
  return schema.slice(start, end);
}

test("a profile keeps one current row, whatever the refresh does", () => {
  // The ceiling on the scheduled path: with this index in place, a refresh can
  // only ever replace what it finds. Without it, the same job body appends.
  assert.match(model("ProfileCurrent"), /@@unique\(\[minecraftAccountId, profileId\]\)/);
});

test("the refresh writes through that key and has no second way in", () => {
  // One create, on the first-capture branch, and one update. Anything else —
  // a createMany, a second create — is a path that can append.
  assert.equal(jobsRepo.split("profileCurrent.create(").length - 1, 1);
  assert.equal(jobsRepo.split("profileCurrent.update(").length - 1, 1);
  assert.equal(jobsRepo.includes("profileCurrent.createMany"), false);

  const create = jobsRepo.indexOf("profileCurrent.create(");
  const branch = jobsRepo.lastIndexOf("existing === null", create);
  assert.ok(branch > 0 && create - branch < 500, "the create no longer sits on the first-capture branch");

  // And the update is keyed by the pair, not by id — an id-keyed update would
  // still be correct here but would stop failing loudly if the pair changed.
  assert.match(
    jobsRepo.slice(create),
    /profileCurrent\.update\(\{\s*where: \{ minecraftAccountId_profileId: key \}/,
  );
});

test("an event can produce two snapshot rows per participant and no more", () => {
  // Structural rather than conventional: the baseline and the final differ by
  // `source`, so a third write for the same event collides.
  assert.match(model("ProfileSnapshot"), /@@unique\(\[minecraftAccountId, eventId, source\]\)/);
  // Read as members rather than as a regex over the block: the enum carries doc
  // comments, and `SCHEDULED` returning would be the failure that matters.
  const start = schema.indexOf("enum SnapshotSource {");
  assert.ok(start > 0, "SnapshotSource is gone or renamed");
  const members = schema
    .slice(start, schema.indexOf("\n}", start))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Z_]+$/.test(line));
  assert.deepEqual(members, ["USER_SAVED", "EVENT_BASELINE", "EVENT_FINAL"]);
});
