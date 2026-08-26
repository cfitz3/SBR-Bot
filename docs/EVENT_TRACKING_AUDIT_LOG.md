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


### D4. Test coverage

`packages/community/src/service.test.ts`, nine new cases: a prize stored trimmed, a
whitespace-only prize stored as `null`, an over-length prize refused rather than truncated,
an end before the start refused, an end already past refused, a start and end moved in one
edit judged against the *new* start, the end time cleared, and — the one the task named
directly — **extending a LIVE event writes a patch whose only key is `endsAt`**. That last
assertion is `deepEqual(Object.keys(patch), ["endsAt"])` rather than a spot check, so a
future change that quietly re-baselines on a duration edit fails the test instead of
shipping. Two more cover the create path, which previously had none: a poll interval below
the floor and a metric outside the catalog are both refused at creation, not only at edit.

---

## Part C - The trackable metric catalog

### C1. Six metrics, and no stated reason for six - **widened to eighteen**

Events could score `skyblockLevel`, `networth`, `skillAverage`, `catacombsLevel`,
`slayerXp`, `senitherWeight`. The milestone system had already settled the harder question
- which metrics are personal, snapshot-backed and comparable over time - and answered it
with `SNAPSHOT_MILESTONE_METRICS` (18). Events were using a hand-copied subset of it.

`EVENT_METRICS` is now defined as `SNAPSHOT_MILESTONE_METRICS`, so there is one list, and
adding a metric to progression makes it event-scorable without a second edit.

**Product decision - what stays out.** The four `COMMUNITY_MILESTONE_METRICS`
(`eventsAttended`, `eventPodiums`, `guildTenureDays`, `guildXp`) are excluded. They are not
snapshot-backed, three of them are monotonic counters the platform increments itself, and
`guildXp` is guild-scoped rather than personal. An event scoring "guild XP gained" would
give every participant the same number; an event scoring "events attended" is a contest
about attending the contest. `validateMetrics` rejects them by name with the reason, rather
than storing them and letting the tracker's own filter drop them silently, which is what
happened before.

### C2. Formatting was written for the six - **fixed per family**

`formatDelta` abbreviates: `+12.5k`. That is correct for slayer XP and networth, which
arrive in the millions, and wrong for everything the widened catalog added. A catacombs
class going from 34 to 36 is `+2`, not `+0k`.

`eventMetricFormat(metric)` classifies each metric as `XP`, `COINS`, `LEVEL` or `COUNT`, and
`formatMetricDelta` renders accordingly - abbreviated for the two large families, rounded
integers for counts, grouped two-decimal figures for levels and weight. Tested per family
rather than per metric, since the families are what the formatter branches on.

### C3. The `/me` podium line camelCased twelve of them - **fixed**

`podium.ts` needs no change and got none: it ranks by `delta` and carries `metric` as an
opaque string, so it was already correct for a catalog it had never heard of. The *renderer*
was not. `metricLabel` in `render.ts` held a hand-written table of seven keys and fell back
to title-casing the camelCase tail, so a Voidgloom event podium read `SlayerEnderman`. It
now consults `copy.embed.metricPhrase` - the same brand vocabulary the board draws from -
before falling back, so the two surfaces cannot name the same metric differently.

### C4. The picker was a flat list of six - **grouped by family**

The panel's metric picker now groups by `AchievementCategory`, matching the milestones
page's existing grouped-by-family pattern, with the per-family count beside each heading.
Eighteen checkboxes in one column would have been the wrong shape even if it rendered.

`EVENT_MAX_TRACKED_METRICS` stays at 5. Each tracked metric is a separate standings field on
one embed, and six of them exceeds what a board can show without becoming a wall.

---

## Part E - The board

### E1. One message, edited in place - **confirmed, with one real duplication window closed**

The gateway posts once, stores `messageId`, and edits thereafter; `allowedMentions: {parse: []}`
is set on both the post and the edit, so the column of `<@id>` standings never pings the top
ten every half hour.

The duplication risk was real but narrow: between `channel.send` succeeding and the
`messageId` being written back, a crash left an orphaned board that the next sweep would not
recognise, and it would post a second one. Closed by `findBoard` - the footer stamps
`id <eventId>`, so before posting, the gateway scans recent channel history for its own
board and adopts it. This is why the footer carries the id at all.

### E2. Redraw churn - **filtered**

`listBoardDue` no longer returns LIVE events whose scores have not moved since the last
redraw. A board that says the same thing is not worth an edit, and the sweep was issuing one
per event per half hour regardless.

### E3. What the embed says now

Rank column (medals for the podium, numerals below - eleven medals is no ranking), the
scored-metrics list named on the board itself, prize, time remaining while there is any,
participant count, and a footer carrying the event id and a relative "updated" stamp.

Three edge cases, each with a distinct line rather than an empty field:

- **No scores yet** - "the first poll sets everyone's baseline", which is what is actually
  true in the first hour of a live event.
- **Everyone on zero** - "Nobody has gained any X yet." A column of `+0` reads as a broken
  tracker; this reads as a slow start.
- **RSVP'd but unlinked** - listed in their own field, `Not scored — no linked account (n)`.
  They were silently absent before, which is indistinguishable from not turning up.

---

## Part F - The panel events page

### F1. Grouped by status

Three groups, because the question differs: a live event is something you watch, a scheduled
one something you edit, a completed one something you read. The old flat "upcoming" list
mixed the first two, and the Live card is hidden entirely when nothing is running rather
than showing an empty table. The archive is the same list - `listEvents` already returns the
50 most recent of every status - which is what Part G's "history view" asked for.

### F2. Settings separated from live data

