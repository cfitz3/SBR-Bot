/**
 * The relay's permission gate.
 *
 * This has a test file because it has been wrong twice in opposite directions:
 * once open to everyone (`|| true`), and once closed to everyone — including the
 * guild owner — because it read an empty `GuildMember` table as a permission
 * decision rather than as a scan that had not run. Both failures were silent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { InboundMessage } from "@sbr/bridge";
import { parseRoleBindings, parseRolePolicy } from "@sbr/guild-config";
import type { BridgeCapability, IdentityService } from "@sbr/shared-types";
import { BridgeGuardImpl, type BridgeGuardReads } from "./adapters.js";
import type { RedisContext } from "@sbr/redis";

/** Only `exists` is reached by `canRelay`; the rest of the context is unused. */
const redis = { client: { async exists() { return 0; } }, keys: {} } as unknown as RedisContext;

function guard(over: {
  /** What the stored permission stack says. Default: nobody is a member. */
  capable?: ReadonlySet<string>;
  linked?: Readonly<Record<string, string>>;
  denied?: readonly string[];
  roleIds?: Readonly<Record<string, string>>;
} = {}) {
  const identity = {
    async hasCapability(_g: string, discordId: string, _c: BridgeCapability) {
      return over.capable?.has(discordId) ?? false;
    },
  } as unknown as IdentityService;

  const reads: BridgeGuardReads = {
    async discordIdForIgn(ign) {
      return over.linked?.[ign] ?? null;
    },
    async grants(_g, discordId) {
      return (over.denied ?? []).includes(discordId)
        ? [{ capability: "RELAY_MESSAGE", allow: false }]
        : [];
    },
    async roleBindings() {
      return parseRoleBindings(over.roleIds ? { admin: [over.roleIds.admin ?? ""] } : null);
    },
    async rolePolicy() {
      return parseRolePolicy(undefined);
    },
  };

  return new BridgeGuardImpl(redis, identity, reads);
}

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    guildId: "g1",
    direction: "DISCORD_TO_GAME",
    authorId: "111",
    authorName: "Aria",
    content: "hello",
    ...over,
  };
}

// ── the Discord side ──

test("a gateway-confirmed member may speak before the member scan has run", async () => {
  // The bug the owner hit: the stored stack says "not a member" for everybody
  // until `discord-member-sync` writes its first row, and that job needs a token
  // an install may not have set yet.
  const g = guard();
  assert.equal(await g.canRelay(msg()), false, "no live facts: nothing to go on");
  assert.equal(
    await g.canRelay(msg({ live: { isGuildMember: true, roleIds: [] } })),
    true,
    "the gateway is holding the truth the table has not been given yet",
  );
});

test("a deny row still silences a gateway-confirmed member", async () => {
  const g = guard({ denied: ["111"] });
  assert.equal(await g.canRelay(msg({ live: { isGuildMember: true, roleIds: [] } })), false);
});

test("somebody the gateway does not see in the server is still refused", async () => {
  const g = guard();
  assert.equal(await g.canRelay(msg({ live: { isGuildMember: false, roleIds: [] } })), false);
});

test("the stored stack is consulted first and can allow on its own", async () => {
  const g = guard({ capable: new Set(["111"]) });
  assert.equal(await g.canRelay(msg()), true);
});

// ── the in-game side ──

test("an unlinked player in guild chat is not asked for a Discord permission", async () => {
  // Their IGN is not a snowflake, so the capability lookup could only ever
  // answer "no". Hypixel already decided who may write in guild chat.
  const g = guard();
  assert.equal(await g.canRelay(msg({ direction: "GAME_TO_DISCORD", authorId: "Aria" })), true);
});

test("a linked player's platform permissions follow them into guild chat", async () => {
  const g = guard({ linked: { Aria: "111" } });
  assert.equal(
    await g.canRelay(msg({ direction: "GAME_TO_DISCORD", authorId: "Aria" })),
    false,
    "linked and not permitted: the deny reaches both surfaces",
  );

  const allowed = guard({ linked: { Aria: "111" }, capable: new Set(["111"]) });
  assert.equal(await allowed.canRelay(msg({ direction: "GAME_TO_DISCORD", authorId: "Aria" })), true);
});
