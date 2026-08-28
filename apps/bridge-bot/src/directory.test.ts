/**
 * The Discord directory adapter, over a stubbed client.
 *
 * One thing is worth pinning here and it is not the field copying: the guild id
 * this port receives is the platform's internal one, and Discord has never
 * heard of it. Handing it straight to `guilds.fetch` is what made `/serverinfo`
 * answer "I can't see this server" in a server the bot was sitting in, and made
 * `/userinfo` report everybody as not a member of it. The tests below fail if
 * the translation is ever dropped again.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client } from "discord.js";
import { createDiscordDirectory } from "./directory.js";

const INTERNAL = "cl9x7internalguildid";
const SNOWFLAKE = "800000000000000001";
const USER = "900000000000000009";

interface Asked {
  readonly guilds: string[];
}

/**
 * The thinnest client the adapter reads: a user, a guild, and one member with
 * `@everyone` plus a real role, so the role filter has something to get wrong.
 */
function client(asked: Asked, guildFound = true): Client {
  const member = {
    nickname: "Ari",
    joinedTimestamp: Date.parse("2024-02-02T00:00:00.000Z"),
    premiumSinceTimestamp: null,
    communicationDisabledUntilTimestamp: null,
    displayAvatarURL: () => "https://cdn.example/member.png",
    roles: {
      cache: new Map([
        [SNOWFLAKE, { id: SNOWFLAKE, position: 0 }],
        ["role-mod", { id: "role-mod", position: 5 }],
      ]),
    },
  };

  const guild = {
    id: SNOWFLAKE,
    name: "Skyblock and Relax",
    iconURL: () => null,
    createdTimestamp: Date.parse("2021-06-09T15:30:00.000Z"),
    ownerId: USER,
    memberCount: 1_482,
    channels: { cache: new Map([["c", 1]]) },
    roles: { cache: new Map([["r", 1]]) },
    emojis: { cache: new Map() },
    premiumTier: 2,
    premiumSubscriptionCount: 9,
    members: { fetch: async () => member },
  };

  return {
    users: {
      async fetch(id: string) {
        return {
          id,
          username: "aria",
          displayName: "Aria",
          bot: false,
          createdTimestamp: Date.parse("2020-01-01T00:00:00.000Z"),
          displayAvatarURL: () => "https://cdn.example/user.png",
        };
      },
    },
    guilds: {
      async fetch(id: string) {
        asked.guilds.push(id);
        if (!guildFound) throw new Error("Unknown Guild");
        return guild;
      },
    },
  } as unknown as Client;
}

const resolve = async (guildId: string) => (guildId === INTERNAL ? SNOWFLAKE : null);

test("the internal guild id is translated before Discord is asked", async () => {
  const asked: Asked = { guilds: [] };
  const directory = createDiscordDirectory(client(asked), resolve);

  const info = await directory.guildInfo(INTERNAL);

  assert.deepEqual(asked.guilds, [SNOWFLAKE]);
  assert.equal(info?.name, "Skyblock and Relax");
  assert.equal(info?.memberCount, 1_482);
});

test("a guild we have no snowflake for is not asked about at all", async () => {
  const asked: Asked = { guilds: [] };
  const directory = createDiscordDirectory(client(asked), resolve);

  assert.equal(await directory.guildInfo("some-other-guild"), null);
  // Not "we asked and Discord said no" — we never had anything to ask with.
  assert.deepEqual(asked.guilds, []);
});

test("a resolver failure degrades to null rather than escaping the port", async () => {
  const directory = createDiscordDirectory(client({ guilds: [] }), async () => {
    throw new Error("database is having a day");
  });

  assert.equal(await directory.guildInfo(INTERNAL), null);
});

test("userinfo translates too, so membership is read against the right server", async () => {
  const asked: Asked = { guilds: [] };
  const directory = createDiscordDirectory(client(asked), resolve);

  const user = await directory.lookupUser(INTERNAL, USER);

  assert.deepEqual(asked.guilds, [SNOWFLAKE]);
  // The bug this replaces reported every member as not in the server, because
  // a guild that cannot be fetched has no members to find.
  assert.equal(user?.member?.nickname, "Ari");
});

test("@everyone is dropped by the guild's snowflake, not by the id we were called with", async () => {
  const directory = createDiscordDirectory(client({ guilds: [] }), resolve);

  const user = await directory.lookupUser(INTERNAL, USER);

  assert.deepEqual(user?.member?.roleIds, ["role-mod"]);
});

test("a user Discord knows in a server the bot cannot see is still a user", async () => {
  const directory = createDiscordDirectory(client({ guilds: [] }, false), resolve);

  const user = await directory.lookupUser(INTERNAL, USER);

  assert.equal(user?.id, USER);
  assert.equal(user?.member, null);
});
