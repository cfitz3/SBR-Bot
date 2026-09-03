/**
 * The `/audit` where-clause, without a database.
 *
 * The part worth testing is the one that is easy to get wrong by writing the
 * obvious code: three optional filters all constrain `createdAt`, and Prisma
 * takes one object per column, so assigning them in sequence drops all but the
 * last and returns a result set that looks like an answer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditQuery } from "@sbr/shared-types";
import { auditWhere } from "./moderation.js";

const NOW = new Date("2026-03-20T12:00:00.000Z");
const q = (over: Partial<AuditQuery> = {}): AuditQuery => ({ guildId: "g1", ...over });

const createdAt = (where: Record<string, unknown>): { gte?: Date; lte?: Date } | undefined =>
  where.createdAt as { gte?: Date; lte?: Date } | undefined;

test("no filters means no date constraint at all", () => {
  const where = auditWhere(q(), NOW);
  assert.deepEqual(where, { guildId: "g1" });
});

test("an explicit range survives alongside a relative one", () => {
  const where = auditWhere(
    q({ sinceDays: 30, since: "2026-03-15T00:00:00.000Z", until: "2026-03-18T23:59:59.999Z" }),
    NOW,
  );
  // The tighter lower bound wins: somebody who asks for both is narrowing.
  assert.equal(createdAt(where)?.gte?.toISOString(), "2026-03-15T00:00:00.000Z");
  assert.equal(createdAt(where)?.lte?.toISOString(), "2026-03-18T23:59:59.999Z");
});

test("the relative bound wins when it is the tighter of the two", () => {
  const where = auditWhere(q({ sinceDays: 2, since: "2026-01-01T00:00:00.000Z" }), NOW);
  assert.equal(createdAt(where)?.gte?.toISOString(), "2026-03-18T12:00:00.000Z");
});

test("an upper bound alone is a filter in its own right", () => {
  const where = auditWhere(q({ until: "2026-03-01T00:00:00.000Z" }), NOW);
  assert.equal(createdAt(where)?.gte, undefined);
  assert.equal(createdAt(where)?.lte?.toISOString(), "2026-03-01T00:00:00.000Z");
});

test("a date nobody can parse is dropped, not turned into Invalid Date", () => {
  // Prisma takes an Invalid Date and returns nothing, which reads as "no
  // moderation has ever happened here" rather than as a typo.
  const where = auditWhere(q({ since: "last tuesday", until: "" }), NOW);
  assert.equal(where.createdAt, undefined);
});

test("zero days is not a filter", () => {
  assert.equal(auditWhere(q({ sinceDays: 0 }), NOW).createdAt, undefined);
});

test("in_force narrows to the punishments that are actually running", () => {
  const where = auditWhere(q({ inForceOnly: true }), NOW);
  assert.equal(where.active, true);
  assert.deepEqual(where.type, { in: ["MUTE", "BAN"] });
  assert.deepEqual(where.OR, [{ expiresAt: null }, { expiresAt: { gt: NOW } }]);
});

test("in_force with an explicit type respects the type the caller asked for", () => {
  assert.equal(auditWhere(q({ inForceOnly: true, type: "BAN" }), NOW).type, "BAN");
});

test("the ordinary filters are applied only when supplied", () => {
  const where = auditWhere(q({ actorDiscordId: "a1", targetDiscordId: "t1", type: "KICK" }), NOW);
  assert.deepEqual(where, { guildId: "g1", actorDiscordId: "a1", targetDiscordId: "t1", type: "KICK" });
});

// ── free text ───────────────────────────────────────────────────────────────

test("a term that looks like a case id is matched exactly, not fuzzily", () => {
  const where = auditWhere(q({ term: "CASE-DrJay-a1b2c3d4-2" }), NOW);
  assert.deepEqual(where.OR, [
    { caseCode: { equals: "CASE-DrJay-a1b2c3d4-2", mode: "insensitive" } },
    { id: "CASE-DrJay-a1b2c3d4-2" },
  ]);
});

test("any other term searches the id, the target and the reason", () => {
  const where = auditWhere(q({ term: " DrJay " }), NOW);
  assert.deepEqual(where.OR, [
    { caseCode: { contains: "DrJay", mode: "insensitive" } },
    { id: "DrJay" },
    { targetDiscordId: "DrJay" },
    { reason: { contains: "DrJay", mode: "insensitive" } },
  ]);
});

test("an empty term is not a filter", () => {
  assert.deepEqual(auditWhere(q({ term: "   " }), NOW), { guildId: "g1" });
});

test("a term and in_force both apply, rather than one replacing the other", () => {
  // Both narrow, and Prisma takes one `OR` per object: written the obvious way,
  // the second would silently overwrite the first and widen the search back to
  // every case in the guild.
  const where = auditWhere(q({ term: "DrJay", inForceOnly: true }), NOW);
  assert.equal(Array.isArray(where.OR), true);
  assert.deepEqual(where.AND, [{ OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }] }]);
});
