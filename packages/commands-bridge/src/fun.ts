/**
 * The fun commands (COMMANDS.md §19, PLATFORM_EXPANSION_PLAN.md Phase 11).
 *
 * These exist because guild chat is a social room and a bot that only answers
 * questions about networth is a vending machine. They are held to three rules,
 * each of which is a constraint the rest of the platform does not have:
 *
 * - **They never echo what somebody typed.** `!8ball` answers a question
 *   without repeating it, `!rps` echoes only the throw it managed to parse out
 *   of a fixed set, and `!cringe` addresses a Minecraft name. The bridge speaks
 *   with the guild's voice, so a command that repeats arbitrary text is a way to
 *   make the guild say anything — through a path the chat filter was never
 *   asked about.
 * - **Text the guild stored is screened before it is said.** `!guildquote` is
 *   the one command with an author, and an old quote can outlive the standards
 *   of the people who added it, so it goes through the same filter a relayed
 *   message does and a quote that fails is skipped rather than censored.
 * - **The only state is a counter.** `!cringe` keeps a tally in Redis with a
 *   rolling expiry and nothing else here remembers anything, so no fun command
 *   can grow into a feature with a migration behind it.
 *
 * Randomness comes from `deps.random` when a caller supplies one, which is what
 * makes every outcome here testable without asserting on a coin flip.
 */
import type { CommandHandler, CommandSpec } from "./types.js";

/** The classic twenty, in the classic proportions: 10 yes, 5 maybe, 5 no. */
const EIGHT_BALL_ANSWERS: readonly string[] = [
  "It is certain.",
  "It is decidedly so.",
  "Without a doubt.",
  "Yes — definitely.",
  "You may rely on it.",
  "As I see it, yes.",
  "Most likely.",
  "Outlook good.",
  "Yes.",
  "Signs point to yes.",
  "Reply hazy, try again.",
  "Ask again later.",
  "Better not tell you now.",
  "Cannot predict now.",
  "Concentrate and ask again.",
  "Don't count on it.",
  "My reply is no.",
  "My sources say no.",
  "Outlook not so good.",
  "Very doubtful.",
];

/**
 * The fallback quotes, for a guild that has not written its own.
 *
 * Deliberately about Skyblock rather than about anybody: a shipped quote list
 * that made jokes at a type of player would be the platform picking on someone
 * in a room where nobody chose it.
 */
const DEFAULT_QUOTES: readonly string[] = [
  "It's only gambling if you lose.",
  "One more run. — everyone, at 3am",
  "The best time to start grinding was a year ago. The second best time is after this dungeon.",
  "Nothing is soulbound except the hours.",
  "Buy the dip, sell the hype, hold the regret.",
  "Every mega-drop happens to somebody else, until it doesn't.",
  "Skill issue is a diagnosis, not an insult.",
  "The auction house giveth, and the auction house taketh away.",
];

/** The `GuildSetting` key a guild's own quote list lives under. */
export const QUOTES_SETTING_KEY = "fun.quotes";

/** Bounds on a guild's stored quote list, applied on read, not on write. */
const MAX_QUOTES = 100;
const MAX_QUOTE_LENGTH = 200;

/**
 * The joke ranks `!rank` hands out. Ordered from worst to best purely so the
 * percentage that comes with it reads consistently.
 */
const VIBE_RANKS: readonly string[] = [
  "Certified Menace",
  "Bulk Ore Enjoyer",
  "Professional Lobby Idler",
  "Chronic Alt-Tabber",
  "Mid-Tier Grinder",
  "Reliable Party Filler",
  "Dungeon Enthusiast",
  "Quietly Cracked",
  "Absolute Unit",
  "Guild Legend",
];

const RPS_THROWS = ["rock", "paper", "scissors"] as const;
type RpsThrow = (typeof RPS_THROWS)[number];

/** What people actually type. `r`/`p`/`s` are the whole point of a chat game. */
const RPS_ALIASES: Readonly<Record<string, RpsThrow>> = {
  r: "rock",
  rock: "rock",
  p: "paper",
  paper: "paper",
  s: "scissors",
  scissors: "scissors",
  sc: "scissors",
};

