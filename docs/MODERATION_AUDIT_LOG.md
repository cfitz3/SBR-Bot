# Moderation & sync audit — findings, repairs, decisions

Branch: `fix/moderation-sync-audit`. Every file in `packages/moderation/src` was read,
along with the four composition roots that wire it (`apps/admin-bot`, `apps/bridge-bot`,
`apps/web-panel`, `apps/workers`), `packages/commands-admin`, `packages/db`'s moderation
repository, and the jobs/analytics packages they touch.

The reported symptom — *a ban logged a case, but the member was neither banned from
Discord nor `/g kick`ed from the guild* — turned out to be two independent silences that
happened to overlap on the one command. Both are fixed, and the schema now carries the
fact that used to have nowhere to live: **whether an action was actually carried out.**

---

## Part 1 — The confirmed bug, traced to its origin

### A. The admin bot never made a Discord API call for a ban

`ModerationServiceImpl` took a port called `enforcement`. The name reads like "the thing
that enforces". It is not: `EnforcementMirror` is a **Redis cache of active mute/ban keys**,
read by the bridge and the dispatchers to answer "is this person muted right now". Writing
to it removes nobody from anywhere.

`apps/admin-bot/src/composition.ts` wired `enforcement: adapters.enforcement` and nothing
else. `GuildEffects` — the admin bot's Discord-write port — had `timeout`, `purge`, `lock`,
and **no `ban`**. `/ban` therefore:

1. wrote the row,
2. wrote a Redis key,
3. replied "Banned".

No step in that list contacts Discord. The member stayed.

**Fix.** A dedicated `DiscordEnforcer` port (`packages/moderation/src/ports.ts`) separate
from the mirror, returning `EnforcementOutcome` — `{ok:true}`,
`{ok:true,skipped:true,reason}`, or `{ok:false,reason}`. `GuildEffects` gained
`ban`/`unban`/`timeout`/`untimeout` (`packages/shared-types/src/services.ts`, implemented in
`apps/admin-bot/src/effects.ts` against `guild.bans.create/remove` and `member.timeout`).
The service now calls it and **awaits the answer**.

Crucially, a process wired *without* an enforcer is not silently excused:

```ts
if (this.discord === null) {
  return { ok: false, reason: "no Discord enforcer is wired into this process" };
}
```

That is the line that would have turned the original bug into a red case on day one.

### A′. The same conflation in two more roots

Found while checking whether the fix was complete:

- **`apps/web-panel/src/composition.ts`** hid a real Discord call *inside* the mirror
  adapter and downgraded its failure to `log.warn`. A ban from the panel could fail and the
  panel would still show the case as normal. Split apart: the mirror is now plain
  `adapters.enforcement`, and the real call is a `discord.enforce` implementation whose
  failure becomes the case's `FAILED` status.
- **`apps/bridge-bot/src/composition.ts`** had **no Discord enforcement at all** — and the
  bridge bot is the process that runs automod. Every automod mute in that process was going
  to be a row and nothing else. Added `apps/bridge-bot/src/enforcement-effector.ts`, which
  posts to the admin bot's existing `POST /internal/g/:guildId/enforce` loopback endpoint,
  per the documented rule that privileged Discord writes belong to the admin bot.

### B. The relay was fire-and-forget over pub/sub

`GameCommandBus.send` returned `void`. It publishes to Redis pub/sub, which has **no
store-and-forward**: with the bridge offline or not spawned in-game, `PUBLISH` succeeds
against zero subscribers, the message evaporates, and the only trace was a debug log.
`/g kick` for a banned member simply never happened, and nothing anywhere recorded that.

**Fix.** `send` returns `Promise<boolean>`. All three roots that wire it now check bridge
liveness first (`adapters.heartbeat.list()` for `service === "bridge-bot"` with
`details["mcSpawned"] === true`) and answer `false` when there is nobody to receive it.
`relayToGame` distinguishes the two "nothing was sent" cases that were previously one:

- **skipped** — sync off, row disabled, no in-game equivalent, target never linked. Nothing
  was supposed to go and nothing did. Not a failure.
- **failed** — a command resolved and could not be delivered. The case says so.

### C. `applyAction` returned success regardless of what happened

It returned `ok(action)` unconditionally. Even with A and B fixed, the staffer's reply and
the audit row would still have claimed a ban that had not landed.

**Fix.** A new `enforce()` stage plus two columns:

- `packages/db/prisma/migrations/20260825120000_enforcement_status/migration.sql` adds
  `enforcement` (`NOT_REQUIRED | PENDING | CONFIRMED | FAILED`) and `enforcementDetail`.
- The row is written **PENDING before anything is attempted**, so a crash mid-enforcement
  leaves evidence. A row written only on success leaves none — that was the original shape.
- Existing rows are backfilled to `NOT_REQUIRED`, not left `PENDING`: they predate the
  tracking, and `PENDING` would drop the entire history into the "needs doing by hand"
  queue on deploy.
- `renderEnforcement` (`packages/commands-admin/src/render.ts`) puts the verdict in the
  staffer's reply, so "Banned" and "Recorded, but not enforced — missing permission" are
  different sentences.

**No path now exists where the case log says "banned" and the member is still present.**

---

## Part 2 — Other defects found in the audit

### D. Every automod punishment was being refused

Automod acts as the literal actor id `"automod"`, which has no `GuildMember` row, so
`ranks.getRole` returned `null`, so the guard *"an actor with no membership has no
standing"* rejected **every automod warn and mute** as `TARGET_OUTRANKS_ACTOR`. The whole
automod enforcement path was dead.

