/**
 * `/snapshot`'s contract: it saves the caller's own current reading, it says
 * something useful in each of the three ways that can fail, and it never names
 * another player.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { copy } from "@sbr/brand";
import { ok, err, recordArgs } from "@sbr/shared-types";
import type { CommandArgs, SavedSnapshotDTO, SaveSnapshotError } from "@sbr/shared-types";
import { snapshotSpecs } from "./handlers-snapshot.js";
import type { CommandContext, HandlerDeps } from "./types.js";

const C = copy.embed.card;

interface Store {
  readonly calls: { uuid: string; savedBy: string; label: string | null }[];
  linked: boolean;
  error: SaveSnapshotError | null;
  saved: SavedSnapshotDTO;
}

function store(over: Partial<Store> = {}): Store {
  return {
    calls: [],
    linked: true,
    error: null,
    saved: { capturedAt: "2026-08-21T10:00:00.000Z", label: null, savedCount: 3, limit: 24 },
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
      async saveSnapshot(uuid: string, savedBy: string, label: string | null) {
        s.calls.push({ uuid, savedBy, label });
        return s.error === null ? ok(s.saved) : err(s.error);
      },
    },
  } as unknown as HandlerDeps;
}

function run(args: CommandArgs, s: Store) {
  const spec = snapshotSpecs()[0];
  assert.ok(spec);
  const ctx: CommandContext = {
    guildId: "guild-1",
    userId: "111",
    channelId: "chan-1",
    surface: "BRIDGE_BOT",
    args,
  };
  return spec.handler(ctx, deps(s));
}

test("a save pins the caller's own reading and reports the count against the cap", async () => {
  const s = store();
  const reply = await run(recordArgs({}), s);

  assert.deepEqual(s.calls, [{ uuid: "uuid-1", savedBy: "111", label: null }]);
  assert.match(reply.text, /3 of 24/);
  // Public: the receipt is small guild chatter, not a private confirmation.
  assert.equal(reply.ephemeral, false);
});

test("a label is passed through and read back", async () => {
  const s = store({ saved: { capturedAt: "t", label: "before dungeon grind", savedCount: 1, limit: 24 } });
  const reply = await run(recordArgs({ label: "before dungeon grind" }), s);

  assert.equal(s.calls[0]?.label, "before dungeon grind");
  assert.match(reply.text, /before dungeon grind/);
});

test("saving the same reading twice is refused with the reason, not an error", async () => {
  // The distinction that matters: this is not a failure the member should
  // retry, it is a wait. The copy has to say which.
  const s = store({ error: { kind: "ALREADY_SAVED", capturedAt: "t" } });
  const reply = await run(recordArgs({}), s);

  assert.equal(reply.text, C.snapshotUnchanged);
  assert.equal(reply.ephemeral, true);
});

test("an account nothing has read yet is told so rather than shown an empty save", async () => {
  const s = store({ error: { kind: "NO_READING" } });
  assert.equal((await run(recordArgs({}), s)).text, C.snapshotNoReading);
});

test("an unwired store says snapshots are off rather than failing silently", async () => {
  const s = store({ error: { kind: "UNAVAILABLE" } });
  assert.equal((await run(recordArgs({}), s)).text, C.snapshotUnavailable);
});

test("an unlinked caller is turned away before anything is written", async () => {
  const s = store({ linked: false });
  await run(recordArgs({}), s);
  assert.deepEqual(s.calls, []);
});

test("the command cannot be pointed at another player", () => {
  const spec = snapshotSpecs()[0];
  assert.ok(spec);
  // Self-only by construction: no `player` option means no argument to abuse,
  // and the uuid comes from the caller's own link.
  assert.deepEqual((spec.options ?? []).map((o) => o.name), ["label"]);
  assert.equal(spec.inGame, "linked");
});
