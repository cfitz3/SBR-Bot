/**
 * The staff side of the queue. The assertions worth having here are all about
 * disagreement between what the platform records and what the guild actually
 * did: a command that was never sent must never leave an ACCEPTED row behind,
 * and a name that could not become a safe command must never be sent at all.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "@sbr/observability";
import { JoinQueueService } from "./queue.js";
import { ScreeningService } from "./service.js";
import type { ScreeningRecord, ScreeningRepository } from "./ports.js";
import { NO_HISTORY, UNREADABLE_STATS, type ScreeningOutcome } from "./types.js";

const silent: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
  child() { return silent; },
};

const UUID = "747cf094-48c2-4405-9b5a-67c53f509c6e";

function row(over: Partial<ScreeningRecord> = {}): ScreeningRecord {
  return {
    id: "row-1",
    guildId: "g1",
    outcome: "PENDING",
    decidedAt: null,
    decidedBy: null,
    uuid: UUID,
    ign: "Jack",
    discordId: null,
    requestedAt: new Date("2026-08-09T12:00:00.000Z"),
    verdict: "REVIEW",
    riskScore: 30,
    reasons: [],
    scammer: { status: "CLEAR" },
    stats: UNREADABLE_STATS,
    history: NO_HISTORY,
    error: null,
    ...over,
  };
}

function harness(opts: { send?: boolean; pending?: ScreeningRecord | null; resolves?: boolean } = {}) {
  const decisions: [string, ScreeningOutcome, string][] = [];
  const sent: string[] = [];
  const repo: ScreeningRepository = {
    async record() { return "row-1"; },
    async decide(id, outcome, by) { decisions.push([id, outcome, by]); },
    async pending() { return [row()]; },
    async forPlayer() { return []; },
    async findPending() { return opts.pending === undefined ? row() : opts.pending; },
  };
  const queue = new JoinQueueService({
    screening: new ScreeningService({ repo, logger: silent }),
    commands: { async send(_guildId, command) { sent.push(command); return opts.send !== false; } },
    players: { async resolveIgn(ign) { return opts.resolves === false ? null : { uuid: UUID, ign: ign === "jack" ? "Jack" : ign }; } },
    logger: silent,
  });
  return { queue, decisions, sent };
}

test("accepting sends one command and marks the pending row", async () => {
  const { queue, decisions, sent } = harness();
  const out = await queue.accept("g1", "jack", "staff-1");
  assert.equal(out.ok, true);
  assert.deepEqual(sent, ["/guild accept Jack"]);
  assert.deepEqual(decisions, [["row-1", "ACCEPTED", "staff-1"]]);
  assert.equal(out.ok && out.recorded, true);
  // Mojang's casing, not the staffer's typing, so the command matches the game.
  assert.equal(out.ok && out.ign, "Jack");
});

test("denying records DENIED, not ACCEPTED", async () => {
  const { queue, decisions, sent } = harness();
  const out = await queue.deny("g1", "Jack", "staff-1");
  assert.equal(out.ok, true);
  assert.deepEqual(sent, ["/guild deny Jack"]);
  assert.deepEqual(decisions, [["row-1", "DENIED", "staff-1"]]);
});

test("an invite decides nothing: the player never asked", async () => {
  const { queue, decisions, sent } = harness();
  const out = await queue.invite("g1", "Jack", "staff-1");
  assert.equal(out.ok, true);
  assert.deepEqual(sent, ["/guild invite Jack"]);
  assert.deepEqual(decisions, []);
  assert.equal(out.ok && out.recorded, false);
});

test("a command the bridge could not take records nothing", async () => {
  // The failure mode this guards: telling staff somebody was admitted while the
  // bridge was offline, leaving the applicant waiting and the history lying.
  const { queue, decisions } = harness({ send: false });
  const out = await queue.accept("g1", "Jack", "staff-1");
  assert.deepEqual(out, { ok: false, reason: "NOT_SENT" });
  assert.deepEqual(decisions, []);
});

test("anything that is not a Minecraft name is refused before it is sent", async () => {
  const { queue, sent } = harness();
  for (const bad of ["Jack Smith", "Jack\n/guild kick Alex", "", "ThisNameIsFarTooLongToBeReal", "Jack;ls", "§aJack"]) {
    const out = await queue.accept("g1", bad, "staff-1");
    assert.deepEqual(out, { ok: false, reason: "BAD_NAME" }, bad);
  }
  assert.deepEqual(sent, []);
});

test("an unresolvable name is still actioned, but reported as unrecorded", async () => {
  // Mojang being down must not stop staff acting on somebody they can see in
  // the request notice.
  const { queue, decisions, sent } = harness({ resolves: false });
  const out = await queue.accept("g1", "Jack", "staff-1");
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.recorded, false);
  assert.deepEqual(sent, ["/guild accept Jack"]);
  assert.deepEqual(decisions, []);
});

test("no pending row is a normal outcome, not a failure", async () => {
  const { queue, decisions, sent } = harness({ pending: null });
  const out = await queue.accept("g1", "Jack", "staff-1");
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.recorded, false);
  assert.deepEqual(sent, ["/guild accept Jack"]);
  assert.deepEqual(decisions, []);
});

test("the queue reads through to the repository", async () => {
  const { queue } = harness();
  const rows = await queue.pending("g1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.ign, "Jack");
});
