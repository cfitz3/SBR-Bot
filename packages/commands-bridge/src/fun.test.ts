import assert from "node:assert/strict";
import { test } from "node:test";
import { noArgs, recordArgs } from "@sbr/shared-types";
import type { CommandArgs } from "@sbr/shared-types";
import {
  cringe,
  coinflip,
  eightBall,
  funSpecs,
  guildquote,
  parseDice,
  rank,
  readQuotes,
  roll,
  rps,
  rpsOutcome,
  vibeRank,
  QUOTES_SETTING_KEY,
} from "./fun.js";
import type { CommandContext, HandlerDeps } from "./types.js";

const GUILD = "guild-1";

function ctx(args: CommandArgs = noArgs, userId = "member-1"): CommandContext {
  return { guildId: GUILD, userId, surface: "BRIDGE_BOT", args };
}

/**
 * Only the deps the fun handlers actually reach for. The cast is deliberate:
 * `HandlerDeps` is the whole member surface, and a fun-command test that had to
 * stub identity, pricing and the market to flip a coin would be evidence these
 * handlers are reaching too far.
 */
function deps(over: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    config: { async getSetting() { return null; } },
    ...over,
  } as unknown as HandlerDeps;
}

/** A random source that walks a fixed list, so every outcome is asserted. */
function sequence(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] as number;
}

test("the 8-ball answers without repeating the question", async () => {
  const question = "will the raid drop tonight lmao @everyone";
  const reply = await eightBall(ctx(recordArgs({ question })), deps({ random: () => 0 }));
  assert.equal(reply.text, "🎱 It is certain.");
  assert.equal(reply.ephemeral, false);
  // The whole rule in one assertion: nothing the caller typed comes back out.
  assert.equal(reply.text.includes("raid"), false);
  assert.equal(reply.text.includes("@everyone"), false);
});

test("the 8-ball insists on being asked something", async () => {
  const reply = await eightBall(ctx(), deps());
  assert.equal(reply.ephemeral, true);
});

test("a random source at its ceiling still lands inside the answers", async () => {
  // `Math.random()` can return values arbitrarily close to 1; an unclamped
  // index would read off the end and reply "undefined".
  const reply = await eightBall(ctx(recordArgs({ question: "?" })), deps({ random: () => 0.999999999 }));
  assert.equal(reply.text, "🎱 Very doubtful.");
});

test("dice notation is read, and nonsense is not silently rolled", () => {
  assert.deepEqual(parseDice(null), { count: 1, sides: 100 });
  assert.deepEqual(parseDice(""), { count: 1, sides: 100 });
  assert.deepEqual(parseDice("20"), { count: 1, sides: 20 });
  assert.deepEqual(parseDice("d20"), { count: 1, sides: 20 });
  assert.deepEqual(parseDice("2d6"), { count: 2, sides: 6 });
  assert.deepEqual(parseDice(" 2D6 "), { count: 2, sides: 6 });
  assert.equal(parseDice("banana"), null);
  assert.equal(parseDice("0d6"), null);
  assert.equal(parseDice("d1"), null);
  // Bounded so one line of chat cannot ask for a thousand dice.
  assert.equal(parseDice("50d6"), null);
  assert.equal(parseDice("d99999"), null);
});

test("multiple dice show their total and their parts", async () => {
  const reply = await roll(ctx(recordArgs({ dice: "2d6" })), deps({ random: sequence(0.5, 0.99) }));
  assert.equal(reply.text, "🎲 2d6: **10** (4 + 6)");
});

test("a single die shows just the number", async () => {
  const reply = await roll(ctx(recordArgs({ dice: "d20" })), deps({ random: () => 0 }));
  assert.equal(reply.text, "🎲 d20: **1**");
});

test("a roll nobody can parse gets a hint rather than a default", async () => {
  const reply = await roll(ctx(recordArgs({ dice: "banana" })), deps());
  assert.equal(reply.ephemeral, true);
  assert.match(reply.text, /2d6/);
});

test("a coin has two sides and both are reachable", async () => {
  assert.match((await coinflip(ctx(), deps({ random: () => 0.1 }))).text, /Heads/);
  assert.match((await coinflip(ctx(), deps({ random: () => 0.9 }))).text, /Tails/);
});

test("rock, paper, scissors resolves the way it always has", () => {
  assert.equal(rpsOutcome("rock", "scissors"), "WIN");
  assert.equal(rpsOutcome("scissors", "paper"), "WIN");
  assert.equal(rpsOutcome("paper", "rock"), "WIN");
  assert.equal(rpsOutcome("rock", "paper"), "LOSE");
  assert.equal(rpsOutcome("paper", "paper"), "DRAW");
});

test("rps echoes only the throw it parsed", async () => {
  // A shorthand plus trailing nonsense: the reply names "scissors", not the
  // string the caller sent.
  const reply = await rps(ctx(recordArgs({ throw: "  SC  " })), deps({ random: () => 0 }));
  assert.equal(reply.text, "scissors vs rock — I win.");
});

test("rps refuses a throw that is not one of the three", async () => {
  const reply = await rps(ctx(recordArgs({ throw: "gun" })), deps());
  assert.equal(reply.ephemeral, true);
});

