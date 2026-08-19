/**
 * The ticket sweep's orchestration — not its decision, which is `sweep()` in
 * `@sbr/tickets` and tested there. What is asserted here is the bookkeeping:
 * that a warning is remembered, that a close forgets it, and that one broken
 * guild or ticket does not cost the rest of the pass.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { sweepTickets, type SweepableTicket, type TicketSweepAction } from "./tickets.js";

interface HarnessOptions {
  readonly guilds?: readonly string[];
  readonly tickets?: Readonly<Record<string, readonly SweepableTicket[]>>;
  readonly warned?: readonly string[];
  readonly actions?: Readonly<Record<string, TicketSweepAction | null>>;
  readonly failGuilds?: readonly string[];
  readonly failTickets?: readonly string[];
  readonly failGuildList?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const warned = new Set(options.warned ?? []);
  const swept: Array<{ id: string; staleWarned: boolean }> = [];
  const errors: string[] = [];

  const deps = {
    async listGuilds(): Promise<readonly string[]> {
      if (options.failGuildList) throw new Error("database down");
      return options.guilds ?? ["g1"];
    },
    async listSweepable(guildId: string): Promise<readonly SweepableTicket[]> {
      if ((options.failGuilds ?? []).includes(guildId)) throw new Error("query failed");
      return options.tickets?.[guildId] ?? [];
    },
    async wasWarned(ticketId: string): Promise<boolean> {
      return warned.has(ticketId);
    },
    async rememberWarned(ticketId: string): Promise<void> {
      warned.add(ticketId);
    },
    async forgetWarned(ticketId: string): Promise<void> {
      warned.delete(ticketId);
    },
    async sweepOne(ticket: SweepableTicket, staleWarned: boolean): Promise<TicketSweepAction | null> {
      if ((options.failTickets ?? []).includes(ticket.id)) throw new Error("bridge exploded");
      swept.push({ id: ticket.id, staleWarned });
      return options.actions?.[ticket.id] ?? "NONE";
    },
    onError(scope: string) {
      errors.push(scope);
    },
  };

  return { deps, warned, swept, errors };
}

const ticket = (id: string, guildId = "g1"): SweepableTicket => ({ id, guildId });

describe("sweepTickets", () => {
  it("counts only the tickets it acted on", async () => {
    const h = harness({
      tickets: { g1: [ticket("t1"), ticket("t2"), ticket("t3")] },
      actions: { t1: "WARN_STALE", t2: "AUTO_CLOSE", t3: "NONE" },
    });

    assert.equal(await sweepTickets(h.deps), 2);
    assert.deepEqual(
      h.swept.map((s) => s.id),
      ["t1", "t2", "t3"],
    );
  });

  it("remembers a warning so the next pass does not repeat it", async () => {
    const h = harness({ tickets: { g1: [ticket("t1")] }, actions: { t1: "WARN_STALE" } });

    await sweepTickets(h.deps);
    assert.equal(h.swept[0]?.staleWarned, false);

    await sweepTickets(h.deps);
    assert.equal(h.swept[1]?.staleWarned, true);
  });

  it("forgets the flag once the ticket closes itself", async () => {
    const h = harness({ tickets: { g1: [ticket("t1")] }, warned: ["t1"], actions: { t1: "AUTO_CLOSE" } });

    await sweepTickets(h.deps);
    assert.equal(h.warned.has("t1"), false);
  });

  it("leaves the flag alone on NONE, so the TTL decides when to re-arm", async () => {
    const h = harness({ tickets: { g1: [ticket("t1")] }, warned: ["t1"], actions: { t1: "NONE" } });

    assert.equal(await sweepTickets(h.deps), 0);
    assert.equal(h.warned.has("t1"), true);
  });

  it("records nothing when the bridge could not answer", async () => {
    const h = harness({ tickets: { g1: [ticket("t1")] }, actions: { t1: null } });

    assert.equal(await sweepTickets(h.deps), 0);
    assert.equal(h.warned.has("t1"), false);
  });

  it("walks every guild", async () => {
    const h = harness({
      guilds: ["g1", "g2"],
      tickets: { g1: [ticket("t1")], g2: [ticket("t2", "g2")] },
      actions: { t1: "WARN_STALE", t2: "WARN_STALE" },
    });

    assert.equal(await sweepTickets(h.deps), 2);
  });

  it("keeps going when one guild's read fails", async () => {
    const h = harness({
      guilds: ["g1", "g2"],
      tickets: { g2: [ticket("t2", "g2")] },
      actions: { t2: "AUTO_CLOSE" },
      failGuilds: ["g1"],
    });

    assert.equal(await sweepTickets(h.deps), 1);
    assert.deepEqual(h.errors, ["guild g1"]);
  });

  it("keeps going when one ticket throws", async () => {
    const h = harness({
      tickets: { g1: [ticket("t1"), ticket("t2")] },
      actions: { t2: "WARN_STALE" },
      failTickets: ["t1"],
    });

    assert.equal(await sweepTickets(h.deps), 1);
    assert.deepEqual(h.errors, ["ticket t1"]);
  });

  it("gives up quietly when the guild list itself fails", async () => {
    const h = harness({ failGuildList: true });

    assert.equal(await sweepTickets(h.deps), 0);
    assert.deepEqual(h.errors, ["guild list"]);
    assert.equal(h.swept.length, 0);
  });
});