It was invisible because `service.test.ts`'s rank fake resolved unknown ids to `"MEMBER"`
instead of `null` — the fake was kinder than production. Fixed the fake first, watched the
tests go red, then fixed the code: a `systemActorIds` set exempting `AUTOMOD_ACTOR` and
`EXPIRY_ACTOR` from the hierarchy check. There is no hierarchy question to answer for them;
automod is not a member competing for rank, it is the guild's own rule.

A regression test asserts the flip side: *a real staffer with no member row is still
refused.*

### E. Punishments could be applied and never lifted

`/mute` existed; `/unmute` did not. `/ban` existed; `/unban` did not. The only way to lift
either was by hand in Discord, which left the mirror and the audit row saying otherwise.
Both added, both routed through the service so they mirror, relay `/g unmute`, and record.

### F. Temporary bans became permanent

`punishment-expiry` (in workers) called `sweepExpired`, which **only flips the `active` flag
in the database**. `docs/WORKERS.md` claimed this was fine because "a Discord timeout
expires on its own". True of a timeout; false of a Discord **ban** and false of a Hypixel
guild mute. A 7-day tempban was cleared from the audit view and never lifted anywhere.

**Fix.** `reverseExpired()` reads `listExpiredActive`, issues a real `UNBAN`/`UNMUTE`
through `applyAction` as the `expiry` system actor (so it enforces on both surfaces and
logs a case), and only then clears the flags.

The job **moved out of workers into the admin bot**
(`apps/admin-bot/src/punishment-sweep.ts`, 5-minute interval, on the existing `JobRunner` +
distributed lock). It has to live where the Discord enforcer is. The workers copy, its
schedule entry, and its `RUNNABLE_JOBS` entry were removed — a manual-run request routed to
workers would otherwise be accepted and then do nothing. Worse, a concurrent workers sweep
would clear exactly the flags that identify rows still owed a reversal.

### G. The Analytics "moderation actions" chart counted rows, not effects

`metrics.actionApplied` fired before any enforcement was attempted, under a comment
claiming it meant a punishment had taken effect. Moved to after both surfaces answer, and
`actionFailed` added (`mod.action.failed`, dimension `type`) with the rollup and series
labels to chart it. A guild whose bot lost Ban Members can now *see* the failures.

### H. The `modlog` channel slot was configurable and nothing ever wrote to it

A guild could bind `modlog` in the panel, see it listed as bound, and receive nothing
forever — worse than not offering the slot, because the operator concludes moderation *is*
being logged somewhere.

**Fix.** `packages/moderation/src/mod-log.ts`: a pure `modLogEmbed(action, now)` returning
the same `EmbedView` view-model every other card in the platform returns, so the existing
house-style checker in `@sbr/discord-kit` applies to it unchanged — no new embed style was
invented. Posted by both bots (the admin bot for typed commands, the bridge bot for
automod), falling back `modlog` → `staff`, and *deliberately not* escalating to the ops
error channel: an unbound mod log is a configuration preference, not an incident.

The card shows enforcement as a field, not a footnote — a mod log that prints only "logged"
is the same silence the command replies used to have. Colour is by severity, not success (a
failed ban and a successful ban are both red; the field is what tells them apart).
`allowedMentions` is parsed off by both posters so the channel does not ping a member every
time they are warned.

### I. A rank change did not trigger a role reconcile

`identity.link` and `identity.unlink` both mark the member dirty so auto-roles reconcile
within the next pass. `community.setMemberRole` — the rank change, which is the single most
visible input to the auto-role rules and the one a promoted member is *watching for* — did
not. It waited for the daily full sweep, up to 24 hours. One line, best-effort like the
other two, with the sweep still the backstop.

---

## Part 3 — Dead weight removed

Every export in `packages/moderation/src` was counted against its usages across the repo.
Exactly one had none:

- **`expiredButFlaggedActive`** (`expiry.ts`) — a helper that filtered a list of actions to
  those whose clock had run out while still flagged active. It never had a caller: the
  question it answers is asked of the database (`listExpiredActive`), not of an
  already-materialised list, because the list that would need filtering is the one nobody
  loads. Removed with its test; a comment records why so it is not re-added.
- **`"punishment-expiry"` in `RUNNABLE_JOBS`** (`packages/redis/src/adapters.ts`) and its
  workers schedule entry — see F.

Nothing else in the package was unused, disabled-but-present, or duplicated. The
moderation-adjacent commands in `commands-admin` were all reachable and all distinct; none
were removed. Two were *added* (`/unmute`, `/unban`) because their absence was the defect.

---

## Part 4 — QoL, evaluated

Scope discipline first: **no leveling/XP, no welcome-image generators, no engagement
gimmicks.** Nothing in that category was added.

| Asked for | Verdict |
| --- | --- |
| Reaction-role setup | **Already exists.** `/rolemenu` (list/post) with a self-service effector in the bridge bot and a full test file. Not duplicated. |
| Configurable mod-log embed formatting | **Built** — see H. Uses the existing `EmbedView` + `@sbr/discord-kit` style layer; the "configuration" is the channel slot, which was already in the panel and is now honoured. |
| `/modstats` or staff dashboard | **Already covered.** `@sbr/analytics` emits `mod.action`, `mod.action.failed` and `filter.hit`; `packages/panel-core/src/series.ts` charts them, and this branch adds the failure series. A Discord-side `/modstats` would be a second, thinner implementation of the panel's Moderation page. Not built. |
| Temporary/scheduled punishments with visible expiry | **Fixed and surfaced.** Expiry now actually lifts (F). `/audit in_force:true` lists what is live; the mod-log card and `/case` render expiry as a Discord relative timestamp, so every reader sees the countdown in their own zone. |
| `/case <id>` lookup | **Built.** `findAction(guildId, actionId)` down the stack (service → port → Prisma), rendered through the *same* `modLogEmbed` the log channel uses, so a case looked up months later reads identically to the card posted at the time — including whether enforcement took. Guild-scoped in the port so no caller can forget: an id from another server answers "no such case here" and reveals nothing. |
| Warn thresholds per guild rank | **Product decision — see below.** Per-*guild* thresholds already exist (`ESCALATION_SETTING_KEY`, layered over `DEFAULT_LADDER` by warn count). Per-*rank* does not, and is a policy question, not a bug. Not implemented silently. |

