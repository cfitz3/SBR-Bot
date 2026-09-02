import assert from "node:assert/strict";
import { test } from "node:test";
import { noArgs, recordArgs } from "@sbr/shared-types";
import type {
  CommandArgs,
  DiscordDirectory,
  DiscordUserInfo,
  LinkedIdentityDTO,
  MemberRecordDTO,
  XpStandingDTO,
} from "@sbr/shared-types";
import { infoSpecs } from "./handlers-info.js";
import { buildBridgeRegistry } from "./handlers.js";
import type { CommandContext, HandlerDeps } from "./types.js";
import { copy } from "@sbr/brand";

const GUILD = "guild-1";
const CALLER = "111";
const OTHER = "900000000000000003";

function ctx(args: CommandArgs = noArgs): CommandContext {
  return { guildId: GUILD, userId: CALLER, surface: "BRIDGE_BOT", args };
}

const LINK: LinkedIdentityDTO = {
  discordId: CALLER,
  minecraftUuid: "4d9a51f6a1b7482c9e0b1d3c5f7a9b2e",
  ign: "Aria",
  status: "VERIFIED",
  primary: true,
  verifiedAt: "2025-01-01T00:00:00.000Z",
};

const STANDING: XpStandingDTO = {
  discordId: CALLER,
  totalXp: 48_200,
  level: 24,
  intoLevel: 1_200,
  levelSpan: 3_000,
  tenureDays: 412,
  lastAwardAt: null,
  rank: 6,
  bySource: { GEXP: 48_200 },
};

const RECORD: MemberRecordDTO = {
  warnings: 2,
  windowDays: 90,
  inForce: [],
  nextEscalation: null,
};

/** Only the ports `/whois` and `/serverinfo` actually reach for. */
interface InfoDeps {
  readonly discord?: DiscordDirectory;
  readonly link?: LinkedIdentityDTO | null;
  readonly standing?: XpStandingDTO | null;
  readonly record?: MemberRecordDTO | null;
}

function deps(over: InfoDeps = {}): HandlerDeps {
  return {
    ...(over.discord === undefined ? {} : { discord: over.discord }),
    identity: {
      async resolveByDiscordId() {
        return { ok: true as const, value: over.link ?? null };
      },
    },
    ...(over.standing === undefined
      ? {}
      : {
          xp: {
            async standing() {
              return over.standing ?? null;
            },
          },
        }),
    ...(over.record === undefined
      ? {}
      : {
          record: {
            async forMember() {
              return over.record === null
                ? { ok: false as const, error: "none" }
                : { ok: true as const, value: over.record };
            },
          },
        }),
  } as unknown as HandlerDeps;
}