The tracker settings (metrics, poll interval, prize, end time) are one block, built by a
single `trackerFields()` used by both the create form and the edit form, so the two cannot
drift. Standings, attendance and the board preview are separate cards below. This is the
policy-vs-commentary split the XP settings page uses.

### F3. Inline validation

The poll interval is a `<select>` of the allowed values rather than a free number, so an
invalid one is not typeable. The end time validates on `input` - before the start, or
already past - with the message under the field. An event stored with a pre-floor interval
keeps that value as an extra option rather than being silently snapped to 60 on the next
unrelated edit.

### F4. The board preview - **product decision: server-rendered**

The welcome editor previews char-for-char in the browser, and the obvious move was to copy
it. It does not work here, and the reason is worth writing down: **the browser only receives
`panel` and `error` copy.** `embed.field.*` and `embed.metricPhrase` never reach it. A
client-side mirror of `renderEventBoardEmbed` would therefore be a second implementation
with its own copy of the strings, and it would start lying the moment a guild overrode one.

So the preview is a `GET /api/guilds/:id/event-board?event=:id` that calls the bridge's own
`renderEventBoardEmbed` on the same rows the page is already showing, and renders the
returned `EmbedView`. It cannot disagree with the post, because it *is* the post.

This adds a `@sbr/commands-bridge` dependency to the `web-panel` app. Deliberately to the
app and not to `@sbr/panel-core`: the core is shared with callers that have no business
depending on a Discord command layer, and this composition root already depends on both.
(The same edge into `panel-core` was rejected during the moderation pass for that reason.)

No new visual language: the two CSS rules added are built from existing theme tokens, and
every string is a new key in the existing `panel.events` copy block.

---

## Part G - QoL, assessed

The brief asked for these to be evaluated against a ~125-member guild rather than built on
sight. Three were already true; one is declined with reasons.

### G1. "Most improved" - **declined, and the board already is one**

Standings are *deltas*, not readings. The board never showed a rich list; it has always
shown what somebody did during the event, which is the thing "most improved" was asking for.

A second, proportional framing - biggest gain relative to starting point - was considered
and rejected on the maths. The baseline is stored, so it was cheap to build, but the figure
is ill-behaved exactly where the catalog just widened: a `bestiaryMilestone` baseline of 0
has no ratio at all, and a member going from catacombs 5 to 10 outranks one going 45 to 50
by a factor of nine while having done a small fraction of the work. A prominent award
computed from a number that misleads on half the catalog is worse than no award.

### G2. Per-event Discord role - **declined**

The effector applies role *ids*; it cannot create roles, and its preflight exists to refuse
privileged grants. A per-event role therefore needs either staff to pre-create and configure
a role per event - at which point the automation saves nothing - or a new create-role
capability on the admin bot, which widens the exact permission surface the preflight rules
were written to keep narrow. For a guild of 125 running events in a channel everybody
already reads, a temporary colour is not worth that trade. Not built, and not half-built.

### G3. "Starting soon" reminder - **already covered**

`REMINDER_OFFSETS_MINUTES = [24 * 60, 60]` in `packages/jobs/src/events.ts`, dispatched to
RSVP'd attendees, with `reminderState` as the idempotency guard and a staleness window so a
delayed sweep does not send "starts in 1 hour" two hours late. Nothing to add.

### G4. Event history / archive - **covered by F1**

Not built as a separate view, since the Completed group on the events page is one, backed by
a read that already returns every status.

**Out of scope and not built, per the brief:** team events, wagering, anything moving in-game
currency. The prize field is text on a card and nothing reads it.

---

## One event, end to end

Traced against the code, not run against Hypixel - the API key outage noted in the earlier
audit is still in force.

1. **Create.** Staff open the events page, fill the form: title, start `2026-09-01 18:00`,
   end `2026-09-02 18:00`, metrics *Voidgloom XP* and *Catacombs level* (two families, two
   formatters), interval *every 3 hours*, prize "500k coins". `createEvent` validates the
   start is future, the end is after it and not past, the interval is 60..1440, both metrics
   are in the catalog, and the prize fits 200 characters. Row written `SCHEDULED`.
2. **Board posted.** The board sweep sees an event with a bound events channel and no
   `messageId`, calls `findBoard` (nothing to adopt), posts once with mentions disabled, and
   writes the id back. The embed shows a countdown, the prize, the two scored metrics, and
   no standings.
3. **Reminders.** 24 hours and 1 hour before the start, RSVP'd members are pinged; each
   offset is marked in `reminderState` and never repeats.
4. **LIVE.** `nextEventStatus` checks `endsAt` first - not passed - then `startsAt`, and
   flips the row.
5. **First poll.** The tracker claims the event, reads each participant through the shared
   rate-limited cache, and writes one baseline row per (participant, metric). A participant
   whose Hypixel read throws is logged and skipped; the other forty are scored. An
   overlapping tick finds the claim held and returns.
6. **Later polls, every 3 hours.** `delta = current - baseline`. `upsertScore` returns early
   when nothing moved.
7. **Redraw.** The board sweep runs on its own 30-minute cadence and skips this event unless
   a score moved. When it does redraw, it edits the same message: rank column, `+412k` for
   the slayer metric and `+2` for the class metric, the prize, "ends in 4 hours", and the
   unlinked RSVPs in their own field.
8. **Extended mid-event.** Staff push the end time back two hours. The patch contains one
   key. Every baseline and every delta is untouched.
9. **COMPLETED.** The end passes; the sweep completes the event, stamps `endsAt`, records
   tracked attendance, and marks those members dirty for role sync. The board is edited one
   last time into the result card - "final results", "Ended 2 minutes ago", the prize still
   shown, because who won what for what is the whole point of leaving it in the channel.
10. **After.** The event appears under Completed on the panel with its final standings; the
    top three appear on their `/me` cards, named in words.