---

## Part 5 — Traces, written out

### Ban, from `/ban` to both surfaces

1. `commands-admin/handlers.ts` `ban` → `deps.moderation.applyAction({type:"BAN", …})`.
2. Guards: self-target; rank hierarchy (a target with no member row is treated as weakest —
   someone who already left is exactly who a ban is for); `botCaps.canPerform`.
3. `repo.createAction(...)` writes the row **PENDING**.
4. `enforce()`:
   1. `mirror()` — Redis key, so the bridge and dispatchers agree even if Discord refuses.
   2. `enforceDiscord()` — `guild.bans.create` via `GuildEffects.ban` (admin bot) or the
      loopback `/internal/g/:id/enforce` (bridge bot, web panel). **Awaited.** 50013/50001 →
      MISSING_PERMISSION, 10003/10007/10013 → NOT_FOUND.
   3. `relayToGame()` — `parseRelaySync` → row `BAN → g kick` → `ignFor(target)` →
      `resolveGameCommand` → `/g kick <IGN>` → `gameCommands.send`, which returns `false` if
      no bridge heartbeat reports `mcSpawned`.
5. Verdict: any failure → `FAILED` + a detail naming which surface and why;
   `metrics.actionFailed`; `repo.setEnforcement`; `alertStaff` (⚠️ message quoting the case
   id and reason); otherwise `CONFIRMED` + `metrics.actionApplied`.
6. `postModLog(settled)` — the card, after the verdict, so it can state it.
7. `applyAction` returns the settled action; `renderEnforcement` puts the verdict in the
   reply.

An unlinked target is `skipped` at 4.3, not failed — there is no IGN to kick, and that is
not a broken ban.

### Mute

Identical, with two differences: the duration guard rejects an unbounded `/mute` up front
(Hypixel chat mutes require one), and 4.2 is `member.timeout(ms)` clamped to Discord's
28-day ceiling while 4.3 sends `/g mute <IGN> <duration>`. `expiresAt` is stamped at write
time, which is what `reverseExpired` later reads.

### Automod-triggered mute

1. Bridge bot, message event → `automod-runner` → a rule matches.
2. `applyAction({actorDiscordId: AUTOMOD_ACTOR, type:"MUTE", …})`.
3. The hierarchy guard is skipped via `systemActorIds` — **this is finding D; before this
   branch the trace ended here with `TARGET_OUTRANKS_ACTOR`.**
4. Steps 3–7 above, with 4.2 going out over the loopback enforce endpoint since the bridge
   bot holds no privileged Discord writes of its own.
5. `filterHit` and `actionApplied`/`actionFailed` both recorded; the card lands in the
   guild's mod log naming the actor as **"Automod"** rather than a snowflake mention —
   which is, for the ~125-member guild this runs for, the only way staff see an automod mute
   happen at all.

### Expiry reversal

`punishment-sweep` (admin bot, 5 min, lock-guarded) → `reverseExpired()` →
`listExpiredActive` → per row,
`applyAction({actorDiscordId: EXPIRY_ACTOR, type: "UNBAN"|"UNMUTE"})` → the full trace
above, including `/g unmute` and a mod-log card reading **"Expired (automatic)"** →
`deactivateExpired` clears the flags **last**, so a reversal that failed is still owed and
still visible.

---

## Part 6 — Decisions for you, not guessed

1. **Discord kick → in-game?** `DEFAULT_RELAY_SYNC` maps `KICK → "none"`: a Discord kick
   does *not* `/g kick`. Enforced consistently everywhere and configurable per guild via the
   relay-sync rows. The rationale for the default is that a Discord kick is reversible in
   seconds (they rejoin with an invite) while a guild kick costs the member their guild slot
   and re-invite — but this is a policy call and the row is one edit away if you want it to
   mirror. **Nothing was changed here; flagging the current behaviour.**

2. **In-game guild kick → Discord: a real gap.** `recordInGameAction` in the bridge bot
   parses Hypixel's guild-chat notice, resolves IGN → Discord id where a link exists, and
   writes an audit row with `surfaces: ["GUILD_CHAT"]`. It deliberately does **not** mirror
   back into Discord — a staffer `/g kick`ing someone in-game does not kick them from
   Discord. So the sync is one-directional by construction. Adding the reverse direction
   would mean the bot taking Discord action off a parsed chat line with no confirmation of
   who typed it, which is a meaningfully different trust model. **Noted as a gap; not
   built.**

3. **Should a relay-only failure fail the whole case?** Today: yes — if `/g kick` cannot be
   delivered, the case is `FAILED` even though the Discord ban landed, and the detail string
   names which half worked. That is the safe default (it puts the case in front of staff)
   but it does mean a bridge outage marks otherwise-successful Discord bans red. The
   alternative is a per-surface status.

4. **The web panel has no `staffAlerts` sink.** A `FAILED` case raised from the panel is
   visible in the panel and in the mod-log channel, but nobody is *pinged*. The bots both
   alert. Wiring the panel would mean giving it a way to post to Discord, which today it
   does not have except through the loopback API. **Flagged, not built.**

5. **Per-rank warn thresholds** (Part 4). Per-guild exists. Per-rank means deciding whether
   an OFFICER's third warning does something different from a MEMBER's, which is a guild
   policy question. Not implemented.

---

## Verification

