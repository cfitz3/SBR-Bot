/**
 * Identity service unit tests — the /link social-match flow and capability
 * resolution. Uses Node's built-in test runner (no external deps) with
 * in-memory fakes for the repository, role reader and Hypixel social lookup.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CapabilityGrant,
  HypixelSocialLookup,
  HypixelSocialResult,
  IdentityRepository,
  LinkedIdentityDTO,
  MemberRole,
  MemberRoleReader,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import { IdentityServiceImpl } from "./service.js";

// A logger that captures nothing (keeps test output clean) but satisfies the interface.
const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

interface FakeState {
  owners: Map<string, string>; // uuid -> owner discordId
  links: Map<string, LinkedIdentityDTO>; // discordId -> primary link
  grants: Map<string, CapabilityGrant[]>; // `${guildId}:${discordId}` -> rows
  roles: Map<string, MemberRole>; // `${guildId}:${discordId}` -> platform role
}

function makeRepo(state: FakeState): IdentityRepository {
  return {
    async findPrimaryLinkByDiscordId(discordId) {
      return state.links.get(discordId) ?? null;
    },
    async findMinecraftOwnerDiscordId(uuid) {
      return state.owners.get(uuid) ?? null;
    },
    async findDiscordIdByIgn(ign) {
      for (const [discordId, dto] of state.links) {
        if (dto.ign.toLowerCase() === ign.toLowerCase()) return discordId;
      }
      return null;
    },
    async createVerifiedLink({ discordId, uuid, ign }) {
      const dto: LinkedIdentityDTO = {
        discordId,
        minecraftUuid: uuid,
        ign,
        status: "VERIFIED",
        primary: true,
        verifiedAt: new Date(0).toISOString(),
      };
      state.owners.set(uuid, discordId);
      state.links.set(discordId, dto);
      return dto;
    },
    async unlink(discordId, uuid) {
      const owner = state.owners.get(uuid);
      if (owner === discordId) {
        state.owners.delete(uuid);
        state.links.delete(discordId);
        return true;
      }
      return false;
    },
    async getCapabilityGrants(guildId, discordId) {
      return state.grants.get(`${guildId}:${discordId}`) ?? [];
    },
  };
}

/** Mirrors `rankResolver`: an unknown member is a plain MEMBER, not an error. */
function makeRoles(state: FakeState): MemberRoleReader {
  return {
    async getRole(guildId, discordId) {
      return state.roles.get(`${guildId}:${discordId}`) ?? "MEMBER";
    },
  };
}

function makeSocial(map: Record<string, HypixelSocialResult>): HypixelSocialLookup {
  return {
    async getLinkedDiscord(ign) {
      return map[ign] ?? { kind: "IGN_NOT_FOUND" };
    },
  };
}

function emptyState(): FakeState {
  return { owners: new Map(), links: new Map(), grants: new Map(), roles: new Map() };
}

function makeService(state: FakeState, social: Record<string, HypixelSocialResult> = {}) {
  return new IdentityServiceImpl({
    repo: makeRepo(state),
    social: makeSocial(social),
    roles: makeRoles(state),
    logger: silentLogger,
  });
}

/** The caller as the Discord transport supplies them: snowflake plus handle. */
const ARIA = { discordId: "111", username: "aria" };

// ── /link ──────────────────────────────────────────────────────────────────

/**
 * The field holds a Discord *username*, not a snowflake — confirmed against the
 * live API, which returns values like "refraction". Matching it against the
 * caller's id was rejecting every correct link.
 */
test("linkByIgn verifies when the social field holds the caller's username", async () => {
  const state = emptyState();
  const svc = makeService(state, {
    Aria: { kind: "FOUND", uuid: "uuid-aria", ign: "Aria", discordId: "Aria" },
  });

  const result = await svc.linkByIgn(ARIA, "Aria");

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, "VERIFIED");
    assert.equal(result.value.minecraftUuid, "uuid-aria");
    assert.equal(result.value.primary, true);
  }
  assert.equal(state.owners.get("uuid-aria"), "111");
});