function run(name: string, args: CommandArgs, over: InfoDeps = {}) {
  const spec = infoSpecs().find((s) => s.name === name);
  assert.ok(spec, `no ${name} spec`);
  return spec.handler(ctx(args), deps(over));
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

const valueOf = (reply: { embed?: { fields?: readonly { name: string; value: string }[] } }, name: string) =>
  reply.embed?.fields?.find((f) => f.name === name)?.value;

test("with no Discord surface wired, each command says so instead of answering", async () => {
  for (const name of ["whois", "serverinfo"]) {
    const reply = await run(name, noArgs);
    assert.equal(reply.ephemeral, true, name);
    assert.equal(reply.embed, undefined, name);
    assert.equal(reply.text, copy.error.surface.discordOnly, name);
  }
});

test("whois defaults to the caller and asks about the guild they ran it in", async () => {
  const asked: string[] = [];
  await run("whois", noArgs, {
    discord: directory({
      async lookupUser(guildId, userId) {
        asked.push(`${guildId}/${userId}`);
        return user();
      },
    }),
  });

  assert.deepEqual(asked, [`${GUILD}/${CALLER}`]);
});

test("the member option decides whose card it is", async () => {
  const asked: string[] = [];
  await run("whois", recordArgs({ member: `<@${OTHER}>` }), {
    discord: directory({
      async lookupUser(_guildId, userId) {
        asked.push(userId);
        return user();
      },
    }),
  });

  assert.deepEqual(asked, [OTHER]);
});

test("someone Discord knows but this server does not is reported as such, not as a blank card", async () => {
  const reply = await run("whois", noArgs, {
    discord: directory({
      async lookupUser() {
        return user({ member: null });
      },
    }),
  });

  assert.match(reply.embed?.description ?? "", /Not in this server/);
  // No invented membership facts alongside it.
  assert.equal(valueOf(reply, "This server"), undefined);
  assert.equal(valueOf(reply, "Roles"), undefined);
});

test("the role count is in the value, not in the field name", async () => {
  // A count in a field name renders bold with no room around it and gives the
  // eye nothing to anchor on — see the house style rule `field.name-data`.
  const roleIds = Array.from({ length: 20 }, (_, i) => `role-${String(i)}`);
  const reply = await run("whois", noArgs, {
    discord: directory({
      async lookupUser() {
        return user({
          member: { nickname: null, joinedAt: null, boostingSince: null, roleIds, timedOutUntil: null },
        });
      },
    }),
  });

  assert.equal(reply.embed?.fields?.some((f) => /\d/.test(f.name)), false);
  assert.match(valueOf(reply, "Roles") ?? "", /^\*\*20\*\* — /);
  assert.match(valueOf(reply, "Roles") ?? "", /\+8 more$/);
});

test("a member with no roles says None rather than showing an empty field", async () => {
  const reply = await run("whois", noArgs, {
    discord: directory({
      async lookupUser() {
        return user({
          member: { nickname: null, joinedAt: null, boostingSince: null, roleIds: [], timedOutUntil: null },
        });
      },
    }),
  });

  assert.equal(valueOf(reply, "Roles"), "None");
});

test("an id Discord has never heard of is refused rather than rendered", async () => {
  const reply = await run("whois", noArgs, {
    discord: directory({
      async lookupUser() {
        return null;
      },
    }),
  });

  assert.equal(reply.ephemeral, true);
  assert.equal(reply.embed, undefined);
});

test("whois names the linked account, and names the way out when there is none", async () => {
  const linked = await run("whois", noArgs, { discord: directory(), link: LINK });
  assert.match(valueOf(linked, "Link") ?? "", /\*\*Aria\*\*/);

  const unlinked = await run("whois", noArgs, { discord: directory() });
  assert.match(valueOf(unlinked, "Link") ?? "", /\/link/);
});

test("standing rides on the private card, and reads as none rather than as zero", async () => {
  const earned = await run("whois", noArgs, { discord: directory(), standing: STANDING });
  assert.match(valueOf(earned, "Guild standing") ?? "", /Level \*\*24\*\*.*48,200 XP.*#6/);

  const nothing = await run("whois", noArgs, { discord: directory(), standing: null });
  assert.equal(valueOf(nothing, "Guild standing"), "Nothing yet.");

  // XP switched off is a third answer, and the section is absent rather than
  // claiming the member has earned nothing.
  const off = await run("whois", noArgs, { discord: directory() });
  assert.equal(valueOf(off, "Guild standing"), undefined);
});

test("a member's record is on their own card and on nobody else's", async () => {
  const own = await run("whois", noArgs, { discord: directory(), record: RECORD });
  assert.match(valueOf(own, "Your record") ?? "", /2 warnings/);

  const theirs = await run("whois", recordArgs({ member: `<@${OTHER}>` }), {
    discord: directory(),
    record: RECORD,
  });
  assert.equal(valueOf(theirs, "Your record"), undefined);
});

test("a public card is the Discord half only, and is the one that goes in the channel", async () => {
  // Standing is theirs to publish and a record is nobody's to read over a
  // shoulder, so `public` is not a visibility flag over the same card — it is a
  // different card, and this is the whole rule.
  const reply = await run("whois", recordArgs({ public: "true" }), {
    discord: directory(),
    link: LINK,
    standing: STANDING,
    record: RECORD,
  });

  assert.equal(reply.ephemeral, false);
  assert.match(valueOf(reply, "Link") ?? "", /Aria/);
  assert.equal(valueOf(reply, "Guild standing"), undefined);
  assert.equal(valueOf(reply, "Your record"), undefined);
});

test("whois is private unless asked otherwise", async () => {
  assert.equal((await run("whois", noArgs, { discord: directory() })).ephemeral, true);
});

test("the avatar url survives the merge, in the card and in the text fallback", async () => {
  // `/avatar` existed to hand somebody a url. The card links it from the title
  // and the fallback carries it literally, so a member can still paste it.
  const reply = await run("whois", noArgs, { discord: directory() });

  assert.equal(reply.embed?.url, "https://cdn.example/avatar.png");
  assert.equal(reply.embed?.thumbnailUrl, "https://cdn.example/avatar.png");
  assert.match(reply.text, /https:\/\/cdn\.example\/avatar\.png$/);
});

test("a default avatar leaves the card unlinked rather than linking to nothing", async () => {
  const reply = await run("whois", noArgs, {
    discord: directory({
      async lookupUser() {
        return user({ avatarUrl: null });
      },
    }),
  });

  assert.equal(reply.embed?.url, undefined);
  assert.equal(reply.embed?.thumbnailUrl, undefined);
  assert.equal(reply.embed?.author?.name, "Someone");
});

test("userinfo and avatar are gone from the registry, not just silenced", async () => {
  const registry = buildBridgeRegistry();
  assert.equal(registry.get("userinfo"), undefined);
  assert.equal(registry.get("avatar"), undefined);
  assert.ok(registry.get("whois"));
});

test("serverinfo reports the counts it was given", async () => {
  const reply = await run("serverinfo", noArgs, { discord: directory() });

  assert.equal(reply.embed?.title, "Skyblock and Relax");
  assert.match(reply.embed?.description ?? "", /\*\*1,234\*\* members/);
  assert.match(valueOf(reply, "Counts") ?? "", /\*\*Channels\*\* 40/);
  assert.match(valueOf(reply, "Boosts") ?? "", /\*\*Tier\*\* 2/);
  assert.equal(valueOf(reply, "Owner"), "<@owner-1>");
});

test("a server the bot cannot currently see says so rather than showing zeroes", async () => {
  const reply = await run("serverinfo", noArgs, {
    discord: directory({
      async guildInfo() {
        return null;
      },
    }),
  });

  assert.equal(reply.ephemeral, true);
  assert.equal(reply.embed, undefined);
  assert.equal(reply.text.includes("0"), false);
});

test("whois options are Discord-only: guild chat cannot name a Discord account", () => {
  const spec = infoSpecs().find((s) => s.name === "whois");
  assert.equal(spec?.options?.every((o) => o.inGamePositional === false), true);
  assert.equal(spec?.inGame, undefined);
  assert.equal(infoSpecs().find((s) => s.name === "serverinfo")?.inGame, undefined);
});
