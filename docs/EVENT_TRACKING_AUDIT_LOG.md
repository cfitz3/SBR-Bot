# Event tracking — audit and hardening

Branch `feat/event-tracking-hardening`. What follows is written as it was found and
changed, part by part, including the places where the task's premise turned out not to
hold and the product decisions that had to be made rather than guessed.

---

## Part A — Concurrency and multi-player correctness

### A1. The Hypixel budget is not bypassed — confirmed, no change

`trackEvents` does not fetch. It hands `capture` to `refreshProfiles`, the same function
the bulk `snapshot` job uses, and in `apps/workers/src/jobs.ts` both jobs are wired to the
identical `captureProfile`. That fans out to `ctx.progression.getProfileSummary` /
`getNetworth` / `getDungeons` / `getSlayers`, all four of which resolve against one cached
profile fetch through `HypixelClient`, which checks `RedisPlayerRateLimiter` — the
`SET NX EX` claim on `rl:player:{uuid}:{endpoint}` — *before* the shared `RateGate`.

So a member in an event and in the guild roster costs one read per hour between both, not
two. There is no second path and nothing to fix here. The one-profile-read-path property
is load-bearing enough that the job's own doc comment already says so; this pass confirms
it is still true.

### A2. One participant's failure took the rest of the roster with it — **fixed**

`refreshProfiles` guarded `capture` and nothing after it:

```ts
const captured = await deps.capture(account).catch(() => null);
if (captured === null) continue;
...
await deps.write(reading);                          // unguarded
if (deps.onReading) await deps.onReading(reading);  // unguarded
```

For `profile-refresh` that is correct — a database refusing snapshots is a run-level
problem and the job runner owns the retry. For event tracking it is not. `onReading` is
where `writeBaseline`, `writeFinal` and every `upsertScore` happen, so a single rejected
score row threw out of the loop, was caught by `trackEvents`' per-event handler, and cost
**everybody queued behind that participant** their pass — silently, since the per-event
catch reports one scope string and returns.

The fix keeps both behaviours rather than picking one. `ProfileRefreshDeps` gains an
optional `onAccountError(account, error)`; with no handler the throw still leaves the loop
exactly as before, and `trackEvents` supplies one that reports
`event {id} account {uuid}` and continues. Isolation is opt-in, so `profile-refresh` is
untouched.

Verified by three tests: `refreshProfiles` still rejects when no handler is given; with a
handler the two accounts behind the failure are written and the failure is reported; and
the handler catches a failing `onReading`, not only a failing `write`.

### A3. Baseline capture under overlapping passes — **two separate problems, both fixed**

**The score upsert was a check-then-act.** `upsertScore` in
`packages/db/src/repositories/jobs.ts` did `findUnique` → `create` if absent → otherwise
`update`. Two overlapping passes both read absent, both insert, and the loser takes a
P2002 straight out of the middle of the roster. The `EventScore` unique index means the
*baseline* was never corrupted — one writer wins and the baseline is immutable after that
— but the exception was, before A2, an aborted roster, and after A2 a skipped participant.

Rewritten to insert first and catch `P2002`, then fall through to read-the-baseline and
update. This matches the idiom `writeSnapshot(…, "create-if-absent")` already uses a few
hundred lines below it, which is why `ProfileSnapshot` baselines were already idempotent
and `EventScore` rows were not. Losing the insert race is not an error: it means somebody
wrote the same baseline, and the update is what this pass owed the row either way. Two
concurrent updates compute the same delta because the baseline cannot move.

**The job lock does not cover the pass.** `event-tracking` holds
`lock:job:event-tracking` with `lockTtlMs: 10 * 60_000`. A pass over several LIVE events
with dozens of participants each — every one of them a network round trip — can outlive
ten minutes, at which point the next tick acquires the expired lock and starts scoring
rosters the previous pass is still working through. The lock is also global to the job,
so it is the wrong shape: the unit that actually conflicts is the event.

Added `keys.eventPoll(eventId)` → `lock:event-poll:{id}` and an optional
`claimPoll(eventId, ttlSeconds)` dep returning a release or `null`. It is wired in
`apps/workers/src/jobs.ts` to `ctx.adapters.lock` — the same owner-checked `LockPort` the
job runner uses, so a slow pass can never free a claim a later pass took over after the
TTL. The TTL is the event's own (clamped) poll interval; the claim is released in a
`finally`, so the interval is only ever the ceiling on a *dead* worker, and cadence stays
owned by `lastCapturedAt` rather than becoming a second clock that can drift against it.

The claim is taken before the participant read, so a duplicate pass costs one Redis round
trip instead of a query and a fan-out of writes. It is optional so a caller without Redis
polls unclaimed, which is what this job did before.

### A4. What the new tests cover

In `packages/jobs/src/event-tracking.test.ts`, a `trackEvents under concurrency` suite:

- three LIVE events across three guilds in one pass, each scored against its own roster
  with nothing leaking between them;
- a participant whose score write throws — the two behind them are still scored, and the
  failure is reported rather than swallowed;
- a participant who unlinks mid-event — they stop appearing on the next pass and keep the
  baseline they already earned;
- an overlapping tick arriving while the event is claimed — no Hypixel budget spent, and
  the next tick proceeds once the claim is released;
- a thrown pass still releasing its claim, so a failure cannot lock an event out;
- one claimed event not blocking the others in the same tick.