/** Hypixel keeps whatever was typed years ago, discriminator and all. */
test("a legacy tagged handle matches on the username part", async () => {
  const svc = makeService(emptyState(), {
    Aria: { kind: "FOUND", uuid: "uuid-aria", ign: "Aria", discordId: " ARIA#9817 " },
  });
  assert.equal((await svc.linkByIgn(ARIA, "Aria")).ok, true);
});

/** Some players paste their raw id instead; only its owner can match it. */
test("linkByIgn still accepts a social field holding the caller's id", async () => {
  const svc = makeService(emptyState(), {
    Aria: { kind: "FOUND", uuid: "uuid-aria", ign: "Aria", discordId: "111" },
  });
  assert.equal((await svc.linkByIgn(ARIA, "Aria")).ok, true);
});

test("linkByIgn rejects when the in-game social field is unset", async () => {
  const svc = makeService(emptyState(), {
    Aria: { kind: "FOUND", uuid: "uuid-aria", ign: "Aria", discordId: null },
  });

  const result = await svc.linkByIgn(ARIA, "Aria");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "SOCIAL_UNSET");
});

test("linkByIgn rejects when the social field names someone else", async () => {
  const svc = makeService(emptyState(), {
    Aria: { kind: "FOUND", uuid: "uuid-aria", ign: "Aria", discordId: "someoneelse" },
  });

  const result = await svc.linkByIgn(ARIA, "Aria");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "SOCIAL_MISMATCH");
});

/** A caller with no username can only match the id form — never a username. */
test("an actor without a username cannot match a username-shaped field", async () => {
  const svc = makeService(emptyState(), {
    Aria: { kind: "FOUND", uuid: "uuid-aria", ign: "Aria", discordId: "aria" },
  });

  const result = await svc.linkByIgn({ discordId: "111" }, "Aria");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "SOCIAL_MISMATCH");
});

test("linkByIgn rejects an unknown IGN", async () => {
  const svc = makeService(emptyState());

  const result = await svc.linkByIgn(ARIA, "Ghost");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "IGN_NOT_FOUND");
});

test("linkByIgn rejects when the Minecraft account is already owned by someone else", async () => {
  const state = emptyState();
  state.owners.set("uuid-aria", "222");
  const svc = makeService(state, {
    Aria: { kind: "FOUND", uuid: "uuid-aria", ign: "Aria", discordId: "aria" },
  });

  const result = await svc.linkByIgn(ARIA, "Aria");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "ALREADY_OWNED");
    if (result.error.kind === "ALREADY_OWNED") assert.equal(result.error.byDiscordId, "222");
  }
});

test("re-linking the same account by its existing owner succeeds (idempotent)", async () => {
  const state = emptyState();
  state.owners.set("uuid-aria", "111");
  const svc = makeService(state, {
    Aria: { kind: "FOUND", uuid: "uuid-aria", ign: "Aria", discordId: "aria" },
  });

  assert.equal((await svc.linkByIgn(ARIA, "Aria")).ok, true);
});

test("resolveByDiscordId returns null when unlinked, the DTO when linked", async () => {
  const state = emptyState();
  const svc = makeService(state, {
    Aria: { kind: "FOUND", uuid: "uuid-aria", ign: "Aria", discordId: "aria" },
  });

  const before = await svc.resolveByDiscordId("111");
  assert.equal(before.ok && before.value, null);

  await svc.linkByIgn(ARIA, "Aria");
  const after = await svc.resolveByDiscordId("111");
  assert.equal(after.ok, true);
  if (after.ok) assert.equal(after.value?.ign, "Aria");
});

// ── capabilities ───────────────────────────────────────────────────────────

test("an explicit grant carries its capability, and ADMIN carries all of them", async () => {
  const state = emptyState();
  state.grants.set("g:111", [{ capability: "MENTION", allow: true }]);
  state.grants.set("g:222", [{ capability: "ADMIN", allow: true }]);
  const svc = makeService(state);

  assert.equal(await svc.hasCapability("g", "111", "MENTION"), true);
  assert.equal(await svc.hasCapability("g", "111", "BYPASS_FILTER"), false);
  assert.equal(await svc.hasCapability("g", "222", "BYPASS_FILTER"), true);
});

/**
 * The bug this file's floors exist for: BridgePermission starts empty, so
 * resolving from rows alone denied every command to everyone — including the
 * owner, who had no way to grant themselves anything.
 */
