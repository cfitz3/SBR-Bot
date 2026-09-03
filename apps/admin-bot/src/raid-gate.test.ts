import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ANTIRAID, type AntiRaidRules } from "@sbr/moderation";
import type { Client, GuildMember } from "discord.js";
import { JoinWindow, attachRaidGate, type RaidGateDeps } from "./raid-gate.js";

test("the window counts only the joins still inside it", () => {
  const w = new JoinWindow();
  const t0 = 1_000_000;
  assert.equal(w.record("g", 60, t0), 1);
  assert.equal(w.record("g", 60, t0 + 10_000), 2);
  assert.equal(w.record("g", 60, t0 + 20_000), 3);
  // A minute later the first three have aged out and this is a fresh burst,
  // which is the whole point: a busy server is not a raid.
  assert.equal(w.record("g", 60, t0 + 90_000), 1);
});

test("guilds are counted separately", () => {
  const w = new JoinWindow();
  w.record("a", 60, 0);
  w.record("a", 60, 1);
  assert.equal(w.record("b", 60, 2), 1);
});

test("pruning drops guilds that have gone quiet", () => {
  const w = new JoinWindow();
  w.record("a", 60, 0);
  w.prune(60, 120_000);
  assert.equal(w.record("a", 60, 120_001), 1);
});

/**
 * The gate itself, driven through the listener `attachRaidGate` registers.
 *
 * A fake client rather than a mocked gateway: the only thing worth asserting is
 * what the gate does with a member handed to it, and the handler is the seam
 * where that starts.
 */
const NOW = 1_700_000_000_000;

interface Harness {
  join(member: GuildMember): Promise<void>;
  readonly punished: string[];
  readonly flagged: string[];
  readonly engaged: string[];
}

function harness(
  rules: Partial<AntiRaidRules> = {},
  postureActive = false,
  guildId: string | null = "guild-1",
): Harness {
  let handler: ((member: GuildMember) => void) | null = null;
  const punished: string[] = [];
  const flagged: string[] = [];
  const engaged: string[] = [];
  const deps: RaidGateDeps = {
    resolveGuild: async () => guildId,
    rules: async () => ({ ...DEFAULT_ANTIRAID, ...rules }),
    postureActive: async () => postureActive,
    engage: async (guildId) => void engaged.push(guildId),
    punish: async ({ discordId, action }) => void punished.push(`${action}:${discordId}`),
    flag: async ({ discordId }) => void flagged.push(discordId),
    logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as RaidGateDeps["logger"],
    now: () => NOW,
  };
  const client = {
    on(_event: string, cb: (member: GuildMember) => void) {
      handler = cb;
    },
  } as unknown as Client;
  attachRaidGate(client, deps);
  return {
    async join(member) {
      handler?.(member);
      // The listener fires the gate without awaiting it, so drain the
      // microtasks the gate's own awaits are queued behind before asserting.
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    },
    punished,
    flagged,
    engaged,
  };
}

function member(over: { bot?: boolean; ageHours?: number; avatar?: string | null } = {}): GuildMember {
  return {
    id: "user-1",
    guild: { id: "discord-1" },
    user: {
      bot: over.bot ?? false,
      avatar: over.avatar === undefined ? "hash" : over.avatar,
      createdTimestamp: NOW - (over.ageHours ?? 24 * 365) * 3_600_000,
    },
  } as unknown as GuildMember;
}

test("a brand-new account is flagged once the posture is on", async () => {
  const h = harness({ joinAction: "KICK" }, true);
  await h.join(member({ ageHours: 1 }));
  assert.deepEqual(h.punished, ["KICK:user-1"]);
});

test("a bot is not judged as a member", async () => {
  // Every heuristic here fires on a fresh integration at once — no age, often
  // no avatar — and a KICK reaching one would undo the staff decision that
  // added it.
  const h = harness({ joinAction: "BAN", requireAvatar: true }, true);
  await h.join(member({ bot: true, ageHours: 0, avatar: null }));
  assert.deepEqual(h.punished, []);
  assert.deepEqual(h.flagged, []);
});

test("bots do not count toward the burst that engages the posture", async () => {
  // The skip has to land before the window is touched. A staffer wiring up
  // integrations must not be able to put the guild into a posture aimed at
  // people.
  const h = harness({ burst: { joins: 3, windowSeconds: 60 }, autoEngage: true });
  for (let i = 0; i < 5; i += 1) await h.join(member({ bot: true }));
  assert.deepEqual(h.engaged, []);

  await h.join(member());
  await h.join(member());
  assert.deepEqual(h.engaged, []);
  await h.join(member());
  assert.deepEqual(h.engaged, ["guild-1"]);
});

test("an unmapped guild is left alone", async () => {
  const h = harness({ joinAction: "BAN" }, true, null);
  await h.join(member({ ageHours: 0, avatar: null }));
  assert.deepEqual(h.punished, []);
  assert.deepEqual(h.flagged, []);
});