/** Minecraft usernames, which is all `!cringe` will address. */
const IGN = /^[A-Za-z0-9_]{1,16}$/;

const DEFAULT_ROLL_SIDES = 100;
const MAX_DICE = 20;
const MAX_SIDES = 1000;
/** Beyond this many dice the individual rolls stop being readable on one line. */
const SHOW_EACH_DIE_UPTO = 8;

/** Pick one, with an injected source so a test can assert on the outcome. */
function pick<T>(items: readonly T[], random: () => number): T {
  // `Math.random()` can return values arbitrarily close to 1; the clamp is what
  // stops a hostile or naive injected source from indexing off the end.
  const index = Math.min(items.length - 1, Math.max(0, Math.floor(random() * items.length)));
  return items[index] as T;
}

function rng(deps: { readonly random?: () => number }): () => number {
  return deps.random ?? Math.random;
}

export interface DiceSpec {
  readonly count: number;
  readonly sides: number;
}

/**
 * Read `2d6`, `d20`, `20`, or nothing at all.
 *
 * Null means the caller typed something that is not dice, which is answered
 * with a usage hint rather than with a silent default — rolling a d100 because
 * somebody typed `!roll banana` looks like the bot ignored them.
 */
export function parseDice(input: string | null): DiceSpec | null {
  const text = (input ?? "").trim().toLowerCase();
  if (text === "") return { count: 1, sides: DEFAULT_ROLL_SIDES };

  const match = /^(\d*)d(\d+)$/.exec(text) ?? /^()(\d+)$/.exec(text);
  if (!match) return null;

  const count = match[1] === "" || match[1] === undefined ? 1 : Number(match[1]);
  const sides = Number(match[2]);
  if (!Number.isInteger(count) || !Number.isInteger(sides)) return null;
  if (count < 1 || count > MAX_DICE) return null;
  if (sides < 2 || sides > MAX_SIDES) return null;
  return { count, sides };
}

export function rollDice(spec: DiceSpec, random: () => number): readonly number[] {
  const rolls: number[] = [];
  for (let i = 0; i < spec.count; i += 1) {
    rolls.push(Math.min(spec.sides, Math.floor(random() * spec.sides) + 1));
  }
  return rolls;
}

/** Rock-paper-scissors from the bot's side: what a throw does to another. */
export function rpsOutcome(mine: RpsThrow, theirs: RpsThrow): "WIN" | "LOSE" | "DRAW" {
  if (mine === theirs) return "DRAW";
  const beats: Record<RpsThrow, RpsThrow> = { rock: "scissors", paper: "rock", scissors: "paper" };
  return beats[mine] === theirs ? "WIN" : "LOSE";
}

/**
 * A member's vibe rank — stable for as long as they keep the same account.
 *
 * Deliberately not random per call. A joke rank that rerolls every time is a
 * random number generator; one that sticks is something people compare, argue
 * about and quote back at each other, which is the entire point.
 */
