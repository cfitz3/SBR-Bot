import assert from "node:assert/strict";
import test from "node:test";
import type { AutoRolePolicy, AutoRoleRule, GrantRow } from "@sbr/roles";
import {
  MAX_MEMBERS_PER_PASS,
  syncOneMember,
  syncRoles,
  type RoleApplyOutcome,
  type RoleMemberSnapshot,
  type RoleSyncDeps,
} from "./role-sync.js";

const GUILD = "g1";

function rule(over: Partial<AutoRoleRule> = {}): AutoRoleRule {
  return {
    key: "linked",
    label: "Linked",
    trigger: { kind: "LINKED" },
    roleId: "role-linked",
    revokeWhenUnqualified: true,
    enabled: true,
    ...over,
  };
}

function policy(rules: readonly AutoRoleRule[] = [rule()]): AutoRolePolicy {
  return { enabled: true, rules };
}

function member(over: Partial<RoleMemberSnapshot["facts"]> = {}, held: readonly string[] = []): RoleMemberSnapshot {
  return {
    facts: {
      discordId: "u1",
      inGuild: false,
      linked: false,
      guildRank: null,
      xpLevel: 0,
      achievementKeys: [],
      eventsAttended: 0,
      ...over,
    },
    heldRoleIds: held,
  };
}

interface Harness {
  readonly deps: RoleSyncDeps;
  /** Every apply call the pass made, in order. */
  readonly applied: { discordId: string; add: readonly string[]; remove: readonly string[] }[];
  readonly recorded: { discordId: string; rows: readonly GrantRow[] }[];
  readonly closed: { discordId: string; rows: readonly GrantRow[] }[];
  readonly refusals: string[];
  readonly errors: string[];
  /** The dirty set, as the pass sees it. */
  dirty: string[];
  sweepClaimed: number;
}

function harness(over: {
  policy?: AutoRolePolicy;
  members?: readonly RoleMemberSnapshot[];
  roster?: readonly string[];
  sweepDue?: boolean;
  grants?: readonly GrantRow[];
  /**
   * Make the grant ledger remember what was recorded, instead of answering with
   * a fixed list. Needed by anything that reconciles the same member twice: a
   * ledger frozen at empty would have the second pass rediscover the first
   * pass's work as outstanding, which is the bug these tests exist to rule out.
   */
  ledgered?: boolean;
  /**
   * Let the roster mirror catch up with what the effector did, instead of
   * answering every pass with the roles the member held at the start.
   *
   * The mirror is refreshed by its own job, so in production it lags the
   * effector by anything up to that job's interval. Both states are worth
   * testing and they are not the same test.
   */
  mirrored?: boolean;
  outcome?: (add: readonly string[], remove: readonly string[]) => RoleApplyOutcome;
} = {}): Harness {
  const members = over.members ?? [member({ linked: true })];
  /** Roles the mirror believes each member holds, once `mirrored` is on. */
  const held = new Map<string, readonly string[]>();
  const h: Harness = {
    applied: [],
    recorded: [],
    closed: [],
    refusals: [],
    errors: [],
    dirty: [],
    sweepClaimed: 0,
    deps: {
      listGuilds: async () => [GUILD],
      loadPolicy: async () => over.policy ?? policy(),
      claimFullSweep: async () => {
        if (over.sweepDue !== true || h.sweepClaimed > 0) return false;
        h.sweepClaimed += 1;
        return true;
      },
      listMemberIds: async () => over.roster ?? members.map((m) => m.facts.discordId),
      markDirty: async (_g, ids) => {
        for (const id of ids) if (!h.dirty.includes(id)) h.dirty.push(id);
      },
      drainDirty: async (_g, limit) => h.dirty.splice(0, limit),
      loadSnapshots: async (_g, ids) =>
        members
          .filter((m) => ids.includes(m.facts.discordId))
          .map((m) => {
            const seen = held.get(m.facts.discordId);
            return seen === undefined ? m : { ...m, heldRoleIds: [...seen] };
          }),
      openGrants: async (_g, discordId) => {
        if (over.ledgered !== true) return over.grants ?? [];
        const rows = [...(over.grants ?? [])];
        for (const entry of h.recorded) if (entry.discordId === discordId) rows.push(...entry.rows);
        const closed = h.closed.filter((entry) => entry.discordId === discordId).flatMap((entry) => entry.rows);
        return rows.filter((row) => !closed.some((gone) => gone.roleId === row.roleId));
      },
      apply: async (_g, discordId, add, remove) => {
        h.applied.push({ discordId, add, remove });
        const result = over.outcome?.(add, remove) ?? {
          ok: true,
          memberPresent: true,
          added: add,
          removed: remove,
          refused: [],
        };
        if (over.mirrored === true) {
          const start = members.find((m) => m.facts.discordId === discordId)?.heldRoleIds ?? [];
          const next = new Set(held.get(discordId) ?? start);
          for (const roleId of result.added) next.add(roleId);
          for (const roleId of result.removed) next.delete(roleId);
          held.set(discordId, [...next]);
        }
        return result;
      },
      recordGrants: async (_g, discordId, rows) => {
        h.recorded.push({ discordId, rows });
      },
      closeGrants: async (_g, discordId, rows) => {
        h.closed.push({ discordId, rows });
      },
      onRefusal: (_g, _r, detail) => h.refusals.push(detail),
      onError: (scope) => h.errors.push(scope),
    },
  };
  return h;
}