- `npx tsc -b` — clean across the whole monorepo.
- `npm test` (all workspaces) — green, **0 failures**.
  - `@sbr/moderation` — 136 pass. Every bug above has a test, including the relay-sync
    cases for ban → `/g kick`, an offline bridge, a Discord refusal, an unwired enforcer, an
    unlinked target, and the four expiry reversals.
  - `@sbr/commands-admin` — 69 pass (adds `/case` found, `/case` unknown, `/case`
    permission).
  - `@sbr/community` — 95 pass (adds the two rank-change reconcile tests).
  - `@sbr/app-admin-bot` 28, `@sbr/app-bridge-bot` 196, `@sbr/embed-gallery` 12.
- Copy keys for the three new commands added to `packages/brand-defaults`, which the
  gallery's "every command and option is behind a key" test enforces.

### The tests that would have caught the original bug

In `packages/moderation/src/service.test.ts`, enforcement block:

- *a BAN calls the Discord enforcer* — fails outright against the pre-branch composition.
- *a BAN relays `/g kick TargetIGN`*.
- *a BAN with the bridge offline is FAILED and alerts staff* — the exact reported symptom,
  now a red case and a staff ping instead of silence.

---

# Second pass — confirmation, mirroring, and case management

The first pass closed the Discord half of a punishment. This one is about the half that
happens in Hypixel, and about being able to see and correct either. Five things were asked
for: mirror in-game guild kicks back to Discord, sync immediately when a punishment is
issued, manage cases from the panel, require a reason on guild commands, and have some way
of knowing any of it worked.

## Part 1 — `/g kick` was sent without a reason

**Confirmed, root cause, fixed.** `RelayCommandInput` had no `reason` field and
`service.ts` never passed `action.reason`, so every relayed ban typed `/g kick Notch`.
Hypixel requires a reason and discards the line. The case recorded a guild kick that had
never happened — not a race, not an outage, a command that was *never once* going to work.

- `resolveGameCommand` now returns a three-way `GameCommandPlan` (`send` / `skip` /
  `blocked`) instead of `string | null`. The old `null` conflated "the mapping says do
  nothing" with "the mapping says do something and we cannot build it", and both landed as
  `NOT_REQUIRED` — the same silent-success shape as the original bug.
- `sanitizeGameReason` strips rather than rejects (moderation reasons are free text up to
  500 chars, guild chat is not), which also removes newlines and a leading `/`, i.e. chat
  injection. 64-char cap.
- `/g mute` keeps Hypixel's documented `<name> <time>` grammar. A trailing reason is parsed
  as part of the duration and refuses the line — so the reason goes on kick only.
- `/g kick` from the staff surface (`packages/screening`) now refuses an empty reason
  instead of sending a bare command that reported success.

**Deviation from the plan, deliberate:** the plan said an *unlinked* target on a mapped
action should be `blocked`. It is `skip`. Nobody verified the account, so the roles sync
never gave them a guild slot; there is genuinely nothing in game to act on, and alerting
staff every time a Discord-only member is banned would bury the alerts that matter. The
skip reason names the cause, so the mod-log card does not read as though the mapping had
no opinion.

## Part 2a — Nothing anywhere knew whether a command ran

**Confirmed gap, by design, now closed.** `RedisModBus` was one-way. `ModBusMessage`
carried a `correlationId` that was generated, transported, validated — and dropped at the
subscriber, which called `sink(message.guildId, message.command)`. `gameCommands.send()`
returning `true` proved only that a heartbeat had said `mcSpawned` up to 45 seconds ago.
Three separate copies of that check existed, all wrong in the same way.

- **Answer channel.** `chan:mod-ack:<guildId>` carries `ModAckMessage` with a validated
  `ModAckOutcome`. The bridge answers for every instruction it is handed.
- **`createGameCommandBus`** (`packages/moderation/src/game-relay.ts`) replaces all three
  hand-rolled publishers. Pre-flight on the heartbeat, publish, then wait for an answer on
  the correlation id. Transport is injected, so the moderation package still knows nothing
  about Redis.
- **`TYPED` is not a verdict.** The bridge saying it typed the line is exactly the old false
  success. It is remembered, not settled on, so a command Hypixel never comments on reports
  `UNCONFIRMED` rather than success — and a command that was never typed reports
  `TIMED_OUT` rather than the same thing.
- **A third enforcement state.** `EnforcementOutcome` gained `{ ok: true, pending: true }`,
  and an unconfirmed guild command leaves the row `PENDING` with a detail. Calling it
  CONFIRMED repeats the original bug; calling it FAILED alerts staff every time the queue
  is busy.
- **Nothing sits in limbo.** `settleStalePending` runs on the existing 5-minute punishment
  sweep and escalates any row still `PENDING` after 10 minutes to `FAILED` with the same
  staff alert a refusal gets. The grace period outlasts the bridge's own outbound queue,
  which holds a command for up to ten minutes waiting for a session.
- **The queue tells the truth about every entry.** `CommandQueue` gained `onSent`/`onExpired`
  hooks, and eviction-by-urgent-command now fires `onExpired` too. Exactly one hook fires
  for every command `push` accepted — without that, a displaced command costs its caller a
  full timeout.

Every one of these is a way a `/g kick` used to read as done: bridge offline, wrong guild,
queue full, aged out, displaced, typed-and-refused, or typed-and-ignored. They are now
seven distinguishable outcomes rather than one boolean.

## Part 2b — Hypixel refusing a command looked exactly like Hypixel running it

**Confirmed gap, now closed as far as it can be.** The delivery ack says the bridge typed
the line. Hypixel refuses a kick with no reason, a kick against a name it does not know,
and a kick by an account without the rank — and from the bridge's side all three look
identical to a kick that worked.

