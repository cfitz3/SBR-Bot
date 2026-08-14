/**
 * The relay's permission gate.
 *
 * This has a test file because it has been wrong three times: once open to
 * everyone (`|| true`); once closed to everyone — including the guild owner —
 * because it read an empty `GuildMember` table as a permission decision rather
 * than as a scan that had not run; and once open to the whole Discord server,
 * because `discord-member-sync` gives every account a `GuildMember` row whose
 * role defaults to MEMBER, which is exactly `RELAY_MESSAGE`'s floor. All three
 * failures were silent, and the third was the subtlest: the capability check
 * was not bypassed, it was satisfied.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { InboundMessage } from "@sbr/bridge";
import { parseRoleBindings, parseRolePolicy } from "@sbr/guild-config";
import type { BridgeCapability, IdentityService, MemberRole } from "@sbr/shared-types";
import { BridgeGuardImpl, type BridgeGuardReads } from "./adapters.js";
import type { RedisContext } from "@sbr/redis";

/** Only `exists` is reached by `canRelay`; the rest of the context is unused. */
const redis = { client: { async exists() { return 0; } }, keys: {} } as unknown as RedisContext;

function guard(over: {
  /** What the stored permission stack says. Default: nobody is a member. */
  capable?: ReadonlySet<string>;
  linked?: Readonly<Record<string, string>>;
  denied?: readonly string[];
  allowed?: readonly string[];
  /** Discord role id per platform role, e.g. `{ ADMIN: "r-admin" }`. */
  roleIds?: Readonly<Partial<Record<MemberRole, string>>>;
  /** Discord ids linked to somebody on the in-game roster. */
  onRoster?: readonly string[];
  /** Stored platform roles, for the staff exemption. */
  roles?: Readonly<Record<string, MemberRole>>;
  /** Null means `guild-scan` has never run — the pre-roster posture. */
  scannedAt?: Date | null;
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
      if ((over.denied ?? []).includes(discordId)) return [{ capability: "RELAY_MESSAGE", allow: false }];
      if ((over.allowed ?? []).includes(discordId)) return [{ capability: "RELAY_MESSAGE", allow: true }];
      return [];
    },
    async roleBindings() {
      if (over.roleIds === undefined) return parseRoleBindings(null);
      return parseRoleBindings(
        Object.fromEntries(Object.entries(over.roleIds).map(([role, id]) => [role, [id]])),
      );
    },
    async rolePolicy() {
      return parseRolePolicy(undefined);
    },
    async hasRosterLink(_g, discordId) {
      return (over.onRoster ?? []).includes(discordId);
    },
    async rosterScannedAt() {
      // Default: the roster *has* been scanned, since that is the steady state
      // and therefore the state most cases should be asserting against.
      return over.scannedAt === undefined ? new Date() : over.scannedAt;
    },
    async memberRole(_g, discordId) {
      return over.roles?.[discordId] ?? null;
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

test("joining the Discord server does not buy a seat in guild chat", async () => {
  // The regression this file exists for. `discord-member-sync` writes a
  // GuildMember row for every account in the server and the role column
  // defaults to MEMBER, so the capability check answers *yes* for a stranger —
  // it is satisfied, not bypassed, which is why no permission fix reached it.
  // The roster is the credential now, exactly as guild chat is on the other side.
  const g = guard({ capable: new Set(["111"]) });
  assert.equal(
    await g.canRelay(msg({ live: { isGuildMember: true, roleIds: [] } })),
    false,
    "in the Discord, not in the guild: nothing to say into guild chat with",
  );
});

test("a member of the in-game guild may speak", async () => {
  const g = guard({ onRoster: ["111"] });
  assert.equal(await g.canRelay(msg()), true);
});

test("staff speak without being on the roster", async () => {
  // Officers run the guild from Discord and frequently do not play. Both the
  // stored role and the gateway's live role list are accepted, so a promotion
  // is not held up by the member sync.
  const stored = guard({ roles: { "111": "MODERATOR" } });
  assert.equal(await stored.canRelay(msg()), true, "stored role");

  const live = guard({ roleIds: { ADMIN: "r-admin" } });
  assert.equal(
    await live.canRelay(msg({ live: { isGuildMember: true, roleIds: ["r-admin"] } })),
    true,
    "mapped Discord role",
  );
});

test("a plain server member's live roles cannot forge guild membership", async () => {
  // `resolveMemberRole` floors an unmapped member at MEMBER, so the live
  // reading must only ever *raise* somebody — never stand in for the roster.
  const g = guard({ roleIds: { ADMIN: "r-admin" } });
  assert.equal(await g.canRelay(msg({ live: { isGuildMember: true, roleIds: ["r-other"] } })), false);
});

test("an explicit grant lets a named non-member speak", async () => {
  // The escape hatch for a guest or an ally's officer, without putting them on
  // the roster or promoting them.
  const g = guard({ allowed: ["111"] });
  assert.equal(await g.canRelay(msg()), true);
});

test("a deny row outranks the roster and the staff exemption", async () => {
  const g = guard({ denied: ["111"], onRoster: ["111"], roles: { "111": "ADMIN" } });
  assert.equal(await g.canRelay(msg()), false);
});

test("nobody is silenced because the roster scan has not run yet", async () => {
  // The opposite failure, and the one this gate has already made once: a fresh
  // install has no roster to check against, so the pre-roster posture stands
  // until `guild-scan` writes its first row.
  const g = guard({ scannedAt: null });
  assert.equal(await g.canRelay(msg()), false, "no roster and no live facts: nothing to go on");
  assert.equal(
    await g.canRelay(msg({ live: { isGuildMember: true, roleIds: [] } })),
    true,
    "the gateway is holding the only truth available",
  );

  const stored = guard({ scannedAt: null, capable: new Set(["111"]) });
  assert.equal(await stored.canRelay(msg()), true, "the stored stack still counts");
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