export function vibeRank(subject: string): { readonly title: string; readonly score: number } {
  // FNV-1a. Small, stable across processes, and — unlike anything built on
  // string hashing in the standard library — the same next month.
  let hash = 0x811c9dc5;
  for (let i = 0; i < subject.length; i += 1) {
    hash ^= subject.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const score = hash % 101;
  const title = VIBE_RANKS[Math.min(VIBE_RANKS.length - 1, Math.floor((score / 101) * VIBE_RANKS.length))] as string;
  return { title, score };
}

/**
 * A guild's own quotes, if it has any and they are usable.
 *
 * Bounds are applied here rather than trusted from the store, because the
 * setting is hand-editable JSON that no command validates on the way in. An
 * unreadable value falls back to the built-ins, in keeping with how every other
 * `GuildSetting` reader treats a mangled row.
 */
export function readQuotes(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return DEFAULT_QUOTES;
  const usable = raw
    .filter((q): q is string => typeof q === "string")
    .map((q) => q.trim())
    .filter((q) => q.length > 0 && q.length <= MAX_QUOTE_LENGTH)
    .slice(0, MAX_QUOTES);
  return usable.length > 0 ? usable : DEFAULT_QUOTES;
}

export const eightBall: CommandHandler = async (ctx, deps) => {
  // The question is required so the command reads as an answer to something,
  // but it is never repeated: see the module note on echoing.
  const question = ctx.args.getString("question");
  if (question === null) return { ephemeral: true, text: "Ask it something." };
  return { ephemeral: false, text: `🎱 ${pick(EIGHT_BALL_ANSWERS, rng(deps))}` };
};

export const roll: CommandHandler = async (ctx, deps) => {
  const spec = parseDice(ctx.args.getString("dice"));
  if (spec === null) {
    return { ephemeral: true, text: `Roll what? Try \`100\`, \`d20\` or \`2d6\` (up to ${MAX_DICE}d${MAX_SIDES}).` };
  }
  const rolls = rollDice(spec, rng(deps));
  const total = rolls.reduce((sum, r) => sum + r, 0);
  const detail = spec.count > 1 && spec.count <= SHOW_EACH_DIE_UPTO ? ` (${rolls.join(" + ")})` : "";
  const shape = spec.count === 1 ? `d${spec.sides}` : `${spec.count}d${spec.sides}`;
  return { ephemeral: false, text: `🎲 ${shape}: **${total}**${detail}` };
};

export const coinflip: CommandHandler = async (_ctx, deps) => {
  const side = rng(deps)() < 0.5 ? "Heads" : "Tails";
  return { ephemeral: false, text: `🪙 ${side}.` };
};

export const rps: CommandHandler = async (ctx, deps) => {
  const raw = (ctx.args.getString("throw") ?? "").trim().toLowerCase();
  const theirs = RPS_ALIASES[raw];
  if (theirs === undefined) return { ephemeral: true, text: "Throw rock, paper or scissors." };

  const mine = pick(RPS_THROWS, rng(deps));
  const outcome = rpsOutcome(mine, theirs);
  const verdict = outcome === "DRAW" ? "Draw." : outcome === "WIN" ? "I win." : "You win.";
  return { ephemeral: false, text: `${theirs} vs ${mine} — ${verdict}` };
};

export const guildquote: CommandHandler = async (ctx, deps) => {
  const stored = await deps.config.getSetting<unknown>(ctx.guildId, QUOTES_SETTING_KEY).catch(() => null);
  const quotes = readQuotes(stored);
  const random = rng(deps);

  // A few attempts rather than one, so a single filtered quote does not turn
  // into "no quotes today" — and rather than a scan, so a guild whose whole
  // list trips the filter cannot make this command walk a hundred entries.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const quote = pick(quotes, random);
    if (deps.screen === undefined) return { ephemeral: false, text: `💬 ${quote}` };
    const clean = await deps.screen.isClean(ctx.guildId, quote).catch(() => false);
    if (clean) return { ephemeral: false, text: `💬 ${quote}` };
  }
  return { ephemeral: true, text: "Nothing quotable right now." };
};

export const rank: CommandHandler = async (ctx, _deps) => {
  // A name is accepted because guild chat is where this gets used and the
  // speaker may not be linked, which would leave `ctx.userId` empty and hand
  // every unlinked player the same rank.
  const named = (ctx.args.getString("player") ?? "").trim();
  if (named !== "" && !IGN.test(named)) {
    return { ephemeral: true, text: "Rank whom? Give a Minecraft name, or nobody for your own." };
  }
  const subject = named === "" ? ctx.userId : named.toLowerCase();
  if (subject === "") return { ephemeral: true, text: "Link your account or name someone." };

  const { title, score } = vibeRank(subject);
  const who = named === "" ? "Your vibe rank" : `${named}'s vibe rank`;
  // Worded so nobody mistakes it for their guild rank, which is a real thing
  // with real permissions attached to it.
  return { ephemeral: false, text: `${who}: **${title}** (${score}/100). Not a real rank.` };
};

