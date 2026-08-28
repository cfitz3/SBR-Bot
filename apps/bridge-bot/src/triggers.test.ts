import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TriggerRule } from "@sbr/shared-types";
import type { MessageEvent, ReactionEvent } from "@sbr/triggers";
import {
  FIRING_TTL_SECONDS,
  RULE_CACHE_MS,
  createTriggerRunner,
  type TriggerSubject,
} from "./triggers.js";

const STAR: TriggerRule = {
  id: "star",
  label: "Starboard",
  enabled: true,
  when: { kind: "REACTION_COUNT", emoji: "⭐", threshold: 3 },
  then: { kind: "REPOST", channelId: "222222222222222222" },
  channels: [],
  exemptChannels: [],
  includeBots: false,
  includeSelf: false,
};

const SUBJECT: TriggerSubject = {
  authorName: "Aria",
  authorAvatarUrl: null,
  content: "the good post",
  imageUrl: null,
  hasOtherAttachments: false,
  jumpUrl: "https://discord.com/channels/1/2/3",
  postedAt: "2026-08-01T10:00:00.000Z",
};

const REACTION: ReactionEvent = {
  channelId: "111111111111111111",
  messageId: "333333333333333333",
  emoji: "⭐",
  count: 4,
  authorId: "444444444444444444",
  authorIsBot: false,
  authorReacted: false,
};

interface Harness {
  readonly reposts: { channelId: string; title: string; description: string }[];
  readonly pins: string[];
  readonly replies: { messageId: string; text: string }[];
  readonly claims: { key: string; ttl: number }[];
  readonly warnings: string[];
  reads: number;
}

function harness(
  rules: readonly TriggerRule[],
  over: {
    claim?: (key: string) => Promise<boolean>;
    listRules?: () => Promise<readonly TriggerRule[]>;
    repost?: () => Promise<void>;
    now?: () => number;
  } = {},
): { runner: ReturnType<typeof createTriggerRunner>; state: Harness } {
  const state: Harness = { reposts: [], pins: [], replies: [], claims: [], warnings: [], reads: 0 };
  const runner = createTriggerRunner({
    async listRules() {
      state.reads += 1;
      return over.listRules === undefined ? rules : over.listRules();
    },
    async claim(_guildId, key, ttl) {
      state.claims.push({ key, ttl });
      return over.claim === undefined ? true : over.claim(key);
    },
    effects: {
      async repost(channelId, embed) {
        if (over.repost !== undefined) await over.repost();
        state.reposts.push({
          channelId,
          title: embed.title ?? "",
          description: embed.description ?? "",
        });
      },
      async pin(_channelId, messageId) {
        state.pins.push(messageId);
      },
      async reply(_channelId, messageId, text) {
        state.replies.push({ messageId, text });
      },
    },
    log: {
      warn(message) {
        state.warnings.push(message);
      },
    },
    ...(over.now === undefined ? {} : { now: over.now }),
  });
  return { runner, state };
}

describe("trigger runner", () => {
  it("reposts a message that crossed the threshold, dated by the original", async () => {
    const { runner, state } = harness([STAR]);
    await runner.onReaction("g1", REACTION, SUBJECT);

    assert.equal(state.reposts.length, 1);
    assert.equal(state.reposts[0]?.channelId, "222222222222222222");
    // The rule's own label titles the card, so two boards do not look like one.
    assert.match(state.reposts[0]?.title ?? "", /Starboard/);
    assert.match(state.reposts[0]?.description ?? "", /the good post/);
    assert.deepEqual(state.claims, [{ key: "star:333333333333333333", ttl: FIRING_TTL_SECONDS }]);
  });

  it("posts once however many more people react", async () => {
    // The whole reason the ledger exists: every reaction past the threshold
    // satisfies the rule again, so only the claim can stop the repeat.
    const claimed = new Set<string>();
    const { runner, state } = harness([STAR], {
      async claim(key) {
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      },
    });

    for (const count of [3, 4, 5, 12]) {
      await runner.onReaction("g1", { ...REACTION, count }, SUBJECT);
    }

    assert.equal(state.reposts.length, 1);
    assert.equal(state.claims.length, 4);
  });

  it("treats an unavailable ledger as already fired, and says so", async () => {
    const { runner, state } = harness([STAR], {
      claim: () => Promise.reject(new Error("redis down")),
    });
    await runner.onReaction("g1", REACTION, SUBJECT);

    assert.equal(state.reposts.length, 0);
    assert.equal(state.warnings.length, 1);
  });

  it("a failed action does not stop the next rule on the same message", async () => {
    const pinToo: TriggerRule = { ...STAR, id: "pin-it", then: { kind: "PIN" } };
    const { runner, state } = harness([STAR, pinToo], {
      repost: () => Promise.reject(new Error("missing permission")),
    });
    await runner.onReaction("g1", REACTION, SUBJECT);

    assert.deepEqual(state.pins, ["333333333333333333"]);
    assert.equal(state.warnings.length, 1);
  });

  it("runs the reply action on a phrase match, and never a reaction rule", async () => {
    const greet: TriggerRule = {
      ...STAR,
      id: "greet",
      when: { kind: "MESSAGE_CONTAINS", phrase: "how do i link" },
      then: { kind: "REPLY", text: "Run /link." },
    };
    const event: MessageEvent = {
      channelId: "111111111111111111",
      messageId: "555555555555555555",
      content: "hey, How do I link my account?",
      authorId: "444444444444444444",
      authorIsBot: false,
    };
    const { runner, state } = harness([STAR, greet]);
    await runner.onMessage("g1", event, SUBJECT);

    assert.deepEqual(state.replies, [{ messageId: "555555555555555555", text: "Run /link." }]);
    assert.equal(state.reposts.length, 0);
  });

  it("caches the rule list, and re-reads it after invalidation", async () => {
    let clock = 0;
    const { runner, state } = harness([STAR], { now: () => clock });

    await runner.onReaction("g1", REACTION, SUBJECT);
    await runner.onReaction("g1", { ...REACTION, messageId: "9" }, SUBJECT);
    assert.equal(state.reads, 1);

    runner.invalidate("g1");
    await runner.onReaction("g1", { ...REACTION, messageId: "10" }, SUBJECT);
    assert.equal(state.reads, 2);

    clock += RULE_CACHE_MS + 1;
    await runner.onReaction("g1", { ...REACTION, messageId: "11" }, SUBJECT);
    assert.equal(state.reads, 3);
  });

  it("keeps serving the last known rules when the read fails", async () => {
    let clock = 0;
    let fail = false;
    const { runner, state } = harness([STAR], {
      now: () => clock,
      listRules: () => (fail ? Promise.reject(new Error("db down")) : Promise.resolve([STAR])),
    });

    await runner.onReaction("g1", REACTION, SUBJECT);
    fail = true;
    clock += RULE_CACHE_MS + 1;
    await runner.onReaction("g1", { ...REACTION, messageId: "9" }, SUBJECT);

    assert.equal(state.reposts.length, 2);
  });

  it("does nothing at all for a guild with no rules", async () => {
    const { runner, state } = harness([]);
    await runner.onReaction("g1", REACTION, SUBJECT);

    assert.equal(state.claims.length, 0);
    assert.equal(state.reposts.length, 0);
  });
});
