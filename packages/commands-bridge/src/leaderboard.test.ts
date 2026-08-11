/**
 * `/leaderboard`: what the handler asks the service for, and what the two
 * surfaces make of the answer.
 *
 * Ranking itself is tested in `@sbr/leaderboards` — nothing here re-checks how
 * ties or paging work. These tests are about the transport: option parsing,
 * the disabled and unknown-category replies, and the two renderings.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { recordArgs } from "@sbr/shared-types";
import type { LeaderboardPageDTO, LeaderboardQuery } from "@sbr/shared-types";
import { buildBridgeRegistry } from "./handlers.js";
import { renderLeaderboardEmbed, renderLeaderboardLine } from "./render.js";
import type { CommandContext, HandlerDeps } from "./types.js";

const SPEC = {
  id: "xp" as const,
  label: "Guild XP",
  format: "count" as const,
  source: "XP" as const,
  description: "Total guild XP earned",
  windowed: false,
};

function pageOf(overrides: Partial<LeaderboardPageDTO> = {}): LeaderboardPageDTO {
  return {
    category: "xp",
    spec: SPEC,
    entries: [
      { key: "1", label: "Alpha", value: 900, at: null, rank: 1, isViewer: false },
      { key: "2", label: "Bravo", value: 400, at: null, rank: 2, isViewer: false },
    ],
    page: 1,
    pageCount: 1,
    totalRanked: 2,
    windowDays: null,
    viewer: null,
    oldestReadingAt: null,
    ...overrides,
  };
}

/** A context over the same arg parser the in-game surface uses. */
function ctxWith(values: Readonly<Record<string, string>>): CommandContext {
  return { guildId: "g1", userId: "u1", surface: "BRIDGE_BOT", args: recordArgs(values) };
}

function depsWith(page: LeaderboardPageDTO, seen: LeaderboardQuery[]): HandlerDeps {
  return {
    leaderboards: {
      async page(query: LeaderboardQuery) {
        seen.push(query);
        return page;
      },
    },
  } as unknown as HandlerDeps;
}

const handler = () => {
  const spec = buildBridgeRegistry().get("leaderboard");
  assert.ok(spec, "/leaderboard must be registered");
  return spec.handler;
};

test("defaults to guild XP on page one when no options are given", async () => {
  const seen: LeaderboardQuery[] = [];
  await handler()(ctxWith({}), depsWith(pageOf(), seen));
  assert.equal(seen[0]?.category, "xp");
  assert.equal(seen[0]?.page, 1);
  // Omitted rather than defaulted here: the domain owns the window default, so
  // a change there does not need a matching change in the transport.
  assert.equal(seen[0]?.windowDays, undefined);
});

test("accepts an alias for the category", async () => {
  const seen: LeaderboardQuery[] = [];
  await handler()(ctxWith({ category: "nw" }), depsWith(pageOf(), seen));
  assert.equal(seen[0]?.category, "wealth");
});

test("passes an explicit window through", async () => {
  const seen: LeaderboardQuery[] = [];
  await handler()(ctxWith({ category: "guild-chat", days: "7" }), depsWith(pageOf(), seen));
  assert.equal(seen[0]?.windowDays, 7);
});

test("an unknown category is refused privately, and lists the real ones", async () => {
  const seen: LeaderboardQuery[] = [];
  const reply = await handler()(ctxWith({ category: "kdr" }), depsWith(pageOf(), seen));
  assert.equal(seen.length, 0, "an unknown category must not reach the service");
  assert.equal(reply.ephemeral, true);
  assert.match(reply.text, /kdr/);
  assert.match(reply.text, /wealth/);
});

test("says leaderboards are off rather than showing an empty board", async () => {
  const reply = await handler()(ctxWith({}), { logger: console } as unknown as HandlerDeps);
  assert.equal(reply.ephemeral, true);
  assert.match(reply.text, /switched on/i);
});

test("the embed ranks with medals and the flat line stays short", () => {
  const embed = renderLeaderboardEmbed(pageOf());
  assert.match(embed.description ?? "", /Alpha/);
  assert.match(embed.description ?? "", /🥇/);
  assert.match(embed.footer ?? "", /2 ranked/);

  const line = renderLeaderboardLine(pageOf());
  assert.match(line, /Guild XP: 1\. Alpha/);
  assert.ok(line.length <= 252, "guild chat takes one line of 252 characters");
});

test("an off-page viewer is appended, not slotted into the ranking", () => {
  const embed = renderLeaderboardEmbed(
    pageOf({ viewer: { key: "9", label: "Zulu", value: 12, at: null, rank: 41, isViewer: true } }),
  );
  assert.match(embed.description ?? "", /You: `#41`/);
  // And the ranked list itself is untouched.
  assert.doesNotMatch(embed.description?.split("You:")[0] ?? "", /Zulu/);
});

test("an empty board says so on both surfaces", () => {
  const empty = pageOf({ entries: [], totalRanked: 0 });
  assert.match(renderLeaderboardEmbed(empty).description ?? "", /Nobody is ranked/);
  assert.match(renderLeaderboardLine(empty), /nobody ranked/);
});

test("the footer reports the oldest reading on the page, not the newest", () => {
  const now = Date.parse("2026-08-10T12:00:00.000Z");
  const embed = renderLeaderboardEmbed(
    pageOf({ oldestReadingAt: "2026-08-10T06:00:00.000Z" }),
    now,
  );
  assert.match(embed.footer ?? "", /oldest reading/);
});