test("a member in the dirty set gains the role their facts qualify them for", async () => {
  const h = harness();
  h.dirty.push("u1");

  assert.equal(await syncRoles(h.deps), 1);
  assert.deepEqual(h.applied, [{ discordId: "u1", add: ["role-linked"], remove: [] }]);
  assert.deepEqual(h.recorded[0]?.rows, [{ ruleKey: "linked", roleId: "role-linked" }]);
});

test("an empty dirty set costs nothing: no snapshots, no Discord calls", async () => {
  const h = harness();

  assert.equal(await syncRoles(h.deps), 0);
  assert.deepEqual(h.applied, []);
});

test("a missed event self-heals on the next full sweep", async () => {
  // Nobody marked them dirty — the gateway event was dropped during a deploy —
  // so the only thing that can find them is the daily sweep.
  const h = harness({ sweepDue: true });
  assert.deepEqual(h.dirty, []);

  assert.equal(await syncRoles(h.deps), 1);
  assert.deepEqual(h.applied, [{ discordId: "u1", add: ["role-linked"], remove: [] }]);
});

test("a rule added today applies to members who qualified long ago", async () => {
  // The sweep is the whole mechanism: a rule has no history and no event to
  // replay, so reconciliation against current facts is what makes it retroactive.
  const veteran = member({ discordId: "u9", inGuild: true, guildRank: "Officer" }, []);
  const h = harness({
    sweepDue: true,
    members: [veteran],
    policy: policy([rule({ key: "officer", trigger: { kind: "GUILD_RANK", rank: "officer" }, roleId: "role-officer" })]),
  });

  assert.equal(await syncRoles(h.deps), 1);
  assert.deepEqual(h.applied, [{ discordId: "u9", add: ["role-officer"], remove: [] }]);
});

test("a sweep is claimed once, so a second pass does not re-mark the roster", async () => {
  const h = harness({ sweepDue: true });

  await syncRoles(h.deps);
  const before = h.applied.length;
  await syncRoles(h.deps);

  assert.equal(h.sweepClaimed, 1);
  assert.equal(h.applied.length, before, "the second pass had an empty dirty set");
});

test("a pass acts on at most MAX_MEMBERS_PER_PASS and leaves the rest for the next", async () => {
  const many = Array.from({ length: MAX_MEMBERS_PER_PASS + 25 }, (_, i) =>
    member({ discordId: `u${i}`, linked: true }),
  );
  const h = harness({ sweepDue: true, members: many });

  assert.equal(await syncRoles(h.deps), MAX_MEMBERS_PER_PASS);
  assert.equal(h.dirty.length, 25, "the overflow is still queued, not dropped");
});

test("a disabled policy neither grants nor revokes", async () => {
  // Switching the feature off is not a request to undo everything it did.
  const h = harness({
    policy: { enabled: false, rules: [rule()] },
    grants: [{ ruleKey: "linked", roleId: "role-linked" }],
    members: [member({ linked: false }, ["role-linked"])],
    sweepDue: true,
  });

  assert.equal(await syncRoles(h.deps), 0);
  assert.deepEqual(h.applied, []);
  assert.deepEqual(h.closed, []);
});

test("a role we never granted is left alone even when the member no longer qualifies", async () => {
  const h = harness({ members: [member({ linked: false }, ["role-linked"])], grants: [] });
  h.dirty.push("u1");

  assert.equal(await syncRoles(h.deps), 0);
  assert.deepEqual(h.applied, [], "no open grant means it was not ours to take");
});

