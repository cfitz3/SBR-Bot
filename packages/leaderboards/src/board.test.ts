import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBoard, boardTabFor } from "./board.js";
import type { LeaderboardSource } from "./ports.js";

/**
 * The board's whole reason to exist is joining two identity spaces onto one
 * row, so that is what these press on: a member whose Hypixel numbers arrive
 * under a uuid and whose Discord numbers arrive under a snowflake must come out
 * as one person with both, and a member with no reading must come out with no
 * cell rather than a zero.
 */
function source(over: Partial<LeaderboardSource> = {}): LeaderboardSource {
  return {
    async roster() {
      return [
        { discordId: "d1", uuid: "u1", name: "DrJay", guildRank: "Guild Master" },
        { discordId: "d2", uuid: "u2", name: "Steve", guildRank: "Member" },
      ];
    },
    async values() {
      return [];
    },
    async viewerKey() {
      return null;
    },
    ...over,
  } as LeaderboardSource;
}

const query = { guildId: "g", discordId: "d1", tab: "stats", windowDays: 30 };

test("a uuid-keyed column and a snowflake-keyed column land on the same row", async () => {
  const board = await buildBoard(
    source({
      async values(_guildId, category) {
        if (category === "level") {
          return [{ key: "u1", label: "DrJay", value: 300, at: "2026-09-01T00:00:00.000Z" }];
        }
        if (category === "wealth") {
          return [{ key: "d1", label: "DrJay", value: 5_000_000, at: null }];
        }
        return [];
      },
    }),
    query,
  );

  const jay = board.rows.find((row) => row.name === "DrJay");
  assert.ok(jay);
  assert.equal(jay.cells["level"]?.value, 300);
  assert.equal(jay.cells["wealth"]?.value, 5_000_000);
  assert.equal(board.rows.length, 2, "one person, not two rows");
});

test("a member with no reading has no cell, not a zero", async () => {
  const board = await buildBoard(
    source({
      async values(_guildId, category) {
        return category === "level" ? [{ key: "u1", label: "DrJay", value: 300, at: null }] : [];
      },
    }),
    query,
  );

  const steve = board.rows.find((row) => row.name === "Steve");
  assert.ok(steve);
  assert.equal(steve.cells["level"], undefined);
  // …and sinks below the member who does have one.
  assert.equal(board.rows[0]?.name, "DrJay");
});

test("a value whose member is missing from the roster is adopted, under its own label", async () => {
  const board = await buildBoard(
    source({
      async roster() {
        return [];
      },
      async values(_guildId, category) {
        return category === "level" ? [{ key: "u9", label: "Newcomer", value: 42, at: null }] : [];
      },
    }),
    query,
  );

  assert.equal(board.rows.length, 1);
  assert.equal(board.rows[0]?.name, "Newcomer");
});

test("one unreadable column costs that column, not the board", async () => {
  const board = await buildBoard(
    source({
      async values(_guildId, category) {
        if (category === "wealth") throw new Error("hypixel is down");
        return category === "level" ? [{ key: "u1", label: "DrJay", value: 300, at: null }] : [];
      },
    }),
    query,
  );

  assert.equal(board.columns.length, 5, "every column is still described");
  assert.equal(board.columns.find((c) => c.category === "wealth")?.ranked, 0);
  assert.equal(board.rows.find((row) => row.name === "DrJay")?.cells["level"]?.value, 300);
});

test("the viewer is marked, and only the viewer", async () => {
  const board = await buildBoard(source(), query);
  assert.deepEqual(
    board.rows.filter((row) => row.isViewer).map((row) => row.name),
    ["DrJay"],
  );
});

test("the oldest reading on the board is the one reported", async () => {
  const board = await buildBoard(
    source({
      async values(_guildId, category) {
        if (category === "level") {
          return [{ key: "u1", label: "DrJay", value: 300, at: "2026-09-01T00:00:00.000Z" }];
        }
        if (category === "slayer") {
          return [{ key: "u2", label: "Steve", value: 10, at: "2026-08-02T00:00:00.000Z" }];
        }
        return [];
      },
    }),
    query,
  );
  assert.equal(board.oldestReadingAt, "2026-08-02T00:00:00.000Z");
});

test("an unknown tab is the first tab, because it arrives from a URL", () => {
  assert.equal(boardTabFor("nonsense"), "stats");
  assert.equal(boardTabFor("ACTIVITY"), "activity");
  assert.equal(boardTabFor(" stats "), "stats");
});
