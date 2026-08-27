/**
 * These tests are about restraint. The observer's job is to notice a
 * hand-placed punishment, and almost every way it can go wrong is a false
 * positive: adopting the platform's own ban a second time, or turning somebody
 * who quit into somebody who was kicked. Each of those writes a case that says
 * something untrue about a real person, and with relay sync on the second one
 * kicks them out of the Minecraft guild for leaving a Discord server.
 *
 * So most of what follows asserts that nothing was recorded.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLogEvent, Events } from "discord.js";
import type { Client } from "discord.js";
import type { Logger } from "@sbr/observability";
import { attachDiscordModObserver, type DiscordModObserverDeps } from "./discord-mod-observer.js";

const silent: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

const BOT = "bot-1";
const STAFF = "staff-1";
const TARGET = "target-1";

interface Entry {
  readonly targetId: string;
  readonly executorId: string | null;
  readonly reason: string | null;
  readonly createdTimestamp: number;
}

type Recorded = Parameters<DiscordModObserverDeps["record"]>[0];

/**
 * A client stubbed down to what the observer touches: `on`, and a user id it
 * compares executors against. The handlers are captured so a test can fire an
 * event without a gateway.
 */
function harness(options: {
  readonly entries?: Partial<Record<AuditLogEvent, readonly Entry[]>>;
  readonly auditThrows?: boolean;
  readonly resolvesTo?: string | null;
} = {}) {
  const handlers = new Map<string, (payload: unknown) => void>();
  const recorded: Recorded[] = [];
  let auditCalls = 0;

  const guild = {
    id: "discord-guild",
    async fetchAuditLogs({ type }: { type: AuditLogEvent }) {
      auditCalls += 1;
      if (options.auditThrows === true) throw new Error("Missing Permissions");
      const rows = options.entries?.[type] ?? [];
      return { entries: new Map(rows.map((r, i) => [String(i), r])) };
    },
  };

  const client = {
    user: { id: BOT },
    on(event: string, handler: (payload: unknown) => void) {
      handlers.set(event, handler);
    },
  } as unknown as Client;

  attachDiscordModObserver(client, {
    resolveGuild: async () =>
      options.resolvesTo === undefined ? "platform-guild" : options.resolvesTo,
    async record(input) {
      recorded.push(input);
    },
    logger: silent,
    // The kick path waits for Discord to write its audit entry. Two real
    // seconds per test is not a thing worth buying.
    settleMs: 0,
  });

  const fire = async (event: string, payload: unknown): Promise<void> => {
    handlers.get(event)?.(payload);
    // One turn for the ban paths, a little slack for the kick path's timer.
    await new Promise((resolve) => setTimeout(resolve, 5));
  };

  return {
    recorded,
    auditCalls: () => auditCalls,
    ban: (user = TARGET) => fire(Events.GuildBanAdd, { guild, user: { id: user } }),
    unban: (user = TARGET) => fire(Events.GuildBanRemove, { guild, user: { id: user } }),
    leave: (user = TARGET) => fire(Events.GuildMemberRemove, { guild, id: user }),
  };
}

function entry(over: Partial<Entry> = {}): Entry {
  return {
    targetId: TARGET,
    executorId: STAFF,
    reason: "spam",
    createdTimestamp: Date.now(),
    ...over,
  };
}

test("a ban placed by hand in Discord becomes a case, with the staffer and reason from the audit log", async () => {
  const h = harness({ entries: { [AuditLogEvent.MemberBanAdd]: [entry()] } });
  await h.ban();
  assert.deepEqual(h.recorded, [
    {
      guildId: "platform-guild",
      type: "BAN",
      targetDiscordId: TARGET,
      actorDiscordId: STAFF,
      reason: "spam",
    },
  ]);
});

test("the platform's own ban is not adopted a second time", async () => {
  const h = harness({ entries: { [AuditLogEvent.MemberBanAdd]: [entry({ executorId: BOT })] } });
  await h.ban();
  assert.deepEqual(h.recorded, [], "the bot's own enforcement is already a case");
});

test("an unban is adopted the same way", async () => {
  const h = harness({
    entries: { [AuditLogEvent.MemberBanRemove]: [entry({ reason: null })] },
  });
  await h.unban();
  assert.equal(h.recorded[0]?.type, "UNBAN");
  assert.equal(h.recorded[0]?.reason, "Unbanned in Discord", "a blank reason gets a plain one");
});

test("a ban is still recorded when the audit log cannot be read, with an unknown actor", async () => {
  const h = harness({ auditThrows: true });
  await h.ban();
  assert.equal(h.recorded.length, 1, "the ban happened whether or not we can see who did it");
  assert.equal(h.recorded[0]?.actorDiscordId, "discord");
});

test("an audit entry for somebody else does not attribute the ban to them", async () => {
  const h = harness({
    entries: { [AuditLogEvent.MemberBanAdd]: [entry({ targetId: "someone-else" })] },
  });
  await h.ban();
  assert.equal(h.recorded[0]?.actorDiscordId, "discord");
});

test("a stale audit entry is not read as an explanation of this ban", async () => {
  const h = harness({
    entries: {
      [AuditLogEvent.MemberBanAdd]: [entry({ createdTimestamp: Date.now() - 60 * 60_000 })],
    },
  });
  await h.ban();
  assert.equal(h.recorded[0]?.actorDiscordId, "discord", "an hour-old entry explains nothing");
});

test("a member who left of their own accord is not recorded as kicked", async () => {
  const h = harness({ entries: { [AuditLogEvent.MemberKick]: [] } });
  await h.leave();
  assert.deepEqual(h.recorded, []);
});

test("a member kicked by a staffer is recorded as kicked", async () => {
  const h = harness({ entries: { [AuditLogEvent.MemberKick]: [entry({ reason: "  rude \n" })] } });
  await h.leave();
  assert.deepEqual(h.recorded, [
    {
      guildId: "platform-guild",
      type: "KICK",
      targetDiscordId: TARGET,
      actorDiscordId: STAFF,
      reason: "rude",
    },
  ]);
});

test("a member the platform itself kicked is not recorded twice", async () => {
  const h = harness({ entries: { [AuditLogEvent.MemberKick]: [entry({ executorId: BOT })] } });
  await h.leave();
  assert.deepEqual(h.recorded, []);
});

test("a stale kick entry does not turn a departure into a kick", async () => {
  const h = harness({
    entries: {
      [AuditLogEvent.MemberKick]: [entry({ createdTimestamp: Date.now() - 60 * 60_000 })],
    },
  });
  await h.leave();
  assert.deepEqual(h.recorded, [], "someone kicked last week who has now left is not kicked again");
});

test("a server this platform does not know about is left alone, and not even looked up", async () => {
  const h = harness({
    resolvesTo: null,
    entries: { [AuditLogEvent.MemberBanAdd]: [entry()] },
  });
  await h.ban();
  assert.deepEqual(h.recorded, []);
  assert.equal(h.auditCalls(), 0, "no audit-log call for a server whose moderation is not ours");
});