test("a lapsed grant is revoked and its ledger row closed", async () => {
  const grant: GrantRow = { ruleKey: "linked", roleId: "role-linked" };
  const h = harness({ members: [member({ linked: false }, ["role-linked"])], grants: [grant] });
  h.dirty.push("u1");

  assert.equal(await syncRoles(h.deps), 1);
  assert.deepEqual(h.applied, [{ discordId: "u1", add: [], remove: ["role-linked"] }]);
  assert.deepEqual(h.closed[0]?.rows, [grant]);
});

test("a grant whose role was removed by hand is closed without a Discord call", async () => {
  // They do not hold it, so there is nothing to remove; leaving the row open
  // would have every future pass rediscover the same non-work.
  const grant: GrantRow = { ruleKey: "linked", roleId: "role-linked" };
  const h = harness({ members: [member({ linked: false }, [])], grants: [grant] });
  h.dirty.push("u1");

  await syncRoles(h.deps);
  assert.deepEqual(h.applied, []);
  assert.deepEqual(h.closed[0]?.rows, [grant]);
});

test("only roles Discord actually accepted are recorded as granted", async () => {
  const h = harness({
    policy: policy([rule(), rule({ key: "gone", roleId: "role-deleted" })]),
    members: [member({ linked: true })],
    outcome: (add) => ({
      ok: true,
      memberPresent: true,
      added: add.filter((id) => id !== "role-deleted"),
      removed: [],
      refused: [{ roleId: "role-deleted", detail: "That role no longer exists." }],
    }),
  });
  h.dirty.push("u1");

  await syncRoles(h.deps);
  assert.deepEqual(h.recorded[0]?.rows, [{ ruleKey: "linked", roleId: "role-linked" }]);
  assert.deepEqual(h.refusals, ["That role no longer exists."]);
});

test("a failed apply claims nothing and puts the member back in the dirty set", async () => {
  const h = harness({
    outcome: () => ({ ok: false, memberPresent: true, added: [], removed: [], refused: [] }),
  });
  h.dirty.push("u1");

  assert.equal(await syncRoles(h.deps), 0);
  assert.deepEqual(h.recorded, []);
  assert.deepEqual(h.dirty, ["u1"], "the next pass retries rather than waiting a day");
});

test("a member who left the server has their whole ledger closed", async () => {
  const grant: GrantRow = { ruleKey: "linked", roleId: "role-linked" };
  const h = harness({
    members: [member({ linked: false }, ["role-linked"])],
    grants: [grant],
    outcome: () => ({ ok: true, memberPresent: false, added: [], removed: [], refused: [] }),
  });
  h.dirty.push("u1");

  await syncRoles(h.deps);
  assert.deepEqual(h.closed[0]?.rows, [grant]);
});

test("one member's failure does not stop the pass, and they are re-queued", async () => {
  const h = harness({ members: [member({ discordId: "u1", linked: true }), member({ discordId: "u2", linked: true })] });
  h.dirty.push("u1", "u2");
  const apply = h.deps.apply;
  (h.deps as { apply: RoleSyncDeps["apply"] }).apply = async (g, id, add, remove) => {
    if (id === "u1") throw new Error("discord said no");
    return apply(g, id, add, remove);
  };

  assert.equal(await syncRoles(h.deps), 1);
  assert.deepEqual(h.dirty, ["u1"]);
  assert.equal(h.errors.length, 1);
});

test("one guild's failure does not stop the others", async () => {
  const h = harness();
  (h.deps as { listGuilds: RoleSyncDeps["listGuilds"] }).listGuilds = async () => ["bad", GUILD];
  const load = h.deps.loadPolicy;
  (h.deps as { loadPolicy: RoleSyncDeps["loadPolicy"] }).loadPolicy = async (guildId) => {
    if (guildId === "bad") throw new Error("unreadable setting");
    return load(guildId);
  };
  h.dirty.push("u1");

  assert.equal(await syncRoles(h.deps), 1);
  assert.deepEqual(h.errors, ["guild bad"]);
});

test("an unlistable guild set fails the pass quietly rather than throwing", async () => {
  const h = harness();
  (h.deps as { listGuilds: RoleSyncDeps["listGuilds"] }).listGuilds = async () => {
    throw new Error("database down");
  };

  assert.equal(await syncRoles(h.deps), 0);
  assert.deepEqual(h.errors, ["guild list"]);
});