test("a guild's own quotes are used, bounded and sanity-checked", () => {
  assert.deepEqual(readQuotes(["one", " two ", "", 7, "x".repeat(500)]), ["one", "two"]);
  // Anything unreadable falls back rather than failing the command.
  assert.equal(readQuotes(null).length > 0, true);
  assert.equal(readQuotes("not a list").length > 0, true);
  assert.equal(readQuotes([]).length > 0, true);
  assert.equal(readQuotes(new Array(500).fill("q")).length, 100);
});

test("a stored quote is screened before the bot says it", async () => {
  const seen: string[] = [];
  const reply = await guildquote(
    ctx(),
    deps({
      config: { async getSetting() { return ["a bad old quote"]; } } as unknown as HandlerDeps["config"],
      screen: {
        async isClean(_guildId, text) {
          seen.push(text);
          return false;
        },
      },
      random: () => 0,
    }),
  );
  assert.deepEqual(seen, ["a bad old quote", "a bad old quote", "a bad old quote"]);
  // Three attempts and no more: a guild whose whole list trips the filter
  // must not make this command walk every entry.
  assert.equal(reply.ephemeral, true);
  assert.equal(reply.text.includes("bad old quote"), false);
});

test("a clean quote is said", async () => {
  const reply = await guildquote(
    ctx(),
    deps({
      config: { async getSetting() { return ["only quote"]; } } as unknown as HandlerDeps["config"],
      screen: { async isClean() { return true; } },
      random: () => 0,
    }),
  );
  assert.equal(reply.text, "💬 only quote");
  assert.equal(reply.ephemeral, false);
});

test("a settings read that throws still produces a quote", async () => {
  const reply = await guildquote(
    ctx(),
    deps({
      config: { async getSetting() { throw new Error("db down"); } } as unknown as HandlerDeps["config"],
      random: () => 0,
    }),
  );
  assert.equal(reply.ephemeral, false);
  assert.match(reply.text, /^💬 /);
});

test("the quote list is read from the documented setting key", async () => {
  const keys: string[] = [];
  await guildquote(
    ctx(),
    deps({
      config: { async getSetting(_g: string, key: string) { keys.push(key); return null; } } as unknown as HandlerDeps["config"],
      random: () => 0,
    }),
  );
  assert.deepEqual(keys, [QUOTES_SETTING_KEY]);
});

test("a vibe rank is the same next time it is asked for", () => {
  const first = vibeRank("aria");
  assert.deepEqual(vibeRank("aria"), first);
  assert.notDeepEqual(vibeRank("zed"), first);
  assert.equal(first.score >= 0 && first.score <= 100, true);
});

test("rank names whoever was asked about, and says it is not real", async () => {
  const mine = await rank(ctx(), deps());
  assert.match(mine.text, /^Your vibe rank: /);
  assert.match(mine.text, /Not a real rank/);

  const theirs = await rank(ctx(recordArgs({ player: "Aria" })), deps());
  assert.match(theirs.text, /^Aria's vibe rank: /);
  // Case is a display detail, not an identity: two spellings rank the same.
  const shouted = await rank(ctx(recordArgs({ player: "ARIA" })), deps());
  assert.equal(shouted.text.replace("ARIA", "Aria"), theirs.text);
});

test("rank will not repeat arbitrary text back into chat", async () => {
  const reply = await rank(ctx(recordArgs({ player: "@everyone get in vc" })), deps());
  assert.equal(reply.ephemeral, true);
  assert.equal(reply.text.includes("@everyone"), false);
});

test("cringe counts by name and reports the running total", async () => {
  const bumps: string[][] = [];
  const reply = await cringe(
    ctx(recordArgs({ player: "Aria" })),
    deps({
      tallies: {
        async bump(guildId, name, subject) {
          bumps.push([guildId, name, subject]);
          return 4;
        },
      },
    }),
  );
  assert.deepEqual(bumps, [[GUILD, "cringe", "aria"]]);
  assert.equal(reply.text, "😬 Aria — 4 cringes on record.");
});

test("one cringe is singular", async () => {
  const reply = await cringe(
    ctx(recordArgs({ player: "Aria" })),
    deps({ tallies: { async bump() { return 1; } } }),
  );
  assert.match(reply.text, /1 cringe on record/);
});

test("cringe only addresses something shaped like a Minecraft name", async () => {
  const tallies = { async bump() { return 1; } };
  for (const player of ["", "not a name", "waaaaaaaaaaaaaaaaay too long", "@everyone"]) {
    const reply = await cringe(ctx(recordArgs({ player })), deps({ tallies }));
    assert.equal(reply.ephemeral, true, player);
  }
});

test("cringe says so rather than lying when there is no counter", async () => {
  const missing = await cringe(ctx(recordArgs({ player: "Aria" })), deps());
  assert.equal(missing.ephemeral, true);

  const broken = await cringe(
    ctx(recordArgs({ player: "Aria" })),
    deps({ tallies: { async bump() { throw new Error("redis down"); } } }),
  );
  assert.equal(broken.ephemeral, true);
});

test("every fun command is reachable from guild chat and none of them can write", () => {
  const specs = funSpecs();
  assert.equal(specs.length, 7);
  for (const spec of specs) {
    // `true`, never `"linked"`: nothing here is attributed to a person, so
    // requiring a link would exclude players for no protection.
    assert.equal(spec.inGame, true, spec.name);
    assert.equal(spec.capability, undefined, spec.name);
    // Long enough that a bored member cannot turn guild chat into a slot machine.
    assert.equal(spec.cooldownMs >= 5_000, true, spec.name);
  }
});
