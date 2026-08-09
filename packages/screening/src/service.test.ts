/**
 * The screening service. The interesting assertions are about a bad day: a
 * scammer list that throws, a database that is down, a stats source that hangs
 * up mid-request. None of those may take the bridge with them, and none may
 * produce an accept.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "@sbr/observability";
import { ScreeningService } from "./service.js";
import type { ScreeningRecord, ScreeningRepository } from "./ports.js";
import { UNREADABLE_STATS, type ApplicantStats, type Screening } from "./types.js";

const silent: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
  child() { return silent; },
};

const NOW = new Date("2026-08-09T12:00:00.000Z");

const GOOD: ApplicantStats = {
  ...UNREADABLE_STATS,
  profileName: "Mango",
  skyblockLevel: 240,
  skillAverage: 42.5,
  catacombsLevel: 34,
  senitherWeight: 9200,
  networth: 4_500_000_000n,
  firstLoginAt: new Date("2023-01-01T00:00:00.000Z"),
  lastLoginAt: new Date("2026-08-08T00:00:00.000Z"),
  unreadable: false,
};

function repo(): ScreeningRepository & { recorded: Screening[]; decisions: [string, string, string][] } {
  const recorded: Screening[] = [];
  const decisions: [string, string, string][] = [];
  return {
    recorded,
    decisions,
    async record(_guildId, screening) {
      recorded.push(screening);
      return `row-${recorded.length}`;
    },
    async decide(id, outcome, by) {
      decisions.push([id, outcome, by]);
    },
    async pending() {
      return [] as readonly ScreeningRecord[];
    },
    async forPlayer() {
      return [] as readonly ScreeningRecord[];
    },
    async findPending() {
      return null;
    },
  };
}

function service(over: Partial<ConstructorParameters<typeof ScreeningService>[0]> = {}) {
  const r = over.repo ?? repo();
  return {
    repo: r as ReturnType<typeof repo>,
    svc: new ScreeningService({
      repo: r,
      logger: silent,
      now: () => NOW,
      scammer: { async check() { return { status: "CLEAR" as const }; } },
      stats: { async read() { return GOOD; } },
      policy: { async read() { return { autoAccept: true }; } },
      ...over,
    }),
  };
}

const REQ = { guildId: "g1", uuid: "747cf094-48c2-4405-9b5a-67c53f509c6e", ign: "Jack" };

test("a clean applicant under an auto-accepting policy is accepted and recorded", async () => {
  const { svc, repo: r } = service();
  const out = await svc.screen(REQ);
  assert.equal(out.screening.verdict, "ACCEPT");
  assert.equal(out.shouldAccept, true);
  assert.equal(out.id, "row-1");
  assert.equal(r.recorded[0]?.ign, "Jack");
  assert.equal(r.recorded[0]?.stats.skillAverage, 42.5);
});

test("auto-accept off means the verdict is still ACCEPT but nobody is let in", async () => {
  const { svc } = service({ policy: { async read() { return { autoAccept: false }; } } });
  const out = await svc.screen(REQ);
  assert.equal(out.screening.verdict, "ACCEPT");
  assert.equal(out.shouldAccept, false);
});

test("screening disabled never accepts, whatever the verdict says", async () => {
  const { svc } = service({ policy: { async read() { return { enabled: false, autoAccept: true }; } } });
  assert.equal((await svc.screen(REQ)).shouldAccept, false);
});

test("a throwing scammer lookup is recorded as unknown, not as clear", async () => {
  const { svc } = service({ scammer: { async check() { throw new Error("socket hang up"); } } });
  const out = await svc.screen(REQ);
  assert.equal(out.screening.scammer.status, "UNKNOWN");
  assert.equal(out.screening.verdict, "REVIEW");
  assert.match(out.screening.error ?? "", /socket hang up/);
  assert.equal(out.shouldAccept, false);
});

test("a throwing stats source leaves the applicant unreadable rather than perfect", async () => {
  const { svc } = service({ stats: { async read() { throw new Error("hypixel 429"); } } });
  const out = await svc.screen(REQ);
  assert.equal(out.screening.stats.unreadable, true);
  assert.equal(out.screening.verdict, "REVIEW");
});

test("a database that cannot record still yields a usable decision", async () => {
  const broken = { ...repo(), async record(): Promise<string> { throw new Error("db down"); } };
  const { svc } = service({ repo: broken });
  const out = await svc.screen(REQ);
  assert.equal(out.id, null);
  assert.equal(out.screening.verdict, "ACCEPT");
  assert.equal(out.shouldAccept, true);
});

test("a policy source that throws falls back to the defaults, which admit nobody", async () => {
  const { svc } = service({ policy: { async read(): Promise<unknown> { throw new Error("no db"); } } });
  const out = await svc.screen(REQ);
  assert.equal(out.policy.autoAccept, false);
  assert.equal(out.shouldAccept, false);
});

test("a known Discord id reaches the scammer check", async () => {
  let seen: string | null = "unset";
  const { svc } = service({
    scammer: { async check(_uuid, discordId) { seen = discordId; return { status: "CLEAR" as const }; } },
  });
  await svc.screen({ ...REQ, discordId: "358670711109320705" });
  assert.equal(seen, "358670711109320705");
});

test("an unknown Discord id is resolved from the link directory", async () => {
  let seen: string | null = null;
  const { svc } = service({
    links: { async discordIdForUuid() { return "111222333444555666"; } },
    scammer: { async check(_uuid, discordId) { seen = discordId; return { status: "CLEAR" as const }; } },
  });
  const out = await svc.screen(REQ);
  assert.equal(seen, "111222333444555666");
  assert.equal(out.screening.discordId, "111222333444555666");
});

test("the repeat window from the policy is what the history source is asked for", async () => {
  let window = 0;
  const { svc } = service({
    policy: { async read() { return { repeatWindowDays: 90 }; } },
    history: {
      async read(_g, _u, _d, days) {
        window = days;
        return { recentAttempts: 0, priorDenial: false, priorExpulsion: false, expulsionReason: null };
      },
    },
  });
  await svc.screen(REQ);
  assert.equal(window, 90);
});

test("deciding on a screening that was never persisted is a no-op, not a crash", async () => {
  const { svc, repo: r } = service();
  await svc.decide(null, "ACCEPTED", "AUTO");
  assert.equal(r.decisions.length, 0);
  await svc.decide("row-1", "DENIED", "358670711109320705");
  assert.deepEqual(r.decisions[0], ["row-1", "DENIED", "358670711109320705"]);
});

test("with no dependencies wired at all, screening still answers — as unknown", async () => {
  const svc = new ScreeningService({ repo: repo(), logger: silent, now: () => NOW });
  const out = await svc.screen(REQ);
  assert.equal(out.screening.scammer.status, "UNKNOWN");
  assert.equal(out.screening.stats.unreadable, true);
  assert.equal(out.screening.verdict, "REVIEW");
});
