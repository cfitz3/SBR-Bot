/**
 * The guard for docs/HYPIXEL_COMPLIANCE.md §1 and §2: exactly one route runs
 * from a scheduled worker to a player-scoped Hypixel read, and it is
 * `captureProfile`.
 *
 * This one reads its own source rather than running the jobs, and that is
 * deliberate. The claim is structural — *nothing else reaches upstream per
 * player* — and a behavioural test can only show that the handlers it managed
 * to drive did not. A handler that threw on a null repository before reaching
 * its Hypixel call would pass such a test while violating the claim. The cost
 * is that the assertions are pinned to the spelling in `jobs.ts`; the
 * substrings below are chosen to fail loudly rather than silently if that
 * spelling drifts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createKeyFactory } from "@sbr/redis";

import { buildJobDefinitions } from "./jobs.js";
import type { WorkerContext } from "./composition.js";

const read = (name: string): string =>
  readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

const jobs = read("jobs.ts");

/** Every client method that takes a player. Guild and market reads are not here. */
const PLAYER_SCOPED = [
  "getPlayer(",
  "getSkyblockProfile(",
  "getSkyblockProfiles(",
  "getMuseum(",
  "getPlayerAuctions(",
];

test("no job body calls the Hypixel client for a player directly", () => {
  const found = PLAYER_SCOPED.filter((m) => jobs.includes(`ctx.hypixel.${m}`));
  assert.deepEqual(found, [], "a job reached past the progression service to the client");
});

test("the player-scoped client methods live behind the one adapter", () => {
  // composition.ts is where the ProfileProvider is built; it is the seam the
  // cache and the per-player limiter both sit on, so a second caller elsewhere
  // in the worker would be a second, unlimited path upstream.
  const composition = read("composition.ts");
  for (const method of ["getSkyblockProfile(", "getSkyblockProfiles("]) {
    assert.ok(composition.includes(`hypixel.${method}`), `${method} moved out of composition.ts`);
  }
  for (const file of ["main.ts", "bootstrap.ts", "schedule.ts"]) {
    const source = read(file);
    const leaked = PLAYER_SCOPED.filter((m) => source.includes(m));
    assert.deepEqual(leaked, [], `${file} reads a player from Hypixel`);
  }
});

test("the progression service is reached from captureProfile and nowhere else", () => {
  const start = jobs.indexOf("const captureProfile = async");
  assert.ok(start > 0, "captureProfile is gone or renamed");
  // The next top-level const inside buildJobDefinitions closes the body.
  const end = jobs.indexOf("\n  const ", start + 1);
  assert.ok(end > start, "could not find the end of captureProfile");

  const outside = [jobs.slice(0, start), jobs.slice(end)].join("");
  assert.equal(
    outside.includes("ctx.progression"),
    false,
    "a job outside captureProfile reads the progression service",
  );
});

test("captureProfile is wired into the profile refresh and event tracking, and nothing else", () => {
  // One definition, two uses. A third use is a third schedule fetching players.
  assert.equal(jobs.split("captureProfile").length - 1, 3);

  const consumers: string[] = [];
  let at = jobs.indexOf("capture: captureProfile");
  while (at !== -1) {
    const before = jobs.slice(0, at);
    const opened = before.lastIndexOf("...define");
    assert.ok(opened > 0, "a captureProfile use sits outside a job definition");
    consumers.push(before.slice(opened + 3, before.indexOf("(", opened)));
    at = jobs.indexOf("capture: captureProfile", at + 1);
  }

  assert.deepEqual(consumers.sort(), ["defineEventTrackingJob", "defineProfileRefreshJob"]);
});

test("those two definitions are the two scheduled jobs they claim to be", () => {
  const ctx = { redis: { keys: createKeyFactory("sbr:"), client: null } } as unknown as WorkerContext;
  const names = new Set(buildJobDefinitions(ctx).keys());
  assert.ok(names.has("profile-refresh"));
  assert.ok(names.has("event-tracking"));
});
