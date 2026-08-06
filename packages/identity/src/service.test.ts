/**
 * Identity service unit tests — the /link social-match flow and friends.
 * Uses Node's built-in test runner (no external deps) with in-memory fakes for
 * the repository and Hypixel social lookup ports.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BridgeCapability,
  HypixelSocialLookup,
  HypixelSocialResult,
  IdentityRepository,
  LinkedIdentityDTO,
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
  capabilities: Map<string, BridgeCapability[]>; // `${guildId}:${discordId}` -> caps
}

function makeRepo(state: FakeState): IdentityRepository {
  return {
    async findPrimaryLinkByDiscordId(discordId) {
      return state.links.get(discordId) ?? null;
    },
    async findMinecraftOwnerDiscordId(uuid) {
      return state.owners.get(uuid) ?? null;
    },
    async createVerifiedLink({ discordId, uuid, ign }) {
      const dto: LinkedIdentityDTO = {
        discordId,
        minecraftUuid: uuid,
        ign,
        status: "VERIFIED",
        primary: true,
        verifiedAt: new Date().toISOString(),
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
    async getUserCapabilities(guildId, discordId) {
      return state.capabilities.get(`${guildId}:${discordId}`) ?? [];
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
  return { owners: new Map(), links: new Map(), capabilities: new Map() };
}

test("linkByIgn verifies when the Hypixel social Discord field matches the caller", async () => {
  const state = emptyState();
  const svc = new IdentityServiceImpl({
    repo: makeRepo(state),
    social: makeSocial({
      Aria: { kind: "FOUND", uuid: "uuid-aria", ign: "Aria", discordId: "111" },
    }),
    logger: silentLogger,
  });

  const result = await svc.linkByIgn("111", "Aria");

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, "VERIFIED");
    assert.equal(result.value.minecraftUuid, "uuid-aria");
    assert.equal(result.value.primary, true);
  }
  assert.equal(state.owners.get("uuid-aria"), "111");
});

test("linkByIgn rejects when the in-game social field is unset", async () => {
  const svc = new IdentityServiceImpl({
    repo: makeRepo(emptyState()),
    social: makeSocial({
      Aria: { kind: "FOUND", uuid: "uuid-aria", ign: "Aria", discordId: null },
    }),
    logger: silentLogger,
  });

  const result = await svc.linkByIgn("111", "Aria");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "SOCIAL_UNSET");
});

test("linkByIgn rejects when the social field points at a different Discord id", async () => {
  const svc = new IdentityServiceImpl({
    repo: makeRepo(emptyState()),
    social: makeSocial({
      Aria: { kind: "FOUND", uuid: "uuid-aria", ign: "Aria", discordId: "999" },
    }),
    logger: silentLogger,
  });

  const result = await svc.linkByIgn("111", "Aria");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "SOCIAL_MISMATCH");
});

test("linkByIgn rejects an unknown IGN", async () => {
  const svc = new IdentityServiceImpl({
    repo: makeRepo(emptyState()),
    social: makeSocial({}),
    logger: silentLogger,
  });

  const result = await svc.linkByIgn("111", "Ghost");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "IGN_NOT_FOUND");
});

test("linkByIgn rejects when the Minecraft account is already owned by someone else", async () => {
  const state = emptyState();
  state.owners.set("uuid-aria", "222");
  const svc = new IdentityServiceImpl({
    repo: makeRepo(state),
    social: makeSocial({
      Aria: { kind: "FOUND", uuid: "uuid-aria", ign: "Aria", discordId: "111" },
    }),
    logger: silentLogger,
  });

  const result = await svc.linkByIgn("111", "Aria");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "ALREADY_OWNED");
    if (result.error.kind === "ALREADY_OWNED") assert.equal(result.error.byDiscordId, "222");
  }
});

test("re-linking the same account by its existing owner succeeds (idempotent)", async () => {
  const state = emptyState();
  state.owners.set("uuid-aria", "111");
  const svc = new IdentityServiceImpl({
    repo: makeRepo(state),
    social: makeSocial({
      Aria: { kind: "FOUND", uuid: "uuid-aria", ign: "Aria", discordId: "111" },
    }),
    logger: silentLogger,
  });

  const result = await svc.linkByIgn("111", "Aria");
  assert.equal(result.ok, true);
});

test("resolveByDiscordId returns null when unlinked, the DTO when linked", async () => {
  const state = emptyState();
  const svc = new IdentityServiceImpl({
    repo: makeRepo(state),
    social: makeSocial({
      Aria: { kind: "FOUND", uuid: "uuid-aria", ign: "Aria", discordId: "111" },
    }),
    logger: silentLogger,
  });

  assert.equal((await svc.resolveByDiscordId("111")).ok, true);
  const before = await svc.resolveByDiscordId("111");
  assert.equal(before.ok && before.value, null);

  await svc.linkByIgn("111", "Aria");
  const after = await svc.resolveByDiscordId("111");
  assert.equal(after.ok, true);
  if (after.ok) assert.equal(after.value?.ign, "Aria");
});

test("hasCapability honors granted caps and the ADMIN override", async () => {
  const state = emptyState();
  state.capabilities.set("guild-1:111", ["RUN_COMMAND"]);
  state.capabilities.set("guild-1:222", ["ADMIN"]);
  const svc = new IdentityServiceImpl({
    repo: makeRepo(state),
    social: makeSocial({}),
    logger: silentLogger,
  });

  assert.equal(await svc.hasCapability("guild-1", "111", "RUN_COMMAND"), true);
  assert.equal(await svc.hasCapability("guild-1", "111", "MENTION"), false);
  // ADMIN implies every capability.
  assert.equal(await svc.hasCapability("guild-1", "222", "BYPASS_FILTER"), true);
  assert.equal(await svc.hasCapability("guild-1", "333", "RUN_COMMAND"), false);
});
