import assert from "node:assert/strict";
import { test } from "node:test";
import { noArgs, recordArgs } from "@sbr/shared-types";
import type {
  CommandArgs,
  DiscordDirectory,
  DiscordUserInfo,
  ServerActivityDTO,
  ServerActivitySource,
} from "@sbr/shared-types";
import { infoSpecs } from "./handlers-info.js";
import type { CommandContext, HandlerDeps } from "./types.js";

const GUILD = "guild-1";
const CALLER = "111";

function ctx(args: CommandArgs = noArgs): CommandContext {
  return { guildId: GUILD, userId: CALLER, surface: "BRIDGE_BOT", args };
}

/** These three reach for two deps at most, which is the point of the file. */
function deps(discord?: DiscordDirectory, serverActivity?: ServerActivitySource): HandlerDeps {
  return {
    ...(discord === undefined ? {} : { discord }),
    ...(serverActivity === undefined ? {} : { serverActivity }),
  } as unknown as HandlerDeps;
}

function run(name: string, args: CommandArgs, discord?: DiscordDirectory, activity?: ServerActivitySource) {
  const spec = infoSpecs().find((s) => s.name === name);
  assert.ok(spec, `no ${name} spec`);
  return spec.handler(ctx(args), deps(discord, activity));
}

function week(over: Partial<ServerActivityDTO> = {}): ServerActivityDTO {
  return {
    trackedMembers: 312,
    linkedMembers: 274,
    activeMembers: 96,
    discordMessages: 4_118,
    guildChatMessages: 962,
    top: { discordId: "900000000000000009", ign: "Aria", discordMessages: 412, guildChatMessages: 96 },
    windowDays: 7,
    ...over,
  };
}

const counted = (dto: ServerActivityDTO | null = week()): ServerActivitySource => ({
  async serverWeek() {
    return dto;
  },
});

/** One field's value, by name. */
const value = (reply: { embed?: { fields?: readonly { name: string; value: string }[] } }, name: string) =>
  reply.embed?.fields?.find((f) => f.name === name)?.value;

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
    assert.match(reply.text, /only works from Discord/, name);
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
  const reply = await run("serverinfo", noArgs, directory(), counted());

  assert.equal(reply.embed?.title, "Skyblock and Relax");
  // The Discord count is the headline, and the card does not then repeat it
  // as a fact and invite the reader to check the two against each other.
  assert.equal(reply.embed?.description, "1,234 members");
  assert.match(value(reply, "Server") ?? "", /[*][*]Boosts[*][*] 9 [(]tier 2[)]/);
  assert.match(value(reply, "Server") ?? "", /<@owner-1>/);
});

test("our own numbers are ours, and are not passed off as Discord's", async () => {
  const reply = await run("serverinfo", noArgs, directory(), counted());

  // Tracked is smaller than the Discord count on purpose: bots are in one
  // and not the other, and a card that conflated them would be wrong twice.
  const members = value(reply, "Members") ?? "";
  assert.match(members, /[*][*]Tracked here[*][*] 312/);
  assert.match(members, /[*][*]Linked[*][*] 274/);
  assert.match(members, /[*][*]Active this week[*][*] 96/);
});

test("the busiest member is named as a mention, with their IGN when they have one", async () => {
  const reply = await run("serverinfo", noArgs, directory(), counted());

  const top = value(reply, "Busiest this week") ?? "";
  assert.match(top, /^<@900000000000000009> [(]Aria[)]/);
  assert.match(top, /412/);
});

test("a quiet week says nobody spoke rather than showing an empty section", async () => {
  const reply = await run("serverinfo", noArgs, directory(), counted(week({
    activeMembers: 0,
    discordMessages: 0,
    guildChatMessages: 0,
    top: null,
  })));

  // Zero counted is a different fact from nothing counted, and the card keeps
  // the difference: the totals are still there, and the name is not invented.
  assert.match(value(reply, "Messages this week") ?? "", /[*][*]Discord[*][*] 0/);
  assert.match(value(reply, "Busiest this week") ?? "", /Nobody has said anything/);
});

test("a deployment counting nothing loses the week and keeps the server", async () => {
  const reply = await run("serverinfo", noArgs, directory());

  assert.equal(value(reply, "Members"), undefined);
  assert.equal(value(reply, "Busiest this week"), undefined);
  assert.match(value(reply, "Messages this week") ?? "", /isn't being counted/);
  assert.match(value(reply, "Server") ?? "", /Channels/);
});

test("a counter store that throws costs the week, not the card", async () => {
  const reply = await run("serverinfo", noArgs, directory(), {
    async serverWeek() {
      throw new Error("database is having a day");
    },
  });

  assert.equal(reply.embed?.title, "Skyblock and Relax");
  assert.match(value(reply, "Messages this week") ?? "", /isn't being counted/);
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
