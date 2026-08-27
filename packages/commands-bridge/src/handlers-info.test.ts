import assert from "node:assert/strict";
import { test } from "node:test";
import { noArgs, recordArgs } from "@sbr/shared-types";
import type { CommandArgs, DiscordDirectory, DiscordUserInfo } from "@sbr/shared-types";
import { infoSpecs } from "./handlers-info.js";
import type { CommandContext, HandlerDeps } from "./types.js";
import { copy } from "@sbr/brand";

const GUILD = "guild-1";
const CALLER = "111";

function ctx(args: CommandArgs = noArgs): CommandContext {
  return { guildId: GUILD, userId: CALLER, surface: "BRIDGE_BOT", args };
}

/** These three reach for exactly one dep, which is the point of the file. */
function deps(discord?: DiscordDirectory): HandlerDeps {
  return { ...(discord === undefined ? {} : { discord }) } as unknown as HandlerDeps;
}

function run(name: string, args: CommandArgs, discord?: DiscordDirectory) {
  const spec = infoSpecs().find((s) => s.name === name);
  assert.ok(spec, `no ${name} spec`);
  return spec.handler(ctx(args), deps(discord));
}

function user(over: Partial<DiscordUserInfo> = {}): DiscordUserInfo {
  return {
    id: "222",
    username: "someone",
    displayName: "Someone",
    bot: false,
    avatarUrl: "https://cdn.example/avatar.png",
    createdAt: Date.UTC(2020, 0, 1),
    member: {
      nickname: null,
      joinedAt: Date.UTC(2021, 5, 2),
      boostingSince: null,
      roleIds: ["role-a", "role-b"],
      timedOutUntil: null,
    },
    ...over,
  };
}

function directory(over: Partial<DiscordDirectory> = {}): DiscordDirectory {
  return {
    async lookupUser() {
      return user();
    },
    async guildInfo() {
      return {
        id: GUILD,
        name: "Skyblock and Relax",
        iconUrl: null,
        createdAt: Date.UTC(2019, 3, 4),
        ownerId: "owner-1",
        memberCount: 1234,
        channelCount: 40,
        roleCount: 25,
        emojiCount: 60,
        boostTier: 2,
        boostCount: 9,
      };
    },
    ...over,
  };
}

test("with no Discord surface wired, each command says so instead of answering", async () => {
  for (const name of ["userinfo", "serverinfo", "avatar"]) {
    const reply = await run(name, noArgs);
    assert.equal(reply.ephemeral, true, name);
    assert.equal(reply.embed, undefined, name);
    assert.equal(reply.text, copy.error.surface.discordOnly, name);
  }
});

test("userinfo defaults to the caller and asks about the guild they ran it in", async () => {
  const asked: string[] = [];
  await run("userinfo", noArgs, directory({
    async lookupUser(guildId, userId) {
      asked.push(`${guildId}/${userId}`);
      return user();
    },
  }));

  assert.deepEqual(asked, [`${GUILD}/${CALLER}`]);
});

test("the member option decides whose card it is", async () => {
  const asked: string[] = [];
  await run("userinfo", recordArgs({ member: "<@900000000000000003>" }), directory({
    async lookupUser(_guildId, userId) {
      asked.push(userId);
      return user();
    },
  }));

  assert.deepEqual(asked, ["900000000000000003"]);
});

test("someone Discord knows but this server does not is reported as such, not as a blank card", async () => {
  const reply = await run("userinfo", noArgs, directory({
    async lookupUser() {
      return user({ member: null });
    },
  }));

  const fields = reply.embed?.fields ?? [];
  assert.equal(fields.some((f) => f.value === "Not in this server"), true);
  // No invented membership facts alongside it.
  assert.equal(fields.some((f) => f.name === "Joined"), false);
  assert.equal(fields.some((f) => f.name.startsWith("Roles")), false);
});

test("roles are counted in full even when the card only lists some", async () => {
  const roleIds = Array.from({ length: 20 }, (_, i) => `role-${String(i)}`);
  const reply = await run("userinfo", noArgs, directory({
    async lookupUser() {
      return user({
        member: { nickname: null, joinedAt: null, boostingSince: null, roleIds, timedOutUntil: null },
      });
    },
  }));

  const roles = (reply.embed?.fields ?? []).find((f) => f.name.startsWith("Roles"));
  assert.equal(roles?.name, "Roles (20)");
  assert.match(roles?.value ?? "", /\+8 more$/);
});

test("a member with no roles says None rather than showing an empty field", async () => {
  const reply = await run("userinfo", noArgs, directory({
    async lookupUser() {
      return user({
        member: { nickname: null, joinedAt: null, boostingSince: null, roleIds: [], timedOutUntil: null },
      });
    },
  }));

  const roles = (reply.embed?.fields ?? []).find((f) => f.name.startsWith("Roles"));
  assert.equal(roles?.value, "None");
});

test("an id Discord has never heard of is refused rather than rendered", async () => {
  const reply = await run("userinfo", noArgs, directory({
    async lookupUser() {
      return null;
    },
  }));

  assert.equal(reply.ephemeral, true);
  assert.equal(reply.embed, undefined);
});

test("serverinfo reports the counts it was given", async () => {
  const reply = await run("serverinfo", noArgs, directory());

  const fields = reply.embed?.fields ?? [];
  assert.equal(reply.embed?.title, "Skyblock and Relax");
  assert.equal(fields.find((f) => f.name === "Members")?.value, "1,234");
  assert.equal(fields.find((f) => f.name === "Boosts")?.value, "9 (tier 2)");
  assert.equal(fields.find((f) => f.name === "Owner")?.value, "<@owner-1>");
});

test("a server the bot cannot currently see says so rather than showing zeroes", async () => {
  const reply = await run("serverinfo", noArgs, directory({
    async guildInfo() {
      return null;
    },
  }));

  assert.equal(reply.ephemeral, true);
  assert.equal(reply.embed, undefined);
  assert.equal(reply.text.includes("0"), false);
});

test("avatar answers with the url itself, so the text fallback is still usable", async () => {
  const reply = await run("avatar", noArgs, directory());

  assert.equal(reply.text, "https://cdn.example/avatar.png");
  assert.equal(reply.embed?.url, "https://cdn.example/avatar.png");
});

test("a default avatar is said in words rather than linked to nothing", async () => {
  const reply = await run("avatar", noArgs, directory({
    async lookupUser() {
      return user({ avatarUrl: null });
    },
  }));

  assert.equal(reply.ephemeral, true);
  assert.equal(reply.embed, undefined);
});

test("the member option is Discord-only: guild chat cannot name a Discord account", () => {
  for (const name of ["userinfo", "avatar"]) {
    const spec = infoSpecs().find((s) => s.name === name);
    assert.equal(spec?.options?.[0]?.inGamePositional, false, name);
    assert.equal(spec?.inGame, undefined, name);
  }
  assert.equal(infoSpecs().find((s) => s.name === "serverinfo")?.inGame, undefined);
});