`apps/bridge-bot/src/command-echo.ts` watches guild chat for ten seconds after each
moderation command and settles it on the guild's own reply.

- Successes come from the existing `parseModNotice`, matched on kind **and** target.
- Refusals come from `HYPIXEL_REFUSALS`, a hand-collected table of strings Hypixel prints
  today. Each entry has its own test asserting the real line, and the test asserts the table
  length too, so a reworded entry cannot quietly stop matching while the suite stays green.
  **These strings are not versioned by Hypixel and will drift.** That is why an
  unrecognised window is reported *unconfirmed*, never as failure: an unrecognised line must
  not turn a kick that landed into a red case.
- A refusal names the command, not the player (`You cannot kick yourself` carries nobody to
  match on), so it settles the oldest command still waiting. Sound because the outbound
  queue is serial and paced at 1.2s.
- **Colour codes.** `mod-notice.ts` anchors with `^…$` and did *not* strip `§`, while
  `join.ts` did. Every coloured line from Hypixel — which is to say every real line —
  therefore missed every pattern. Lines are stripped before matching now, and there is a
  test for it.

**Deviation from the plan, deliberate:** the echo guard is in-process, not the
`sbr:relay:echo:kick:<guildId>:<ign>` Redis key the plan sketched. The bridge that types the
command is the same process that reads the notice it produces, so the guard and the
confirmation are the same piece of state; a cross-process key would only add a way for the
two to disagree. `CommandEcho.claimedKick` remembers our own kicks for 120s, and the
transport checks it before mirroring a kick notice — without which a Discord ban would relay
a `/g kick`, read its own notice back, and mirror it into a second punishment.


## Part 2c — The visible monitor

The user's words were "we need some kind of clear monitor that these commands have worked as
currently, we have nothing." That was accurate. Parts 2a and 2b produced a real verdict for every
relayed command; nothing rendered it anywhere a person would look.

Three surfaces, in order of how far they are from the incident:

**The mod-log card.** `enforcementField` (`packages/moderation/src/mod-log.ts`) used to print
`Enforced: DISCORD + GUILD_CHAT` for a CONFIRMED row and `Still in progress.` for a PENDING one.
The first implied success on a surface that had only been *typed at*; the second withheld the one
fact the reader wanted. Both now say what actually happened — a CONFIRMED row listing
`GUILD_CHAT` has been echoed back by Hypixel itself and says so, and a PENDING row carries its
detail. `/case` renders the same embed, so it picks this up for free.

**The bridge heartbeat.** `CommandQueue.stats()` already counted `queued/sent/dropped/expired/
evicted` and nobody read it. Folded into `BridgeStatus` as five flat numbers, which ride to Redis
verbatim through the existing status passthrough (`apps/bridge-bot/src/main.ts`). Flat because the
heartbeat carries `Record<string, string | number | boolean | null>`; no new plumbing.

**The relay log.** `RedisRelayLog` (`packages/redis/src/adapters.ts`) keeps the last 50 settled
commands per guild on `sbr:relay:log:<guildId>`, 7-day TTL, surfaced as a "Guild chat relay" card on
the panel's Moderation page: bridge live or not, the queue counters, and each command with its
outcome and detail.

**Deviation from the plan, deliberate.** The plan said LPUSH each ack. A command is acked twice —
`TYPED` when the bridge types it, then the guild's own verdict — so appending both would show
every kick twice while halving what the strip can remember. Instead one row per `correlationId`,
updated in place (`lSet`), which also means a command stuck at `TYPED` stays visible as a command
stuck at `TYPED` rather than scrolling away behind a verdict that never came.

The bridge holds a small `correlationId -> command` map (200 entries, evicted oldest-first) because
the ack carries the id and the outcome but not the text, and `REFUSED_INGAME` beside nothing is not
a monitor. It is populated before the sink is consulted, so a command rejected on the spot still
reaches the strip.

Everything on this path is best-effort and swallows its own failures. A receipt is worth less than
the command it is a receipt for, and no punishment should fail because Redis was briefly away. The
`enforcement` column on the moderation row remains the durable record; this is a window onto it.

## Part 3 — In-game kicks reach Discord

**Open decision #2 from the first pass, now closed.** `BridgeApp.recordInGameAction`
(`apps/bridge-bot/src/composition.ts`) hand-wrote a `moderationRepository.createAction` row and
stopped there. Its comment explained why, and the reasoning was sound: routing the notice through
`ModerationServiceImpl.applyAction` would have *issued* the punishment, relaying a `/g kick`
straight back into the game the notice came from — a kick echoing into a second kick.

The consequence was not sound. Somebody kicked from the Hypixel guild kept their Discord
membership, their roles and their access. There was no card, no alert, no enforcement column —
the only trace was a row on a page nobody had reason to open, and staff had to remember to do the
Discord half by hand. That is the same shape as the original bug this whole task started from: a
log that says "kicked" beside a person who is still here.

**The fix** is a new service method rather than a new caller of the old one:

`ModerationService.recordExternalAction(input)` — records rather than issues. It writes the same
row (`sourceContext: "INGAME"`, `active: false`), then carries out the Discord half, stamps a real
`enforcement` verdict, and posts the mod-log card. **It never touches the game relay**, which is
exactly the skip the bypass comment was protecting; the distinction the bypass kept by avoiding
the service is now kept inside it, where the guards and the alerting live.

`ExternalActionInput` is deliberately not an `ApplyActionInput`. The type is the documentation:
one is a record of something that has already happened, the other is an instruction.

**Guards, in order, each of them stamped on the row *and* said out loud to staff:**