export const cringe: CommandHandler = async (ctx, deps) => {
  if (deps.tallies === undefined) return { ephemeral: true, text: "Nothing is keeping score here." };

  const target = (ctx.args.getString("player") ?? "").trim();
  if (!IGN.test(target)) return { ephemeral: true, text: "Cringe at whom? Give a Minecraft name." };

  const total = await deps.tallies.bump(ctx.guildId, "cringe", target.toLowerCase()).catch(() => null);
  if (total === null) return { ephemeral: true, text: "The counter isn't answering." };
  return { ephemeral: false, text: `😬 ${target} — ${total} cringe${total === 1 ? "" : "s"} on record.` };
};

/**
 * The specs, all in-game and none of them `"linked"`.
 *
 * `true` rather than `"linked"` because nothing here writes anything a person
 * gets attributed for — the one counter that persists is keyed by the name that
 * was typed, not by who typed it. Cooldowns are longer than the lookups': a
 * lookup answers a question once, and these are the commands somebody will
 * happily run twenty times in a row to see a different number.
 */
export function funSpecs(): readonly CommandSpec[] {
  return [
    {
      name: "8ball",
      category: "EXTRAS",
      description: "Ask the magic 8-ball",
      options: [{ name: "question", description: "What you want to know", type: "string", required: true }],
      cooldownMs: 8_000,
      inGame: true,
      handler: eightBall,
    },
    {
      name: "roll",
      category: "EXTRAS",
      description: "Roll dice — 100, d20, 2d6",
      options: [{ name: "dice", description: "What to roll (default 100)", type: "string" }],
      cooldownMs: 5_000,
      inGame: true,
      handler: roll,
    },
    {
      name: "coinflip",
      category: "EXTRAS",
      description: "Flip a coin",
      cooldownMs: 5_000,
      inGame: true,
      handler: coinflip,
    },
    {
      name: "rps",
      category: "EXTRAS",
      description: "Rock, paper, scissors",
      options: [
        {
          name: "throw",
          description: "Your throw",
          type: "string",
          required: true,
          choices: [
            { name: "Rock", value: "rock" },
            { name: "Paper", value: "paper" },
            { name: "Scissors", value: "scissors" },
          ],
        },
      ],
      cooldownMs: 5_000,
      inGame: true,
      handler: rps,
    },
    {
      name: "guildquote",
      category: "EXTRAS",
      description: "A quote from the guild's collection",
      cooldownMs: 15_000,
      inGame: true,
      // Retired: the collection is a static list nobody has added to, so the
      // command is a slash entry that returns one of the same few lines
      // forever. It cost a registry slot and taught members nothing.
      enabled: false,
      handler: guildquote,
    },
    {
      name: "rank",
      category: "EXTRAS",
      description: "Your entirely unofficial vibe rank",
      options: [{ name: "player", description: "Whose rank (default yours)", type: "string" }],
      cooldownMs: 10_000,
      inGame: true,
      // Retired. It printed a made-up score next to the word “rank”, in a guild
      // where rank is a real thing with real permissions attached to it, and the
      // disclaimer at the end of the line is not where anybody stops reading.
      // Withdrawn rather than deleted: the joke is fine, the word was the
      // problem, and turning it back on under a different name is one line.
      enabled: false,
      handler: rank,
    },
    {
      name: "cringe",
      category: "EXTRAS",
      description: "Add one to somebody's cringe tally",
      options: [{ name: "player", description: "Minecraft username", type: "string", required: true }],
      cooldownMs: 15_000,
      // Retired. It is the one command here that is about a named person rather
      // than about a throw or a dice roll, and a public counter of how cringe
      // somebody is has no version that ages well in a guild that later has to
      // moderate itself. A guild that wants a running joke on a message now has
      // a trigger for it, aimed at a message somebody chose to post rather than
      // at a name anybody can type. The spec stays so the handler stays compiled
      // and tested; this flag is what deregisters it from Discord and from the
      // in-game router.
      enabled: false,
      inGame: true,
      handler: cringe,
    },
  ];
}