test("an OWNER holds every capability with no permission rows at all", async () => {
  const state = emptyState();
  state.roles.set("g:111", "OWNER");
  const svc = makeService(state);

  for (const cap of ["RELAY_MESSAGE", "RUN_COMMAND", "MENTION", "BYPASS_COOLDOWN", "BYPASS_FILTER", "ADMIN"] as const) {
    assert.equal(await svc.hasCapability("g", "111", cap), true, cap);
  }
});

/** COMMANDS.md §1–7: the lookup surface is Public, so a plain member may run it. */
test("a plain member may run commands and relay, but nothing privileged", async () => {
  const svc = makeService(emptyState());

  assert.equal(await svc.hasCapability("g", "999", "RUN_COMMAND"), true);
  assert.equal(await svc.hasCapability("g", "999", "RELAY_MESSAGE"), true);
  assert.equal(await svc.hasCapability("g", "999", "MENTION"), false);
  assert.equal(await svc.hasCapability("g", "999", "BYPASS_FILTER"), false);
});

test("intermediate roles unlock capabilities in rank order", async () => {
  const state = emptyState();
  state.roles.set("g:mod", "MODERATOR");
  state.roles.set("g:officer", "OFFICER");
  const svc = makeService(state);

  assert.equal(await svc.hasCapability("g", "mod", "MENTION"), true);
  assert.equal(await svc.hasCapability("g", "mod", "BYPASS_COOLDOWN"), false);
  assert.equal(await svc.hasCapability("g", "officer", "BYPASS_COOLDOWN"), true);
  assert.equal(await svc.hasCapability("g", "officer", "BYPASS_FILTER"), false);
});

/**
 * A deny row has to beat the role floor, or there is no way to silence one
 * person short of demoting them — and before this it was silently discarded.
 */
test("an explicit deny outranks both a grant and the role floor", async () => {
  const state = emptyState();
  state.roles.set("g:111", "OWNER");
  state.grants.set("g:111", [
    { capability: "RELAY_MESSAGE", allow: false },
    { capability: "RELAY_MESSAGE", allow: true },
  ]);
  const svc = makeService(state);

  assert.equal(await svc.hasCapability("g", "111", "RELAY_MESSAGE"), false);
  // Scoped to the one capability — the rest of the role's authority survives.
  assert.equal(await svc.hasCapability("g", "111", "RUN_COMMAND"), true);
});

// ── the immediate role pass ────────────────────────────────────────────────

const AriaSocial = { Aria: { kind: "FOUND" as const, uuid: "uuid-aria", ign: "Aria", discordId: "Aria" } };

function serviceWithMarker(
  state: FakeState,
  markMember: (discordId: string) => Promise<{ guilds: number; pending: boolean } | void>,
) {
  return new IdentityServiceImpl({
    repo: makeRepo(state),
    social: makeSocial(AriaSocial),
    roles: makeRoles(state),
    rolesDirty: { markMember },
    logger: silentLogger,
  });
}

test("a link applies roles on the request rather than only marking them", async () => {
  const marked: string[] = [];
  const svc = serviceWithMarker(emptyState(), async (discordId) => {
    marked.push(discordId);
    return { guilds: 1, pending: false };
  });

  const result = await svc.linkByIgn(ARIA, "Aria");

  assert.deepEqual(marked, ["111"]);
  assert.equal(result.ok && result.value.rolesPending, undefined);
});

test("a link Hypixel could not gate is reported pending, not failed", async () => {
  const svc = serviceWithMarker(emptyState(), async () => ({ guilds: 1, pending: true }));

  const result = await svc.linkByIgn(ARIA, "Aria");

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.rolesPending, true);
});

test("a marker that throws still leaves the member linked", async () => {
  const state = emptyState();
  const svc = serviceWithMarker(state, () => Promise.reject(new Error("redis down")));

  const result = await svc.linkByIgn(ARIA, "Aria");

  assert.equal(result.ok, true);
  assert.equal(state.owners.get("uuid-aria"), "111");
  // Unknown is not pending: the sweep still owns them, and telling somebody
  // their roles are "arriving shortly" when nothing was marked would be a lie.
  assert.equal(result.ok && result.value.rolesPending, undefined);
});