| case | verdict | why |
|---|---|---|
| our own outbound kick | not recorded at all | `CommandEcho.claimedKick` (Part 2b), before this is ever called |
| MUTE / UNMUTE | `NOT_REQUIRED` | Hypixel holds it and Hypixel lifts it; the platform can do neither, and timing somebody out of Discord for a Minecraft guild mute is a punishment nobody asked for |
| target has no linked Discord account | `NOT_REQUIRED` + staff message | not a failure — there is no account to remove — but "kicked in game, still in Discord under a name we cannot match" is precisely the gap staff have to close by hand |
| target holds a staff role | `NOT_REQUIRED` + staff warning | an officer kicked in game is far more likely a mistake, a test, or a misused account than a decision to strip a staff member of their Discord access, and nothing on this path is waiting to notice and undo it |
| no enforcer wired | `FAILED` + alert | same treatment as everywhere else: a process that cannot punish anybody says so on the first action, not on the first appeal |
| Discord refused | `FAILED` + alert | the invariant |

The Discord kick is awaited through the existing `createBridgeEnforcer` loopback to the admin bot,
which owns privileged writes.

**A second gap found while wiring this.** The bridge process had no `StaffAlertSink` at all — only
the admin bot did. Every automod enforcement failure in that process has been a line in a log file
and nothing else. It matters more now, because the mirror runs here and every case it declines to
mirror is a member still sitting in Discord: nobody typed anything, so nobody is waiting for a
reply, and the alert is the only way anyone finds out. A sink was added, posting to `staff` then
`modlog` through the existing mod-log poster.

## Part 4 — Immediate full sync

`applyAction` already awaited mirror → Discord → game inline, and after Part 2a the game leg blocks
on a real in-game ack rather than on a publish, so the verdict stamped on the row now reflects what
Hypixel did. One thing was still deferred: auto-roles.

`enforce()` now calls `rolesDirty.mark(guildId, [targetDiscordId])`, the same marker
`packages/community` and `packages/identity` already use, wired at all three composition roots. A
ban changes what roles somebody should hold and a mute changes what the reconciler should be
granting; without the mark, both waited for the next full sweep — the punishment landing on one
surface immediately and on another whenever the sweep next came round.

Marked before either surface is touched, and failures are swallowed, because a mark is a
promptness hint: the reconciler's daily full sweep is what makes the answer correct regardless.
Nothing should fail a punishment because Redis was briefly unavailable.

## Part 5 — Correcting a case from the panel

**The gap.** `ModerationAction` was append-only at every layer. There was no `updateAction` in the
repository, no port method, no mutation, no control. Staff could create a case and read it back;
nothing could fix one. That is not a missing convenience — an audit log nobody can correct is an
audit log that gets worked around. The wrong reason stays wrong. The mistaken ban gets lifted by
hand in the Discord client, where the case log never hears about it, and the row goes on saying
"banned" about somebody who is not banned. That is the same divergence between the log and reality
this whole audit was opened over, arriving by a different route.

**Schema** (`20260825180000_moderation_case_edits`): four nullable columns —
`updatedAt`, `editedByDiscordId`, `voidedAt`, `voidReason`. `updatedAt` is deliberately *not*
Prisma's `@updatedAt`: it means "a person corrected this", and an automatic stamp would fire on the
sweep's own expiry writes, making every row look hand-edited.

**Repository.** `updateAction(guildId, actionId, patch)` follows `bridge.ts`: `updateMany` scoped by
`{ id, guildId }`, never `update` by primary key. A case id pasted from another guild must read as
"no such case", not as a write to somebody else's server.

**Service — four operations, because they are four different acts:**

| operation | what it does | tier |
|---|---|---|
| `updateAction` | corrects reason and/or duration. A changed duration recomputes `expiresAt` from `createdAt`, then re-runs `mirror()` so the enforcement cache TTL follows | `MODERATOR`, re-checked for `ADMIN` before a duration |
| `setEnforcementManually` | records what actually happened, for "I did this by hand" | `ADMIN` |
| `retryEnforcement` | re-runs the real `enforce()` on the stored row and restamps from the result | `ADMIN` |
| `voidAction` | withdraws the case — **and issues the compensating `UNBAN`/`UNMUTE` through `applyAction` when the row still holds enforcement** | `ADMIN` |

That last clause is the invariant, pointed the other way: a void that only wrote `voidedAt` would
produce a log reading "withdrawn" about somebody still banned. `PunishmentState` gained `VOID`, and
`mod-log.ts` now renders a voided case neutral rather than red, with its stated why on the card.

**A duration is re-timed from when the punishment started, not from now.** Shortening a 24h mute to
2h four hours in expires it immediately, which is what "make it two hours" means. Re-timing from
`now` would hand the member six hours total and read as a correction that made the punishment
longer.

**Deviation from the plan (4 of 4).** The plan offered `expiresAt` as an editable field alongside
the duration. It is not exposed. The server derives it; two controls that could disagree about when
a mute ends is the divergence this audit exists to remove, and offering both would have rebuilt it
inside the fix.

**`PENDING` is not a status a person may declare.** It is on the wire and on the row, but the panel
will not set it. A case a human marks pending re-enters the sweep's escalation queue and is stamped
`FAILED` out from under them ten minutes later — a worse lie than the one they were correcting. The
three settled answers are offered; a row already sitting in `PENDING` can display it but not
re-select it.

**Panel.** Four mutations (`moderation.case.update` / `.enforcement` / `.retry` / `.void`), four
routes, and a per-case card on the Moderation page opened from a Manage button on each row — one
open at a time, since these controls change a punishment somebody is currently serving. Each field
writes only itself, the wordlist card's idiom. Void is armed by two clicks and requires a stated
reason. Voided cases render as a closed record with no controls at all.

Audit `change` payloads carry `reasonLength`, never the reason text, following `upsertWordlistRule`:
a staff note about a member belongs on the case, not in whatever aggregates the audit stream.

