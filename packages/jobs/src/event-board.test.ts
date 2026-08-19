/**
 * What the pass promises: it asks for boards that are actually stale, it counts
 * only what landed, and one guild's broken board does not cost every other
 * guild theirs.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publishEventBoards, BOARD_REFRESH_MS, type BoardableEvent, type EventBoardJobDeps } from "./event-board.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");

function harness(
  options: {
    events?: readonly BoardableEvent[];
    published?: Readonly<Record<string, boolean>>;
    throwOn?: readonly string[];
    failList?: boolean;
  } = {},
) {
  const asked: Date[] = [];
  const attempted: string[] = [];
  const errors: string[] = [];

  const deps: EventBoardJobDeps = {
    async listDue(staleBefore) {
      if (options.failList) throw new Error("database down");
      asked.push(staleBefore);
      return options.events ?? [{ id: "e1", guildId: "g1" }];
    },
    async publish(event) {
      attempted.push(event.id);
      if ((options.throwOn ?? []).includes(event.id)) throw new Error("bridge exploded");
      return options.published?.[event.id] ?? true;
    },
    onError(scope) {
      errors.push(scope);
    },
    now: () => NOW,
  };

  return { deps, asked, attempted, errors };
}

describe("publishEventBoards", () => {
  it("asks for boards older than the refresh window", async () => {
    const h = harness();

    assert.equal(await publishEventBoards(h.deps), 1);
    assert.deepEqual(h.asked, [new Date(NOW.getTime() - BOARD_REFRESH_MS)]);
  });

  it("counts only the boards that actually landed", async () => {
    const h = harness({
      events: [
        { id: "e1", guildId: "g1" },
        { id: "e2", guildId: "g2" },
      ],
      published: { e2: false },
    });

    assert.equal(await publishEventBoards(h.deps), 1);
    assert.deepEqual(h.attempted, ["e1", "e2"]);
    assert.deepEqual(h.errors, []);
  });

  it("keeps going when one board throws", async () => {
    const h = harness({
      events: [
        { id: "e1", guildId: "g1" },
        { id: "e2", guildId: "g2" },
      ],
      throwOn: ["e1"],
    });

    assert.equal(await publishEventBoards(h.deps), 1);
    assert.deepEqual(h.errors, ["board e1"]);
  });

  it("gives up quietly when the work list itself fails", async () => {
    const h = harness({ failList: true });

    assert.equal(await publishEventBoards(h.deps), 0);
    assert.deepEqual(h.errors, ["board list"]);
    assert.deepEqual(h.attempted, []);
  });

  it("does nothing when no board is due", async () => {
    const h = harness({ events: [] });

    assert.equal(await publishEventBoards(h.deps), 0);
  });
});
