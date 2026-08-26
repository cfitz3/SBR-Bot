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

---

## Part B - The poll interval

### B1. Three layers disagreed, and the operator was never told - **product decision**

Found:

| layer | bound |
|---|---|
| `CommunityServiceImpl` | 5 - 1440 minutes, rejected outside |
| `PanelMutations.updateEvent` | integer, no bound at all |
| `apps/web-panel/client/pages/events.ts` | 5 - 1440, mirroring the service |
| `packages/jobs/src/event-tracking.ts` | **clamped to 60 at read time** |

So an operator could set fifteen minutes in the panel, watch it validate, watch it save -
and be polled hourly, silently, forever. The control did not do what it said.

**The decision, flagged rather than guessed.** The task asked for a five-minute floor and a
15 min / 30 min / 1 hour dropdown. Fifteen and thirty cannot work. The Hypixel Developer
API Policy caps this platform at one request per player per hour
(`docs/HYPIXEL_COMPLIANCE.md`), enforced by the `SET NX EX` claim in
`RedisPlayerRateLimiter`, and an event's participants are players like any other. A
sub-hourly interval does not poll more often; it polls the same amount and is refused the
difference. Offering it would re-create the exact lie this part exists to remove.

So the floor is **60 minutes**, and the panel's shortlist is **1 / 2 / 3 / 6 / 12 / 24
hours**, with a custom value accepted anywhere in range. That is the honest version of the
request: named choices, enforced at the domain layer, none of which is a fiction.

One number now - `EVENT_POLL_MIN_MINUTES` in `@sbr/shared-types`, the only package the
panel, the service, the mutations and the tracker can all reach. `EVENT_POLL_FLOOR_MINUTES`
in `@sbr/jobs` re-exports it. The tracker still clamps at read time as well as rejecting at
write time, because rows created before this floor existed are still in the database; a
migration raises those to 60 so the stored number stops disagreeing with the one in effect.

### B2. Nothing was configurable *from creation* - **fixed**

`CommunityServiceImpl.createEvent` validated a start time and a capacity and nothing else.
Neither it nor `PanelMutations.createEvent` accepted `pollIntervalMinutes`,
`trackedMetrics`, `endsAt` or `prize`. Every contest was therefore created with defaults and
corrected in a second step - and one that went LIVE before somebody remembered captured its
baselines against a metric list nobody had chosen, which no later edit can undo, because a
baseline is the one thing the tracker will not rewrite.

`NewEvent` gains all four. Both layers validate them through the same code the edit path
uses: `validatePollInterval` / `validateMetrics` / `validatePrize` in the service, and
`readTrackerSettings` in the mutations. Two paths applying one rule was the shape of the
original defect and is not repeated.

### B3. Metrics were accepted as free text - **fixed**

`updateEvent` deduplicated and length-capped `trackedMetrics` and then stored whatever
strings arrived. The tracker filters unrecognised metrics at poll time
(`event.trackedMetrics.filter(isEventMetric)`), so a typo was stored happily, displayed in
the panel as a scored metric, and scored nothing. Both layers now check against the catalog
and name what they did not recognise.

### B4. Poll cadence vs. board redraw - **decision: decouple, documented here**

They are already separate jobs on separate clocks. `event-board` sweeps on
`BOARD_REFRESH_MS = 30 * 60_000`, carrying the comment *"Half an hour matches the tracker's
default poll interval"* - which stopped being true when the tracker's floor became sixty
minutes. The board was therefore redrawn roughly twice per data change, spending a Discord
edit each time to write the same numbers.

Decision: **keep the two intervals separate, and make the redraw conditional on the data
having moved.** Merging them would tie a cheap local operation to an expensive remote one;
tying the sweep to each event's own interval would rebuild the tracker's scheduling in a
second place. Instead the board sweep keeps its fixed cadence and skips a LIVE redraw when
no `EventScore` row has changed since `boardUpdatedAt` - so a quiet event costs one query
per pass instead of an edit, and a busy one is never more than half an hour stale. Final
result cards always publish, since `boardFinal` is what stops those repeating. See Part E
for the implementation.

---

## Part D - Prize and duration

### D1. `prize` was genuinely absent - **added**

Confirmed missing from `model Event`, `EventPatch`, `NewEvent`, `EventEdit`, `EventDTO`,
`PanelEvent` and every render path. Added as nullable free text capped at 200 characters,
with migration `20260826120000_event_prize_and_poll_floor`.

**Informational only, deliberately.** Nothing on this platform pays a prize out, and the
schema comment says so, because the obvious next commit is the wrong one: awarding is a
staff action through the existing manual-adjustment ledger, and an automatic payout path
from a competition result is exactly the shape that should not be built without being asked
for.

Empty or whitespace-only input clears the field rather than storing a blank, at both the
service and the mutation layer.

### D2. Duration is settable and editable, before and during - **fixed**

`endsAt` was in `EventPatch` and reachable from nothing: not `NewEvent`, not `EventEdit`,
not the panel. It is now on all three, editable while SCHEDULED *and* while LIVE - an event
running long is ordinary, and the alternative was completing it early to change one field.
`null` clears it back to open-ended, which `nextEventStatus` reads as
`DEFAULT_EVENT_DURATION_MS`.

**Editing duration cannot reset a baseline, and the code says why.** A baseline is tied to
when tracking started, not to when the event is scheduled to stop: `writeBaseline` is
create-if-absent against `(account, event, source)`, and the score row's baseline column is
written only by the insert. Moving `endsAt` touches one column on `Event` and nothing on
`ProfileSnapshot` or `EventScore`. There is a comment at the assignment saying so
explicitly, because "extend the event, re-baseline everyone" is a plausible-sounding thing
for a future change to add.

### D3. An event cannot go LIVE with an end time in the past - **already true, plus a guard at the front**

`nextEventStatus` evaluates `ms >= endsAt` *before* `ms >= startsAt`, so an event whose end
has passed is swept straight to COMPLETED and never enters LIVE at all. That is correct, and
it is also a silent failure: the operator gets a contest that scored nobody and no
explanation. `checkEndsAt` now refuses such a value at the point it is typed, on both create
and edit, along with an end before the start.