**The case table now carries an enforcement badge** beside the state badge. They answer different
questions — what the case is now, and whether it ever actually happened — and a row that said `BAN`
and nothing else is the exact shape this audit began with.

# Third pass — closing the link-to-role delay

The complaint: somebody links their Hypixel account and waits up to fifteen minutes for the roles
that linking is supposed to earn them. Confirmed, and it was not a bug — `packages/roles` resolves
what a member should hold, but the only thing that ever *applied* a resolution was the sweep in
`packages/jobs`, so the delay was the design.

## Part A — An immediate pass, alongside the sweep and not instead of it

**The trigger is the mark, not the caller.** Every place that ought to nudge already marks the
member dirty — identity link and unlink, `guild-scan` rank changes, milestone rewards, community
writes, moderation. So `RedisRoleDirtySet.mark` publishes on the new `chan:role-nudge` after its
`SADD`, and the workers answer it. That covers every one of those paths with no change to a single
domain package, and there is no second list of "places that should nudge" to fall out of date with
the list of places that mark.

**Ordering is load-bearing.** The mark is written *before* the publish. A worker that heard the
nudge first could reconcile the member, find nothing, and only then have the changed fact recorded
— correct, and fifteen minutes late, which is the delay the channel exists to remove. There is a
test that monkey-patches `publish` to assert the mark is already visible.

**The immediate path runs the sweep's own code.** `syncOneMember` calls `syncMember`, unchanged:
same policy load, same `diffGrants`, same effector, same ledger write, same attribution. Two copies
of that logic would have been two ways for a role to be granted, only one of them audited the way
`WORKERS.md` claims.

**It never touches the dirty set.** The mark stays where the publisher put it and the fifteen-minute
pass is what removes it. That is what makes a dropped nudge — published while the workers were
restarting, refused by a full queue, or failed against Discord — cost latency and nothing else.

`guildMemberAdd` marks and returns. It does not write a role. A gateway handler calling
`member.roles.add` would be a way around the effector's preflight, which is the thing that refuses
Administrator, Manage Roles and Ban Members grants.

## Part B — Idempotency, and why the second pass is a no-op rather than a duplicate

Two tests cover the two honest cases. Once the roster mirror reflects the applied role, the sweep's
diff is empty and it makes no Discord call at all. While the mirror is still behind, it re-asserts
the same role and revokes nothing.

**Finding, and it is not where the plan assumed.** The re-assert does not create a second grant row,
but the partial unique index is not what stops it — `diffGrants` puts the role in `add` and *not* in
`grant` when the open ledger already accounts for it, so `recordGrants` is never called with it. The
index's `skipDuplicates` is a second line, not the first. The test asserts one recorded grant and
says so, because a future reader looking only at the DB constraint would draw the wrong conclusion
about where the guarantee lives.

Failures are not retried in place. A reconcile that fails logs and stops; the mark is still there
and the sweep owns the retry. Nothing is surfaced to the member who triggered it.

## Part A, continued — pacing, and a bug the burst test found

Discord's per-guild role bucket is roughly ten modifications per ten seconds, one member can cost
two calls (an add and a remove), and there is no batch role-add endpoint. `packages/jobs/src/role-nudge.ts`
is a per-guild token bucket in front of the immediate path.

**The first tuning was wrong, and the test caught it rather than the review.** With a burst of 3 and
a 2s refill, the first ten-second window carries the burst *plus* a full window of refills — eight
members, about sixteen calls against a bucket of ten. The assertion "no more than four members per
ten-second window" failed at seven and the number was real, not the assertion being strict. Retuned
to a burst of 1 and a 2.5s refill: at most four members and eight calls in any window, at the cost
of spreading twenty simultaneous links across the following minute. A larger burst quietly exceeds
the limit the bucket was added to respect.

Past 50 waiting members per guild, nudges are refused with a `role nudge dropped` warning — at that
size the immediate path has nothing to offer over the sweep, and everyone refused is still marked
dirty. A mark covering more than 25 members at once is a roster-wide rescan and is not nudged at
all, for the same reason.

`InMemoryRateGate` in `packages/hypixel` was considered as a basis and rejected: it is
header-driven (`observe(headers, status)`), reacting to what an API told it, not a bucket that
paces ahead of a limit nobody reports back.

## Part C — The premise does not hold, so nothing was built

The task asked to identify the leaderboard cache layer and invalidate it on a contributing event.
**There is no cache layer.** `LeaderboardService.page()` and `positions()` call
`LeaderboardSource.values()`, implemented by `leaderboardSource` at
`packages/db/src/repositories/leaderboards.ts:248`, which queries Postgres directly on every read.
`grep -rn "cache" packages/leaderboards/src` returns nothing, and `packages/redis/src/keys.ts` has
no leaderboard key.

So the acceptance criterion — *leaderboard reads reflect recent changes promptly without synchronous
recomputation in any gateway handler* — is already met, on both halves. Building a cache purely so
that it could be invalidated would have introduced staleness where there is none today, and a new
class of bug (a missed invalidation) in exchange for nothing. Flagged here rather than worked
around, and written into `DISCORD_QOL.md` so the next person who looks for the cache finds the
answer instead of the absence.

If leaderboard reads ever become a measured cost, the shape to add is a Redis key per category
invalidated by the same mark-and-move-on rule used here — but that is a performance change with a
measurement behind it, not this task.

## Part D — Written down, including the reasons not to "fix" it

`WORKERS.md` §2.7d and the job catalogue, `DISCORD_QOL.md` §2, and `REDIS_KEYSPACE.md` (the topic
list and a section for `chan:role-nudge`) now describe both paths. Each says explicitly why the
sweep must keep running: revocation is only safe because something eventually reconciles members
nothing happened to; a dropped gateway event heals; a rule written today is retroactive and has no
event to replay.

