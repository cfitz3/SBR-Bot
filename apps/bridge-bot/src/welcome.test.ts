import assert from "node:assert/strict";
import test from "node:test";
import type { MemberBusMessage } from "@sbr/redis";
import { greetGuildJoin, greetMember, startGreeter, type GreetPost, type GreeterDeps } from "./welcome.js";

const log = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return log;
  },
} as unknown as GreeterDeps["log"];

interface Harness {
  readonly deps: GreeterDeps;
  readonly posts: GreetPost[];
  readonly dms: { discordId: string; text: string }[];
  readonly profileLookups: number;
}

function harness(over: {
  setting?: unknown;
  channel?: string | null;
  post?: (post: GreetPost) => boolean;
  dm?: () => boolean | Promise<boolean>;
  profile?: { ign: string | null; guildRank: string | null; level: number | null } | null;
} = {}): Harness {
  const posts: GreetPost[] = [];
  const dms: { discordId: string; text: string }[] = [];
  const h = {
    posts,
    dms,
    profileLookups: 0,
    deps: {
      readSetting: async () => over.setting ?? {},
      getChannel: async () => (over.channel === undefined ? "chan-1" : over.channel),
      lookupProfile: async () => {
        h.profileLookups += 1;
        return over.profile ?? null;
      },
      post: async (post: GreetPost) => {
        posts.push(post);
        return over.post?.(post) ?? true;
      },
      dm: async (discordId: string, text: string) => {
        dms.push({ discordId, text });
        return (await over.dm?.()) ?? true;
      },
      log,
    } satisfies GreeterDeps,
  };
  return h;
}

function join(over: Partial<MemberBusMessage> = {}): MemberBusMessage {
  return {
    kind: "member-join",
    guildId: "g1",
    discordId: "u1",
    username: "ash",
    serverName: "SBR",
    memberCount: 214,
    ...over,
  };
}

test("an enabled welcome renders and posts, pinging only the joiner", async () => {
  const h = harness({ setting: { join: { enabled: true, text: "Welcome {user} to {server}, #{memberCount}." } } });

  assert.equal(await greetMember(join(), h.deps), true);
  assert.equal(h.posts[0]?.text, "Welcome <@u1> to SBR, #214.");
  assert.equal(h.posts[0]?.mentionDiscordId, "u1");
});

test("a section that is switched off says nothing", async () => {
  const h = harness({ setting: {} });

  assert.equal(await greetMember(join(), h.deps), false);
  assert.deepEqual(h.posts, []);
});

test("an unknown token reaches the channel literally rather than vanishing", async () => {
  // The renderer owns this, but the greeter is where an admin would first see
  // it, so the behaviour is pinned at the seam they actually look at.
  const h = harness({ setting: { join: { enabled: true, text: "hi {membercount}" } } });

  await greetMember(join(), h.deps);
  assert.equal(h.posts[0]?.text, "hi {membercount}");
});

test("@everyone cannot escape through a template or a nickname", async () => {
  const h = harness({ setting: { join: { enabled: true, text: "@everyone say hi to {username}" } } });

  await greetMember(join({ username: "@here troll" }), h.deps);
  const text = h.posts[0]?.text ?? "";
  assert.ok(!/@everyone/.test(text), text);
  assert.ok(!/@here/.test(text), text);
});

test("an unbound channel holds the message rather than crashing the subscriber", async () => {
  const h = harness({ setting: { join: { enabled: true, text: "hi" } }, channel: null });

  assert.equal(await greetMember(join(), h.deps), false);
  assert.deepEqual(h.posts, []);
});

test("a failed DM is not fatal to the channel post", async () => {
  const h = harness({
    setting: { join: { enabled: true, text: "hi {user}", dm: "welcome aboard" } },
    dm: () => {
      throw new Error("cannot send messages to this user");
    },
  });

  assert.equal(await greetMember(join(), h.deps), true, "the channel still heard about it");
  assert.equal(h.posts.length, 1);
});

test("a DM is rendered with the same tokens as the channel post", async () => {
  const h = harness({ setting: { join: { enabled: true, text: "hi", dm: "Welcome to {server}, {username}." } } });

  await greetMember(join(), h.deps);
  assert.deepEqual(h.dms, [{ discordId: "u1", text: "Welcome to SBR, ash." }]);
});

