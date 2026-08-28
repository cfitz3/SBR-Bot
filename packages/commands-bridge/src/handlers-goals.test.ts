/**
 * `/goal`'s contract: read the caller's own targets, refuse a target that isn't
 * a number, say where they already are when they aim below it, and never touch
 * anybody else's goals.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { copy } from "@sbr/brand";
import { ok, err, recordArgs } from "@sbr/shared-types";
import type { CommandArgs, GoalDTO, ProgressMetric } from "@sbr/shared-types";
import { goalSpecs, parseTarget } from "./handlers-goals.js";
import type { CommandContext, HandlerDeps } from "./types.js";

const GUILD = "guild-1";
const CALLER = "111";

interface Store {
  readonly set: { metric: ProgressMetric; target: number }[];
  readonly cleared: ProgressMetric[];
  goals: GoalDTO[];
  linked: boolean;
  clearOk: boolean;
  setError: "UNAVAILABLE" | "BAD_TARGET" | "ALREADY_THERE" | null;
}

function store(over: Partial<Store> = {}): Store {
  return {
    set: [],
    cleared: [],
    goals: [],
    linked: true,
    clearOk: true,
    setError: null,
    ...over,
  };
}

function goal(over: Partial<GoalDTO> = {}): GoalDTO {
  return {
    id: "g1",
    metric: "skyblockLevel",
    target: 250,
    startValue: 200,
    current: 210,
    progress: 0.2,
    perDay: 0.5,
    etaDays: 80,
    createdAt: "2026-08-01T00:00:00.000Z",
    achievedAt: null,
    ...over,
  };
}

function deps(s: Store): HandlerDeps {
  return {
    identity: {
      async resolveByDiscordId() {
        return ok(s.linked ? { ign: "Refraction", minecraftUuid: "uuid-1" } : null);
      },
    },
    progression: {
      async setGoal(_g: string, _u: string, metric: ProgressMetric, target: number) {
        if (s.setError === "ALREADY_THERE") return err({ kind: "ALREADY_THERE", current: 260 });
        if (s.setError !== null) return err({ kind: s.setError });
        s.set.push({ metric, target });
        return ok(goal({ metric, target }));
      },
      async listGoals() {
        return ok(s.goals);
      },
      async clearGoal(_g: string, _u: string, metric: ProgressMetric) {
        s.cleared.push(metric);
        return ok(s.clearOk);
      },
    },
  } as unknown as HandlerDeps;
}

function run(args: CommandArgs, s: Store) {
  const spec = goalSpecs().find((x) => x.name === "goal");
  assert.ok(spec);
  const ctx: CommandContext = {
    guildId: GUILD,
    userId: CALLER,
    channelId: "chan-1",
    surface: "BRIDGE_BOT",
    args,
  };
  return spec.handler(ctx, deps(s));
}

// ── parseTarget ─────────────────────────────────────────────────────────────

test("shorthand scales, and a bare number stays bare", () => {
  assert.equal(parseTarget("2b"), 2e9);
  assert.equal(parseTarget("1.5m"), 1.5e6);
  assert.equal(parseTarget("40k"), 40_000);
  // The trap this guards: forty is forty, not forty thousand.
  assert.equal(parseTarget("40"), 40);
  assert.equal(parseTarget("45.5"), 45.5);
});

test("separators and case are tolerated, nonsense is not", () => {
  assert.equal(parseTarget(" 1,250,000 "), 1_250_000);
  assert.equal(parseTarget("2B"), 2e9);
  assert.equal(parseTarget("2_000"), 2000);
  assert.equal(parseTarget("soon"), null);
  assert.equal(parseTarget("2t"), null);
  assert.equal(parseTarget("-5"), null);
  assert.equal(parseTarget("0"), null);
  assert.equal(parseTarget(""), null);
});

// ── the handler ─────────────────────────────────────────────────────────────

test("an unlinked caller is told to link, not shown an empty board", async () => {
  const s = store({ linked: false });
  const reply = await run(recordArgs({}), s);
  assert.equal(reply.ephemeral, true);
  assert.match(reply.text, /link/i);
});

test("no action lists, and an empty list says so", async () => {
  const s = store();
  const reply = await run(recordArgs({}), s);
  assert.equal(reply.ephemeral, false);
  assert.equal(reply.embed?.description, copy.embed.card.noGoals);
});

test("a set stores the parsed target and shows the goal back", async () => {
  const s = store();
  const reply = await run(recordArgs({ action: "set", metric: "networth", target: "2b" }), s);
  assert.deepEqual(s.set, [{ metric: "networth", target: 2e9 }]);
  assert.equal(reply.embed?.fields?.length, 1);
});

test("a set with no metric asks for one instead of guessing", async () => {
  const s = store();
  const reply = await run(recordArgs({ action: "set", target: "2b" }), s);
  assert.equal(s.set.length, 0);
  assert.match(reply.text, /networth/);
});

test("an unreadable target is refused with the brand's wording", async () => {
  const s = store();
  const reply = await run(recordArgs({ action: "set", metric: "networth", target: "lots" }), s);
  assert.equal(s.set.length, 0);
  assert.equal(reply.text, copy.error.goal.BAD_TARGET);
});

test("aiming below where they already are reports the current number", async () => {
  const s = store({ setError: "ALREADY_THERE" });
  const reply = await run(recordArgs({ action: "set", metric: "skyblockLevel", target: "100" }), s);
  assert.match(reply.text, /260/);
});

test("an unwired store says goals are off rather than failing silently", async () => {
  const s = store({ setError: "UNAVAILABLE" });
  const reply = await run(recordArgs({ action: "set", metric: "skyblockLevel", target: "300" }), s);
  assert.equal(reply.text, copy.error.goal.UNAVAILABLE);
});

test("clear reports the difference between clearing one and having none", async () => {
  const s = store();
  const had = await run(recordArgs({ action: "clear", metric: "networth" }), s);
  assert.equal(had.text, copy.embed.card.goalCleared.replace("{metric}", "networth"));

  const none = store({ clearOk: false });
  const nothing = await run(recordArgs({ action: "clear", metric: "networth" }), none);
  assert.equal(nothing.text, copy.embed.card.goalNotSet.replace("{metric}", "networth"));
});

test("a failed read degrades to an empty board rather than an error", async () => {
  const s = store();
  const broken = deps(s);
  (broken as unknown as { progression: { listGoals: () => Promise<never> } }).progression.listGoals =
    () => Promise.reject(new Error("db down"));
  const spec = goalSpecs()[0];
  assert.ok(spec);
  const reply = await spec.handler(
    { guildId: GUILD, userId: CALLER, channelId: "c", surface: "BRIDGE_BOT", args: recordArgs({}) },
    broken,
  );
  assert.equal(reply.embed?.description, copy.embed.card.noGoals);
});

test("the listed goal renders its bar, its numbers and its projection", async () => {
  const s = store({ goals: [goal()] });
  const reply = await run(recordArgs({ action: "list" }), s);
  const line = reply.embed?.fields?.[0]?.value ?? "";
  // One bar across the whole platform — the glyphs come from the theme.
  assert.match(line, /▰|▱/);
  assert.match(line, /210/);
  assert.match(line, /250/);
  assert.match(line, /~80d/);
});