**Why XP stays batched, stated where a contributor will hit it.** Marking a member dirty on each XP
award would nudge on every chat line in the server and spend the guild's whole role budget
discovering that nobody crossed a level boundary. The daily re-derive is what makes `XP_LEVEL` rules
correct; a level-up worth rewarding promptly is a milestone, and milestones already mark.

---

## Part E — The nudge fired, and granted nothing (reported from live use)

The immediate-sync work above was tested against a real `/link` by a member who was already in the
Hypixel guild, and no in-guild role arrived. The nudge was not at fault; it did exactly what it was
built to do. The fault was that the fact it triggers a reconcile to read is not yet true at the
moment it fires.

### E1. `inGuild` cannot be true at link time — **root cause**

`loadSnapshots` (`packages/db/src/repositories/role-sync.ts`) derives the fact an `IN_GUILD` rule
evaluates as:

```ts
inGuild: member.status === "ACTIVE" && member.guildRank !== null,
```

`GuildMember.guildRank` has exactly three writers, all in `maintenanceJobRepository` — `applyJoined`,
`applyLeft`, `applyRankChanges` — and all three are reached only from the `guild-roster-sync` job.
That job reconciles Hypixel's roster against `listStoredRoster`, which skips anyone without a
verified link (`if (!account) continue;`).

So the roster pass cannot have written a rank for somebody who was not linked until a second ago.
At the instant `/link` completes and `markMember` fires the nudge, `guildRank` is still `null`,
`inGuild` is `false`, and an `IN_GUILD` rule grants nothing. A `LINKED` rule would have fired
instantly — which is why the path looked correct in every test that used one.

### E2. And the mark is then spent for nothing — **the reason the delay was a day, not half an hour**

The nudge deliberately does not drain the dirty set, but the 15-minute `role-sync` sweep does. The
worst case ran:

| time | what happened | `inGuild` |
|---|---|---|
| `:10` | `/link`, member marked dirty, nudge reconciles | `false` |
| `:11` | 15-minute sweep drains the mark, reconciles again | `false` |
| `:39` | `guild-roster-sync` writes `guildRank` — **and marks nobody dirty** | `true`, unread |
| next day | daily full sweep finally reconciles everyone | granted |

`guild-scan` marks its own joined/left/rankChanged diff dirty; `guild-roster-sync` did not. And a
player already in the Hypixel guild who merely links is none of joined, left or rank-changed from
`guild-scan`'s point of view, so that path could not have covered it either.

### E3. The owner account is not a factor — **checked and ruled out**

`refuseRole` (`apps/admin-bot/src/role-preflight.ts`) decides purely from role facts —
`BOT_LACKS_MANAGE_ROLES`, `UNKNOWN_ROLE`, `EVERYONE`, `MANAGED`, `DANGEROUS_PERMISSION`,
`ABOVE_BOT`. There is no clause about the target member, and Discord's owner immunity covers
kick/ban/timeout, not role assignment. Adding a role to the server owner is an ordinary grant.

### E4. Fix — adopt the cached rank at link time

`roleSyncRepository.adoptCachedGuildRank(guildId, discordId)` reads `GuildMemberCache`, which the
roster pass already filled and which is keyed `(guildId, uuid)` — the same roster, already fetched,
just not yet joined to this member because they had no link when it ran. `memberRoleDirtyMarker`
calls it **before** `sink.mark`, never after: the reconcile the mark triggers reads the member's
facts once, so a rank adopted afterwards is a fact that arrived too late to be used, which is the
whole bug restated.

Deliberately narrow, and the narrowness is the point:

- It fills a `null` and never overwrites a rank. A stored rank that disagrees with the cache is
  `guild-roster-sync`'s argument to settle; a cache up to six hours old has no business winning it.
  Both the read and the write are guarded on `guildRank: null`, the write so two concurrent links
  cannot both decide they are the one setting it.
- It does not touch `status`. Resurrecting a member somebody recorded as departed is a far worse
  mistake than waiting half an hour for the roster pass.
- It does not redefine `inGuild`. Loosening that check to `linked` would qualify every linked
  stranger for an in-guild role; the fix makes the existing fact true earlier, and that is all.

### E5. Safety net — the roster pass now marks who it wrote about

`RosterSyncResult` carried three counts. A caller handed three numbers cannot tell role sync whose
facts moved, which is why step `:39` above marked nobody. It now also carries `touched`: the uuids
this pass actually wrote about, deduplicated across joins, departures and rank changes, and empty
whenever the departure guard tripped and nothing was applied. The `guild-roster-sync` job resolves
them through `discordIdsForUuids` and marks them dirty, exactly as `guild-scan` already did.

This is a second, independent path to the same grant: E4 covers the member who links after the
roster already knew them, E5 covers the member the roster learns about after they linked. Both are
best effort by design — the daily full sweep stays the floor under them.

### E6. Verification

`packages/db/src/repositories/role-sync.test.ts` is new. These are database reads with no Postgres
on the build host, so — following the precedent in `schema-shape.test.ts` — the claims are asserted
against the repository source: that the adoption happens before the mark and not after, that both
guards on `guildRank: null` are still present, that the write touches no other column, and that
`inGuild` still means a rank the roster wrote rather than merely a link.
`packages/jobs/src/maintenance.test.ts` gains two cases: a normal diff names the joiner, the
rank-changed member and both departures while leaving out the member nothing happened to, and a
refused pass names nobody.

**Still unverified against a live guild.** The Hypixel API key outage recorded in the earlier audit
is still in force, so the end-to-end check — link a member the roster already knows and watch the
role land within seconds — has not been run.
