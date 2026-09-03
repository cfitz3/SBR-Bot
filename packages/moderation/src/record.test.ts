import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditQuery, ModerationActionDTO } from "@sbr/shared-types";
import { memberRecordSource } from "./record.js";

const NOW = new Date("2026-08-06T00:00:00.000Z");
const GUILD = "guild-1";
const MEMBER = "member-1";

function action(over: Partial<ModerationActionDTO>): ModerationActionDTO {
  return {
    id: "a1",
    caseCode: "CASE-target-a1b2c3d4-1",
    guildId: GUILD,
    type: "WARN",
    actorDiscordId: "staff-1",
    targetDiscordId: MEMBER,
    reason: "spam",
    durationSeconds: null,
    expiresAt: null,
    surfaces: ["DISCORD"],
    enforcement: "NOT_REQUIRED",
    enforcementDetail: null,
    enforcementAttempts: 0,
    enforcementAt: null,
    active: false,
    createdAt: NOW.toISOString(),
    updatedAt: null,
    editedByDiscordId: null,
    voidedAt: null,
    voidReason: null,
    ...over,
  };
}

function make(rows: readonly ModerationActionDTO[], policy?: unknown) {
  const queries: AuditQuery[] = [];
  const source = memberRecordSource({
    repo: {
      async listActions(query) {
        queries.push(query);
        return rows;
      },
    },
    ...(policy === undefined ? {} : { escalation: { async readPolicy() { return policy; } } }),
    now: () => NOW,
  });
  return { source, queries };
}

test("the record is scoped to the one member it was asked about", async () => {
  const { source, queries } = make([]);
  const result = await source.forMember(GUILD, MEMBER);
  assert.equal(result.ok, true);
  assert.equal(queries.length, 1);
  assert.equal(queries[0]?.guildId, GUILD);
  assert.equal(queries[0]?.targetDiscordId, MEMBER);
});

test("warnings are counted inside the window the ladder uses", async () => {
  const { source } = make(
    [
      action({ id: "w1", createdAt: "2026-08-05T00:00:00.000Z" }),
      action({ id: "w2", createdAt: "2026-07-01T00:00:00.000Z" }),
      // Two years ago: outside every window a guild can configure.
      action({ id: "w3", createdAt: "2024-08-05T00:00:00.000Z" }),
      // Not a warning.
      action({ id: "n1", type: "NOTE" }),
    ],
    {},
  );
  const result = await source.forMember(GUILD, MEMBER);
  assert.equal(result.ok && result.value.warnings, 2);
  assert.equal(result.ok && result.value.windowDays, 90);
});

test("a guild's own window is what the count reports", async () => {
  const { source } = make(
    [
      action({ id: "w1", createdAt: "2026-08-05T00:00:00.000Z" }),
      action({ id: "w2", createdAt: "2026-07-01T00:00:00.000Z" }),
    ],
    { windowDays: 7 },
  );
  const result = await source.forMember(GUILD, MEMBER);
  assert.equal(result.ok && result.value.warnings, 1);
  assert.equal(result.ok && result.value.windowDays, 7);
});

test("the next rung is the one the *next* warning lands on", async () => {
  // Two warnings against the default ladder: the third is the mute.
  const { source } = make(
    [action({ id: "w1" }), action({ id: "w2" })],
    {},
  );
  const result = await source.forMember(GUILD, MEMBER);
  assert.deepEqual(result.ok ? result.value.nextEscalation : null, {
    warns: 3,
    action: "MUTE",
    durationSeconds: 3600,
  });
});

test("nothing is promised when the next warning falls between rungs", async () => {
  // Three warnings: the fourth triggers nothing, and saying otherwise would be
  // a threat the ladder does not carry out.
  const { source } = make([action({ id: "w1" }), action({ id: "w2" }), action({ id: "w3" })], {});
  const result = await source.forMember(GUILD, MEMBER);
  assert.equal(result.ok && result.value.nextEscalation, null);
});

test("a disabled ladder promises nothing", async () => {
  const { source } = make([action({ id: "w1" }), action({ id: "w2" })], { enabled: false });
  const result = await source.forMember(GUILD, MEMBER);
  assert.equal(result.ok && result.value.nextEscalation, null);
  // The warnings themselves are still real and still reported.
  assert.equal(result.ok && result.value.warnings, 2);
});

test("with no policy source wired there is no next rung to report", async () => {
  const { source } = make([action({ id: "w1" }), action({ id: "w2" })]);
  const result = await source.forMember(GUILD, MEMBER);
  assert.equal(result.ok && result.value.nextEscalation, null);
  assert.equal(result.ok && result.value.warnings, 2);
});

test("only punishments still in force are listed, soonest to end first", async () => {
  const { source } = make(
    [
      // Flagged active but its clock ran out — the sweep has not been round yet.
      action({
        id: "m0",
        type: "MUTE",
        active: true,
        expiresAt: "2026-08-05T00:00:00.000Z",
        reason: "expired mute",
      }),
      // Lifted by a staffer.
      action({ id: "m1", type: "MUTE", active: false, expiresAt: null, reason: "lifted mute" }),
      action({
        id: "b1",
        type: "BAN",
        active: true,
        expiresAt: null,
        reason: "permanent ban",
      }),
      action({
        id: "m2",
        type: "MUTE",
        active: true,
        expiresAt: "2026-08-06T01:00:00.000Z",
        reason: "current mute",
      }),
    ],
    {},
  );
  const result = await source.forMember(GUILD, MEMBER);
  assert.deepEqual(
    result.ok ? result.value.inForce.map((p) => [p.type, p.reason]) : null,
    [
      ["MUTE", "current mute"],
      ["BAN", "permanent ban"],
    ],
  );
});

test("a clean member's record is empty rather than absent", async () => {
  const { source } = make([], {});
  const result = await source.forMember(GUILD, MEMBER);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : null, {
    warnings: 0,
    windowDays: 90,
    inForce: [],
    // A first warning is not a mute, so there is nothing to promise.
    nextEscalation: null,
  });
});

test("a mangled policy row falls back to the platform ladder", async () => {
  const { source } = make([action({ id: "w1" }), action({ id: "w2" })], "not a policy");
  const result = await source.forMember(GUILD, MEMBER);
  assert.equal(result.ok && result.value.windowDays, 90);
  assert.equal(result.ok ? result.value.nextEscalation?.warns : null, 3);
});
