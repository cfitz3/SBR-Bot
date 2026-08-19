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

function harness(
  opts: {
    send?: boolean;
    pending?: ScreeningRecord | null;
    resolves?: boolean;
    /** The newest request on record, whatever became of it — what `admit` reads. */
    latest?: ScreeningRecord | null;
    now?: Date;
  } = {},
) {
  const decisions: [string, ScreeningOutcome, string][] = [];
  const sent: string[] = [];
  const repo: ScreeningRepository = {
    async record() { return "row-1"; },
    async decide(id, outcome, by) { decisions.push([id, outcome, by]); },
    async pending() { return [row()]; },
    async forPlayer() { return []; },
    async findPending() { return opts.pending === undefined ? row() : opts.pending; },
    async findLatestByIgn() { return opts.latest ?? null; },
    async expireStale() { return 0; },
  };
  const queue = new JoinQueueService({
    screening: new ScreeningService({ repo, logger: silent }),
    commands: { async send(_guildId, command) { sent.push(command); return opts.send !== false; } },
    players: { async resolveIgn(ign) { return opts.resolves === false ? null : { uuid: UUID, ign: ign === "jack" ? "Jack" : ign }; } },
    logger: silent,
    ...(opts.now ? { now: () => opts.now as Date } : {}),
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

/**
 * Admission on the clock.
 *
 * `REQUESTED_AT` is the row's stamp; the two `now`s below sit either side of
 * the five-minute window so the branch is chosen by arithmetic rather than by
 * how long the test happened to take.
 */
const REQUESTED_AT = new Date("2026-08-09T12:00:00.000Z");
const INSIDE = new Date("2026-08-09T12:01:00.000Z");
const OUTSIDE = new Date("2026-08-09T12:06:00.000Z");

test("a request still inside its window is accepted", async () => {
  const { queue, decisions, sent } = harness({
    latest: row({ requestedAt: REQUESTED_AT }),
    now: INSIDE,
  });
  const out = await queue.admit("g1", "jack", "staff-1");
  assert.equal(out.ok && out.via, "ACCEPT");
  assert.deepEqual(sent, ["/guild accept Jack"]);
  assert.deepEqual(decisions, [["row-1", "ACCEPTED", "staff-1"]]);
  // Four minutes of the five are left; staff are told, because a number close
  // to zero is the cue to stop typing and press the button.
  assert.equal(out.ok && out.remainingMs, 4 * 60_000);
});

test("a request past its window becomes an invite, and the row is retired", async () => {
  // The case the whole change exists for: `/guild accept` past five minutes is
  // an error upstream, not a slow success, so admitting has to switch route —
  // and say so, because an invite needs the applicant to act.
  const { queue, decisions, sent } = harness({
    latest: row({ requestedAt: REQUESTED_AT }),
    now: OUTSIDE,
  });
  const out = await queue.admit("g1", "jack", "staff-1");
  assert.equal(out.ok && out.via, "INVITE");
  assert.deepEqual(sent, ["/guild invite Jack"]);
  assert.deepEqual(decisions, [["row-1", "EXPIRED", "staff-1"]]);
  assert.equal(out.ok && out.remainingMs, 0);
});

test("a row the sweep already retired still routes to an invite", async () => {
  // `pending()` expires stale rows, so by the time staff press Accept the row
  // is usually EXPIRED rather than an overdue PENDING. Reading only PENDING
  // here would send an accept Hypixel has nothing to match it to.
  const { queue, decisions, sent } = harness({
    latest: row({ requestedAt: REQUESTED_AT, outcome: "EXPIRED", decidedAt: OUTSIDE, decidedBy: "AUTO" }),
    now: OUTSIDE,
  });
  const out = await queue.admit("g1", "jack", "staff-1");
  assert.equal(out.ok && out.via, "INVITE");
  assert.deepEqual(sent, ["/guild invite Jack"]);
  // Already retired — deciding it a second time would rewrite who retired it.
  assert.deepEqual(decisions, []);
});

test("no request on record is accepted, not invited", async () => {
  // The likely explanation is a request we never witnessed. A refused accept
  // costs one line in chat; inviting somebody who is in fact at the door is
  // refused *and* leaves their live request ticking down unanswered.
  const { queue, sent } = harness({ latest: null, now: INSIDE });
  const out = await queue.admit("g1", "jack", "staff-1");
  assert.equal(out.ok && out.via, "ACCEPT");
  assert.deepEqual(sent, ["/guild accept Jack"]);
});

test("roster commands carry their argument, and nothing else", async () => {
  const { queue, sent } = harness();
  await queue.kick("g1", "jack", "staff-1", "inactive 30 days");
  await queue.mute("g1", "jack", "staff-1", "30m");
  await queue.unmute("g1", "jack", "staff-1");
  await queue.promote("g1", "jack", "staff-1");
  await queue.demote("g1", "jack", "staff-1");
  assert.deepEqual(sent, [
    "/guild kick Jack inactive 30 days",
    "/guild mute Jack 30m",
    "/guild unmute Jack",
    "/guild promote Jack",
    "/guild demote Jack",
  ]);
});

test("a roster command never decides a screening row", async () => {
  // Kicking somebody is a statement about a member, not about their months-old
  // application. Marking that row DENIED would corrupt the only record of what
  // the guild knew when it let them in.
  const { queue, decisions } = harness();
  await queue.kick("g1", "jack", "staff-1");
  await queue.promote("g1", "jack", "staff-1");
  assert.deepEqual(decisions, []);
});

test("a free-text argument that could become a second command is refused", async () => {
  const { queue, sent } = harness();
  for (const bad of ["30 minutes", "0m", "1y", "", "30m; /guild kick Alex"]) {
    assert.deepEqual(await queue.mute("g1", "Jack", "staff-1", bad), { ok: false, reason: "BAD_DURATION" }, bad);
  }
  for (const bad of ["inactive\n/guild kick Alex", "see /help", "§cbye", "x".repeat(65)]) {
    assert.deepEqual(await queue.kick("g1", "Jack", "staff-1", bad), { ok: false, reason: "BAD_REASON" }, bad);
  }
  assert.deepEqual(sent, []);
});

test("an omitted kick reason is allowed and sends a bare command", async () => {
  const { queue, sent } = harness();
  const out = await queue.kick("g1", "Jack", "staff-1");
  assert.equal(out.ok, true);
  assert.deepEqual(sent, ["/guild kick Jack"]);
});