test("profile facts are only fetched when a template asks for one", async () => {
  const plain = harness({ setting: { join: { enabled: true, text: "hi {user}" } } });
  await greetMember(join(), plain.deps);
  assert.equal(plain.profileLookups, 0, "a round trip nobody reads");

  const rich = harness({
    setting: { join: { enabled: true, text: "hi {ign} ({guildRank}, level {level})" } },
    profile: { ign: "AshPlays", guildRank: "Officer", level: 31 },
  });
  await greetMember(join(), rich.deps);
  assert.equal(rich.profileLookups, 1);
  assert.equal(rich.posts[0]?.text, "hi AshPlays (Officer, level 31)");
});

test("an unlinked member renders the profile tokens as nothing, not as undefined", async () => {
  const h = harness({ setting: { join: { enabled: true, text: "hi {ign}!" } }, profile: null });

  await greetMember(join(), h.deps);
  assert.equal(h.posts[0]?.text, "hi !");
});

test("a farewell pings nobody and is never an embed", async () => {
  const h = harness({ setting: { leave: { enabled: true, text: "{username} left." } } });

  assert.equal(await greetMember(join({ kind: "member-leave" }), h.deps), true);
  assert.equal(h.posts[0]?.text, "ash left.");
  assert.equal(h.posts[0]?.mentionDiscordId, null);
  assert.equal(h.posts[0]?.mode, "TEXT");
});

test("a leave carries no DM: they are gone", async () => {
  const h = harness({ setting: { join: { dm: "hello" }, leave: { enabled: true, text: "bye" } } });

  await greetMember(join({ kind: "member-leave" }), h.deps);
  assert.deepEqual(h.dms, []);
});

test("a delete timer travels with the post rather than being applied here", async () => {
  const h = harness({ setting: { join: { enabled: true, text: "hi", deleteAfterSeconds: 30 } } });

  await greetMember(join(), h.deps);
  assert.equal(h.posts[0]?.deleteAfterSeconds, 30);
});

test("a failed post is reported as a failure, not swallowed as success", async () => {
  const h = harness({ setting: { join: { enabled: true, text: "hi" } }, post: () => false });

  assert.equal(await greetMember(join(), h.deps), false);
});

test("an in-game guild join uses the guild slot and the linked mention when there is one", async () => {
  const h = harness({ setting: { guildJoin: { enabled: true, text: "{user} joined as {guildRank}." } } });

  assert.equal(await greetGuildJoin({ guildId: "g1", ign: "AshPlays", guildRank: "Member", discordId: "u1" }, h.deps), true);
  assert.equal(h.posts[0]?.text, "<@u1> joined as Member.");
});

test("an unlinked in-game join falls back to the IGN rather than an empty mention", async () => {
  const h = harness({ setting: { guildJoin: { enabled: true, text: "{user} joined." } } });

  await greetGuildJoin({ guildId: "g1", ign: "AshPlays", guildRank: null, discordId: null }, h.deps);
  assert.equal(h.posts[0]?.text, "AshPlays joined.");
  assert.equal(h.posts[0]?.mentionDiscordId, null);
});

test("one bad message does not silence the subscription for every other guild", async () => {
  const h = harness({ setting: { join: { enabled: true, text: "hi" } } });
  let handler: ((message: MemberBusMessage) => void) | null = null;
  let stopped = false;
  const bus = {
    async subscribe(onMessage: (message: MemberBusMessage) => void) {
      handler = onMessage;
      return async () => {
        stopped = true;
      };
    },
  };
  const failing: GreeterDeps = {
    ...h.deps,
    readSetting: async (guildId: string) => {
      if (guildId === "bad") throw new Error("unreadable setting");
      return { join: { enabled: true, text: "hi" } };
    },
  };

  const handle = await startGreeter(bus, failing);
  assert.ok(handler !== null);
  (handler as (message: MemberBusMessage) => void)(join({ guildId: "bad" }));
  (handler as (message: MemberBusMessage) => void)(join());
  // Both were dispatched without awaiting; let their microtasks settle.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.posts.length, 1, "the healthy guild was still greeted");
  await handle.stop();
  assert.equal(stopped, true);
});
