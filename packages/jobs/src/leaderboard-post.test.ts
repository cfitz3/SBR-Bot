/**
 * The pass's promises: a failed guild list is absorbed rather than thrown, one
 * guild's failure does not end the pass, and only guilds that actually got a
 * digest are counted.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { postLeaderboardDigests, type DigestGuild } from "./leaderboard-post.js";

const guilds: readonly DigestGuild[] = [{ id: "g1" }, { id: "g2" }, { id: "g3" }];

test("counts only the digests that landed", async () => {
  const errors: string[] = [];
  const posted = await postLeaderboardDigests({
    listGuilds: async () => guilds,
    // g2 has no leaderboard channel bound, which the bridge reports as a false.
    publish: async (guild) => guild.id !== "g2",
    onError: (scope) => errors.push(scope),
  });
  assert.equal(posted, 2);
  assert.deepEqual(errors, []);
});

test("one guild throwing does not end the pass", async () => {
  const errors: string[] = [];
  const posted = await postLeaderboardDigests({
    listGuilds: async () => guilds,
    publish: async (guild) => {
      if (guild.id === "g1") throw new Error("bridge unreachable");
      return true;
    },
    onError: (scope) => errors.push(scope),
  });
  assert.equal(posted, 2);
  assert.deepEqual(errors, ["digest g1"]);
});

test("an unreadable guild list is absorbed, not thrown", async () => {
  const errors: string[] = [];
  const posted = await postLeaderboardDigests({
    listGuilds: async () => {
      throw new Error("database is down");
    },
    publish: async () => true,
    onError: (scope) => errors.push(scope),
  });
  assert.equal(posted, 0);
  assert.deepEqual(errors, ["guild list"]);
});
