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