// ─────────────────── the immediate path, and its relationship to the sweep ───

test("a member reconciled on the spot gets their role without waiting for a pass", async () => {
  // The whole point: nobody drained a dirty set, no sweep ran, and the effector
  // was still called for this member before the call returned.
  const h = harness();

  assert.equal(await syncOneMember(h.deps, GUILD, "u1"), true);
  assert.deepEqual(h.applied, [{ discordId: "u1", add: ["role-linked"], remove: [] }]);
});

test("reconciling on the spot leaves the dirty mark alone", async () => {
  // The caller marks and then nudges. If this consumed the mark, a failure
  // anywhere after it — a crash, a refusal, an effector timeout — would leave
  // the member with nothing to catch them until the daily sweep.
  const h = harness();
  h.dirty.push("u1");

  await syncOneMember(h.deps, GUILD, "u1");

  assert.deepEqual(h.dirty, ["u1"]);
});

test("the sweep arriving after an immediate pass makes no second Discord call", async () => {
  // Idempotency, stated the way it actually matters: not "the second call is
  // harmless" but "the second call does not happen". This is the steady state —
  // the immediate pass applied the role and the roster mirror has caught up —
  // and it is what stops every nudge costing the guild two rate-limit budgets.
  const h = harness({ ledgered: true, mirrored: true });
  h.dirty.push("u1");

  await syncOneMember(h.deps, GUILD, "u1");
  assert.equal(h.applied.length, 1);

  // The mark is still there, so the sweep picks the same member up.
  assert.equal(await syncRoles(h.deps), 0);
  assert.equal(h.applied.length, 1);
  assert.equal(h.recorded.length, 1);
  assert.deepEqual(h.closed, []);
});

test("a sweep behind a stale mirror re-asserts the same role and revokes nothing", async () => {
  // The other half of the same story. The roster mirror is refreshed by its own
  // job, so a sweep can arrive still believing the member holds nothing — in
  // which case it asks for exactly what the immediate pass already applied. A
  // no-op PATCH is the cost; what must never happen is the ledger reading it as
  // a *second* grant, or the diff deciding the role is unaccounted for and
  // taking it away.
  const h = harness({ ledgered: true });
  h.dirty.push("u1");

  await syncOneMember(h.deps, GUILD, "u1");
  await syncRoles(h.deps);

  assert.deepEqual(h.applied, [
    { discordId: "u1", add: ["role-linked"], remove: [] },
    { discordId: "u1", add: ["role-linked"], remove: [] },
  ]);
  assert.deepEqual(h.closed, []);
  // One grant row, not two, and the ledger is what stops the second: the role
  // is in the diff's `add` because Discord appears not to have it, but not in
  // its `grant`, because we already know we gave it. So the duplicate is
  // refused here rather than left to the unique index underneath.
  assert.deepEqual(
    h.recorded.map((entry) => entry.rows),
    [[{ ruleKey: "linked", roleId: "role-linked" }]],
  );
});

test("an immediate pass on a guild with auto-roles off does nothing", async () => {
  const h = harness({ policy: { enabled: false, rules: [rule()] } });

  assert.equal(await syncOneMember(h.deps, GUILD, "u1"), false);
  assert.deepEqual(h.applied, []);
});

test("an immediate pass on somebody the roster has never heard of does nothing", async () => {
  // A join the mirror has not caught up with yet. Inventing facts for them
  // would be worse than the fifteen minutes they are about to wait.
  const h = harness();

  assert.equal(await syncOneMember(h.deps, GUILD, "stranger"), false);
  assert.deepEqual(h.applied, []);
});

test("an immediate pass that throws is reported, not raised", async () => {
  // The caller is finishing somebody's link. A role that could not be applied
  // is not a failure of the link, and the mark is what gets it retried — so
  // there is nothing here worth surfacing to the member or retrying in place.
  const h = harness();
  h.deps.apply = async () => {
    throw new Error("discord said no");
  };

  assert.equal(await syncOneMember(h.deps, GUILD, "u1"), false);
  assert.deepEqual(h.errors, ["member u1"]);
});

test("an immediate pass that Discord rejects puts the member back for the sweep", async () => {
  const h = harness({ outcome: () => ({ ok: false, memberPresent: true, added: [], removed: [], refused: [] }) });

  assert.equal(await syncOneMember(h.deps, GUILD, "u1"), false);
  assert.deepEqual(h.dirty, ["u1"]);
});
