import assert from "node:assert/strict";
import { test } from "node:test";
import { noArgs, recordArgs } from "@sbr/shared-types";
import type { CommandArgs } from "@sbr/shared-types";
import { LEVEL_OPT_OUT_KEY, levelAlertSpecs, readLevelOptOuts } from "./handlers-levels.js";
import type { CommandContext, HandlerDeps } from "./types.js";

const GUILD = "guild-1";
const CALLER = "111";

interface Store {
  value: unknown;
  readonly writes: unknown[];
  ok: boolean;
}

function deps(store: Store): HandlerDeps {
  return {
    config: {
      async getSetting(_guildId: string, key: string) {
        assert.equal(key, LEVEL_OPT_OUT_KEY);
        return store.value;
      },
      async setSetting(_guildId: string, _key: string, value: unknown) {
        store.writes.push(value);
        return store.ok ? { ok: true as const, value: undefined } : { ok: false as const, error: "nope" };
      },
    },
  } as unknown as HandlerDeps;
}

function run(args: CommandArgs, store: Store) {
  const spec = levelAlertSpecs()[0];
  assert.ok(spec);
  const ctx: CommandContext = { guildId: GUILD, userId: CALLER, surface: "BRIDGE_BOT", args };
  return spec.handler(ctx, deps(store));
}

function store(value: unknown = null, ok = true): Store {
  return { value, writes: [], ok };
}

test("with no argument it reports where you stand and changes nothing", async () => {
  const s = store(["111"]);
  const reply = await run(noArgs, s);

  assert.equal(reply.ephemeral, true);
  assert.match(reply.text, /off for you/);
  assert.deepEqual(s.writes, []);
});

test("turning them off adds you to the list without disturbing anybody else", async () => {
  const s = store(["999"]);
  const reply = await run(recordArgs({ state: "off" }), s);

  assert.deepEqual(s.writes, [["999", "111"]]);
  assert.match(reply.text, /still earn XP/);
});

test("turning them back on removes only you", async () => {
  const s = store(["999", "111"]);
  await run(recordArgs({ state: "on" }), s);

  assert.deepEqual(s.writes, [["999"]]);
});

test("asking for the state you are already in writes nothing", async () => {
  const s = store([]);
  const reply = await run(recordArgs({ state: "on" }), s);

  assert.deepEqual(s.writes, []);
  assert.match(reply.text, /already on/);
});

test("a failed save is reported rather than silently claimed", async () => {
  const s = store([], false);
  const reply = await run(recordArgs({ state: "off" }), s);

  assert.match(reply.text, /save that just now/);
});

test("an unreadable setting reads as nobody opted out, not as an error", async () => {
  const config = {
    async getSetting() {
      return { not: "an array" };
    },
  };
  assert.equal((await readLevelOptOuts(config as never, GUILD)).size, 0);

  const throwing = {
    async getSetting() {
      throw new Error("db down");
    },
  };
  assert.equal((await readLevelOptOuts(throwing as never, GUILD)).size, 0);
});

test("the command is Discord-only and the state option is optional", () => {
  const spec = levelAlertSpecs()[0];
  assert.equal(spec?.inGame, undefined);
  assert.equal(spec?.options?.[0]?.required, undefined);
  assert.deepEqual(
    spec?.options?.[0]?.choices?.map((c) => c.value),
    ["on", "off"],
  );
});
