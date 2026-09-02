# Command Inventory — as built

Every command that exists in code today, across both bots and the in-game
surface, with what it does and what it replies with. This is a **descriptive**
document: it reports the registries as they are, not as they should be.
`COMMANDS.md` is the **prescriptive** spec, and the two have drifted — §5 at the
end lists every difference, which is the working list for the tightening pass.

Sources of truth for this file:

- `packages/commands-bridge/src/handlers.ts` — the member registry, including the
  per-feature specs spread into it (`progression`, `remind`, `tag`, `fun`, …)
- `packages/commands-bridge/src/handlers-community.ts` — the community specs + 2 button routes
- `packages/commands-bridge/src/ingame.ts` — the `!` surface and its aliases
- `packages/commands-admin/src/handlers.ts` — the staff registry
- the two dispatchers, for the gates every command passes through

**Totals: 54 member specs, 41 staff specs, 22 reachable in-game, 2 button routes.**
Counted from the built registries rather than by hand; the section tables below
have drifted behind them and are being brought up to date a slice at a time.

**Twenty-two of the 54 are retired** (`enabled: false`): `/verify`, `/goal`,
`/progress`, `/snapshot`, `/missing`, `/nextupgrade`, `/whatnext`, `/lfg`,
`/runs`, `/joinrun`, `/leaverun`, `/editrun`, `/closerun`, `/cringe`, `/stats`,
`/slayer`, `/guildquote`, `/rank`, `/tag`, `/create-event`, `/rsvp`,
`/attendance`. They are absent from Discord's registry, refused by the
dispatcher, and silent in guild chat — but still in `buildBridgeRegistry()` with
their handlers intact, which is why they are still counted and still described
below. **32 member commands are actually reachable, and 18 in-game** (`lfg`,
`runs`, `cringe` and `events` leave that surface with them; the three
progression commands are replaced there by `/progression`, one where there were
three). `COMMANDS.md` explains why each went. The rows below describe behaviour,
not availability.

---

## 1. How a command is gated

The two bots gate differently, and the difference matters for the redefinition.

**Bridge bot** (`CommandDispatcher`) — spec lookup → capability → cooldown →
handler → usage capture. Never throws.

- **Capability** is checked only when the spec declares one. Exactly ten do
  (`RUN_COMMAND`): `stats`, `skills`, `slayers`, `dungeons`, `networth`,
  `missing`, `nextupgrade`, `whatnext`, `create-event`, `lfg`. The other 23 are
  ungated — any member can run them. Denial reads *"You don't have permission to
  use that command."*
- **Cooldown** is per `surface:command:user` in Redis, from the spec's
  `cooldownMs`. Denial reads *"Slow down — try that again in Ns."*
- **A throwing handler** returns the upstream-unavailable message when the cause
  is an unreachable data source, otherwise the generic failure — *"That didn't
  complete. Run `/health` to see whether the platform is up."* — with a button
  opening the permanent bug-report ticket category. Both replies are built by
  `failureReply` in `@sbr/embed-kit`, shared with the admin dispatcher.
- **Autocomplete deliberately skips both gates** (Discord's 3s budget, and one
  request per keystroke would burn the cooldown before the command ran).

**Admin bot** (`AdminDispatcher`) — spec lookup → role tier → destructive
confirmation → handler.

- **`minRole`** is compared by `rankOf`. Denial reads *"That command requires
  {ROLE} or higher."* The `ModerationService` re-checks rank authoritatively, so
  the dispatcher gate is the fast path, not the only one.
- **`destructive: true`** requires `confirm:true` in the same invocation, else
  *"⚠️ /{name} is destructive. Re-run with confirm:true to proceed."* Four
  commands carry it: `ban`, `kick`, `purge`, `lockdown`.
- **A throwing handler** returns the upstream message, or *"That action failed
  unexpectedly — nothing was changed."* — kept apart on purpose, because
  "nothing was changed" is a claim.

Every dispatch on both bots writes a `CommandUsage` row (surface, command,
success, latency), best-effort.

---

## 2. Bridge bot — member commands (33)

`player?` defaults to the caller's linked account; unlinked and no `player`
given replies with the NOT_LINKED failure. `profile?` defaults to the member's
selected profile. Non-ephemeral replies carry both an embed and a flat `text`
line — the text is what the in-game surface renders.

### 2.1 Account & identity

| Command | Options | CD | Purpose | Output |
|---|---|---|---|---|
| `/link` | `ign?` | 10s | With an IGN, bind a Discord account to it by matching Hypixel's Discord social field against the caller's handle. With none, re-check the account already on file — what `/verify` did | Ephemeral `Linked to **{ign}**.`, `Still linked as **{ign}** — the check passed.` on a re-check, the linking steps when there is neither a link nor an IGN, or the specific link failure (social unset, mismatch, already owned) |
| `/verify` | `ign?` | 10s | **Retired** — folded into `/link`. Re-ran the same social check; with no argument it re-checks the account already on file — the repair path for a stale link | Ephemeral `Verified as {ign}. ✅`, or `Nothing to verify — use /link <ign> first.` |
| `/unlink` | — | 10s | Drop the caller's linked account | Ephemeral `Unlinked {ign}.` |
| `/me` | — | 10s | The caller's own summary; never accepts a player | **Ephemeral** stats embed (skills, slayers, dungeons, networth, and — when XP is wired — a guild standing line reading level, total XP and tenure) |
| `/profile` | `player?` `profile?` | 10s | With `profile:` shows that one; without, lists every profile on the account so the member can see what `/setprofile` accepts | Profile embed, or profile-list embed |
| `/setprofile` | `profile*` (autocomplete) | 10s | Choose the profile all the caller's lookups default to | Ephemeral `Your lookups now default to {name}.`; `No profile called "x" on your account.` when unknown |

`/setprofile` autocomplete suggests the caller's own profiles by cute name, and
degrades to an empty list on any failure (not linked, Hypixel down) rather than
erroring.

### 2.2 Stats & progression

| Command | Options | CD | Cap | Purpose | Output |
|---|---|---|---|---|---|
| `/stats` | `player?` `profile?` | 15s | ✔ | Broad overview — one profile fetch backs four parallel reads | Stats embed; text `{ign}: SA 45.3, cata 42, nw 8.2b` |
| `/skills` | `player?` `profile?` `skill?` | 15s | ✔ | Twelve skills as two lists — the ones the average counts, then the cosmetic ones — plus the uncapped skill closest to its next level. Naming one skill gets that skill in full, with a bar. Capped skills carry the shared marker and are counted in the headline | Skills embed; text `{ign}: skill average N` |
| `/slayers` | `player?` `profile?` `boss?` (6 choices) | 15s | ✔ | Slayer XP, tiers and per-tier boss kills — every boss carries its own tier breakdown, running to the boss's ceiling rather than to the highest tier killed. Naming one boss narrows to it | Slayers embed; text `{ign}: N slayer xp` |
| `/dungeons` | `player?` `profile?` | 15s | ✔ | Catacombs level and progress to the next, class levels and average, completions per floor (`F…` normal, `M…` master), fastest S+ | Dungeons embed; text `{ign}: catacombs N` |
| `/networth` | `player?` `profile?` | 15s | ✔ | Networth estimate; every value-bearing category as one column, richest first, each with its share of the total. A dropdown opens any category that can be itemised, listing its ten most valuable items against a fresh read | Networth embed; text `{ign}: {total}` |
| `/milestones` | `player?` | 15s | — | Guild achievements + standing: earned (top 5) and closest unearned (top 5) w/ progress | Achievements embed; text `{ign}: N/M achievements · next: {label}` |
| `/progression` | `metric?` (free text, matched against the guild's offered set) `range?` (7/30/90, default 30) | 15s | — | The **caller's** own numbers: the chart, the goal on the charted metric, and the markers behind both. Requires a link | Progression card + metric menu, window buttons, and `Save marker` / `Set goal` / `Clear goal`; text `{ign}: Networth over 30d — +N` |
| `/progress` | `metric?` (4 choices) `range?` (1–365, default 30) | 15s | — | **Retired.** The **caller's** progression over time; requires a link | Progress embed; text `{ign}: networth over 30d — +N` or `not enough history` |

`/progression` takes the metric as free text rather than as choices: the offered
set is guild configuration (panel → Milestones → *Charted metrics*) and Discord
choices are fixed at registration. An unrecognised metric falls back to the first
the guild offers, and the card's menu is the discoverable list. The retired
`/progress` fell back to `networth` the same way.

### 2.3 Optimization

| Command | Options | CD | Cap | Purpose | Output |
|---|---|---|---|---|---|
| `/missing` | `player?` `profile?` | 30s | ✔ | Notable accessories absent, plus held ones a better family member supersedes | Accessories embed; text `{ign}: 1,240 MP, 8 missing` |
| `/nextupgrade` | `player?` `profile?` `focus?` (7 choices, default general) | 30s | ✔ | Highest-value upgrade to buy next | Advice embed; text is the top item's title, or `nothing obvious to improve.` |
| `/whatnext` | `player?` `profile?` `goal?` (6 choices, default general) | 30s | ✔ | Suggested next progression steps | As above |

### 2.4 Economy

All four resolve free text through the item catalog rather than trusting the
raw string, because the option is typeable and someone can submit before an
autocomplete suggestion lands. Unknown text → `No Skyblock item matching "x".`

| Command | Options | CD | Purpose | Output |
|---|---|---|---|---|
| `/price` | `item*` (autocomplete), window via buttons | 5s | The whole market for one item: both books, volume, and a Coflnet-backed price chart over 24h / 7d / 30d, with the current price stated against that window's average. One book missing is not an outage — most items trade on exactly one. A history outage costs the chart, never the prices | Market embed (`Right now` / `Moving` / `History`) + window and **Listings** buttons; text `{item}: {coins} ({book}) · {trend}` |
| ~~`/bazaar`~~ | — | — | **Deregistered** (`enabled: false`) into `/price`, which carries the whole order book rather than the buy half. `!bz`/`!bazaar` route to the market card | — |
| ~~`/lowestbin`~~ | — | — | **Deregistered** (`enabled: false`) into `/price`, which carries the lowest BIN *and* the listing count behind it. `!lbin`/`!lb`/`!lowestbin` route to the market card | — |
| `/auctions` | `player?` | 15s | A player's own auctions, split into sold-unclaimed (with the coins waiting), expired-unsold and active; already-collected auctions are dropped. The `item:` half moved to the **Listings** button on the `/price` card | Auctions embed; text `{ign}: N active · X to claim · N expired` |

### 2.5 Guild & meta

| Command | Options | CD | Purpose | Output |
|---|---|---|---|---|
| `/help` | — | 3s | Read off `buildBridgeRegistry()` and grouped by each spec's `category` into six buckets: Your account / Your numbers / The market / The guild / Events / Everything else. Retired commands are filtered by the same `enabled` flag that deregisters them | Ephemeral card, headline naming the caller's next step (link, or that they already have), plus a "How do I link?" button showing the platform's steps and the guild's configured walkthrough |
| `/online` | — | 30s | Guild roster read live from the Mineflayer session (the Hypixel guild endpoint carries no presence), with each member's current session length | Roster embed by rank, each name followed by elapsed time (`+` = adopted from a roster read, so a floor). **Two failures kept distinct**: no bridge configured here (permanent) vs bridge offline right now (retryable) |
| `/standing` | `member?` (user) | 10s | Guild XP, level, rank and the per-source breakdown behind it | Standing embed; text `{name}: level N ({xp} xp)`. **Public for yourself, ephemeral for anyone else** |

| `/leaderboard` | `category?` (choice of 8), `page?`, `days?` | 15s | Guild rankings over wealth, tenure, skill average, catacombs, slayer, Discord activity, guild chat and XP | Ranked embed with the caller's own row appended; text = top five on one line |

`/leaderboard` ranks **only active members**, and **only positive values** —
zero and unknown are both absent from a board rather than sitting at the bottom,
because "no data" and "worst in the guild" are different claims. Ties share a
rank (1, 2, 2, 4) and the footer quotes the **oldest** reading on the page, not
the newest. The four snapshot-backed boards are keyed by Minecraft uuid, so an
unlinked caller gets the board but no "you are here" line. Full rules in
`COMMANDS.md` §19.

Standing is a **section of `/me`**, not a command of its own (`COMMANDS.md`
§18). It is keyed by **Discord id, not IGN** — XP is attributed to a person on
the platform, so an unlinked speaker has none to report. Three answers are kept
apart on purpose: XP not wired here leaves the section off the card entirely, a
member with no ledger rows is told so in words (never "0", which would be a
different and untrue claim), and everyone else gets the breakdown. Someone
else's standing is one line on the private half of `/whois`, because printing a
member's rank into a channel on request invites exactly the comparison nobody
asked for.

`/online` is Discord-only by design — in-game the answer is `/g online`, which
costs the bridge account nothing. The 30s cooldown and the transport's shared
cache exist because a spammed `/g online` gets the bridge account silenced,
which takes the whole relay down. Playtime is read from the in-memory tracker,
which costs nothing per invocation — the card's cost is still one cached roster
read.

### 2.6 Events & RSVP — **all four retired (`E-01`)**

An event is one message now. It is posted into the events channel when the event
is created, it carries the roster and the three RSVP buttons while signups are
open, it becomes the standings in place when the event starts, and it is edited
once more into the result. Nothing has to be listed, quoted by id, or asked
about, so the four commands that did those things have no question left to
answer: the channel answers `/events` and `/attendance` without being asked,
the buttons answer `/rsvp`, and creation moved to the panel — the only surface
that can offer the activity choice this command could not.

Marking who actually *turned up*, as opposed to who said they would, is a
different question and a staff one. It stays on the panel's events page, beside
the tracker's own observations.

The rows below describe what the handlers still do, since they are flagged
rather than deleted.

| Command | Options | CD | Cap | Purpose | Output |
|---|---|---|---|---|---|
| `/events` | — | 10s | — | Upcoming guild events | Events embed; text is the first 5 as `title — startsAt`, or `Nothing scheduled right now.` |
| `/create-event` | `title*` `starts_at*` (ISO string) `type?` (7 choices) `capacity?` (1–200) `description?` | 30s | ✔ | Schedule an event; host is the caller | Public event embed **with RSVP buttons**; text `Created "{title}" (id {id}).` |
| `/rsvp` | `event*` `response?` (Going/Maybe/Can't) | 5s | — | Respond to an event | Ephemeral event embed; `Recorded: going for "{title}".` or `"{title}" is full — you're on the waitlist.` |
| `/attendance` | `event*` | 10s | — | Who has responded | Attendance embed; text `{title}: 8 going, 2 maybe, 1 waitlisted.` |

Event errors are worded per case: not found, already finished/cancelled, only
the host may cancel, or the service's own `INVALID_TIME` detail.

### 2.7 LFG

| Command | Options | CD | Cap | Purpose | Output |
|---|---|---|---|---|---|
| `/lfg` | `activity*` (6 choices) `slots?` (2–20, default 5) `details?` | 60s | ✔ | Open a run. Fixed 2h expiry so `/runs` doesn't fill with dead parties | Public LFG embed **with join/leave buttons**; text `dungeons run open — 1/5 (id X).` |
| `/runs` | `activity?` | 10s | — | Open LFG posts | List embed; text `dungeons 3/5 | slayers 2/4`, or `No open runs right now.` |
| `/joinrun` | `id*` | 5s | — | Take a slot | Updated LFG embed + buttons; text `Joined — 4/5.` |
| `/leaverun` | `id*` | 5s | — | Give up a slot | `Left — 3/5.` |

LFG errors: not found, full, closed, already joined, not a member, and
`AUTHOR_CANNOT_LEAVE` — *"You started this run, so you can't leave it — the run
closes when it expires."*

### 2.8 Tickets

| Command | Options | CD | Purpose | Output |
|---|---|---|---|---|
| `/ticket` | `action?` (open/list/close, default open) `type?` (autocompleted from the guild's menu) `category?` (deprecated, the 5 fixed choices) `subject?` `id?` `reason?` | 30s | One command, three actions | All ephemeral. open → `Opened {type} ticket {id}. {the type's prompt, or "Staff will pick it up."}`; an unknown type lists the keys on offer, and a guild with every type switched off gets `Tickets aren't open here right now.`; list → the caller's own tickets only (seeing everyone's would leak reports and appeals); close → `Closed ticket {id}.` |

`type:` is autocompleted rather than a fixed choice list because the menu is per-guild and editable at any time, while slash-command choices are frozen at registration — a guild adding a type would otherwise need the whole command re-registered before anyone could pick it. Guilds that have configured nothing see the five built-ins (`support`, `report`, `appeal`, `application`, `other`), which are exactly the old `category:` values, so `category:` keeps working unchanged.

### 2.9 Button routes

Both go through the same functions as their slash commands, so the two surfaces
cannot drift.

| Custom id | Purpose |
|---|---|
| `rsvp:{eventId}:{state}` | Identical to `/rsvp`; the state segment is validated against the four RSVP states before it is trusted |
| `run:{postId}:join\|leave` | Identical to `/joinrun` / `/leaverun`; anything else replies *"That button isn't valid any more."* |

---

## 3. In-game surface (`!`) — 15 commands

A translation layer over the same dispatcher, not a second implementation. What
it adds: prefix parsing, positional→named argument mapping, an allow-list, IGN
identity, a stricter per-IGN cooldown, and collapsing a rich reply to one line.

- **Allow-list is the authorization boundary.** Only specs carrying `inGame`
  are reachable: `help`, `profile`, `stats`, `skills`, `slayers`, `dungeons`,
  `networth`, `price`, `events`, `runs`, `leaderboard`
  (all `true`), and
  `lfg` and `standing` (`"linked"` — `lfg` is the only in-game write and is
  attributed to its author, and `standing` is keyed by Discord id, so both need
  the speaking IGN to resolve to a Discord account first). Everything else is
  silently unknown; naming Discord-only commands would just invite attempts.
  `!standing` takes **no positional argument** — guild chat proves which
  *player* is speaking but not which Discord account they mean by a name, so it
  only ever answers for the speaker.
- **Silence is the default answer** — a non-command, an unknown word, or a
  cooldown all reply with nothing rather than chat noise Hypixel counts against
  the bridge account. A bare prefix and `! stats` (space) are not triggers.
- **Cooldown** is `max(spec.cooldownMs, 10s)` per `cd:ingame:{cmd}:{ign}`,
  checked *before* identity so a spamming IGN costs no DB lookup.
- **Unlinked players still get public lookups**, under a placeholder id. Only
  `lfg` refuses, and it names the fix: *"Link your account on Discord first
  (/link {ign}) to use !lfg."*
- **Missing required options** get a usage hint: `Usage: !price <item>`.
- **Output** is one line, ≤252 chars (256 packet limit minus `/gc `), embed
  preferred over text because it carries the numbers, fields joined with ` | `,
  the staleness footer preserved, Discord markdown/mentions/timestamps
  flattened, and truncation cutting on a separator so a line never ends
  mid-number.

**Aliases:** `nw`→networth, `bz`/`lbin`/`lb`/`bazaar`/`lowestbin`→price (the
shorthands outlived the commands they were short for), `s`→stats,
`weight`→stats (the stats one-liner already ends in the Senither figure),
`sk`→skills, `sl`→slayers, `dungs`/`cata`→dungeons, `run`→runs, `event`→events,
`h`/`commands`→help.

---

## 4. Admin bot — staff commands (26)

Role tiers are `MODERATOR` < `OFFICER` < `ADMIN` < `OWNER`. ✱ marks a
destructive command requiring `confirm:true`.

### 4.1 Moderation

| Command | Role | Options | Purpose | Output |
|---|---|---|---|---|
| `/warn` | MOD | `target*` `reason?` | Formal warning; may trip the escalation ladder (ADMIN_BOT.md §5.1) | Confirmation with the case id, plus what was auto-escalated if anything |
| `/mute` | MOD | `target*` `duration*` `reason?` | One action across **both** surfaces — Discord timeout and Hypixel guild-chat mute. Duration is required because Hypixel chat mutes are always time-bounded | Confirmation naming the surfaces that took effect, plus the expiry |
| `/ban` ✱ | OFFICER | `target*` `reason?` `duration?` `confirm?` | Ban, optionally temporary | Confirmation + expiry |
| `/kick` ✱ | MOD | `target*` `reason?` `confirm?` | Remove from the server. **Audit is written before the Discord effect**, so a kick that succeeds in Discord is never missing from the log | Confirmation |
| `/purge` ✱ | MOD | `count*` (1–100) `user?` `channel?` `confirm?` | Bulk-delete recent messages | Ephemeral count of messages **actually** deleted (Discord silently skips >14d), and a `NOTE` action recording it |
| `/member-note` | MOD | `target*` `note*` | Private staff note | Ephemeral confirmation |
| `/infractions` | MOD | `target*` | A member's history | Paged embeds |
| `/audit` | MOD | `actor?` `target?` `type?` (9 choices) `days?` (1–365) `in_force?` | Search the moderation log, newest 100 (says so when there are more) | Paged embeds |

### 4.2 Safety

| Command | Role | Options | Purpose | Output |
|---|---|---|---|---|
| `/lockdown` ✱ | OFFICER | `scope?` (channel/server) `channel?` `reason?` `duration?` `confirm?` | Lock a channel or the whole server, optionally auto-lifting | Confirmation + scope and expiry |
| `/lockdown-lift` | OFFICER | — | End a lockdown early | Confirmation |
| `/antiraid-on` | OFFICER | `sensitivity?` (LOW/MEDIUM/HIGH) `duration?` | Raise join gating and message-rate limits | Confirmation + active settings |
| `/antiraid-off` | OFFICER | — | Back to normal limits | Confirmation |
| `/safety-status` | MOD | — | Current posture | Embed: active lockdown and anti-raid state |

### 4.3 Chat filter

| Command | Role | Options | Purpose | Output |
|---|---|---|---|---|
| `/wordlist` | MOD | — | List the rules | Embed |
| `/wordlist-add` | OFFICER | `pattern*` `match_type?` (EXACT/SUBSTRING/WILDCARD/REGEX) `action?` (BLOCK/FLAG/REPLACE/SHADOW_MUTE) `severity?` (1–5) `note?` | Add a rule | Confirmation + the compiled rule |
| `/wordlist-remove` | OFFICER | `rule*` (autocomplete over id **and** pattern) | Remove a rule | Confirmation |
| `/filter-test` | MOD | `text*` | Run text through the **same compiled matchers the relay uses** | Which rules match and the resulting action |

### 4.4 Configuration

| Command | Role | Options | Purpose | Output |
|---|---|---|---|---|
| `/set-channel` | ADMIN | `slot*` (bridge/staff/log/applications/events) `channel?` | Bind a platform channel; **empty clears the slot** | Confirmation |
| `/feature-toggle` | ADMIN | `feature*` `enabled*` | Turn a named feature on or off | Confirmation + effective flags |
| `/set-recruitment` | OFFICER | `open*` | Open or close applications. The `min_weight`, `min_networth` and `clear_requirements` options were removed with the entry bars — the scam check is the only requirement | Confirmation of the new config |
| `/set-role` | ADMIN | `role*` `type?` (member/mapping) `target?` `discord_role?` | `type:member` changes a member's rank and writes a `ROLE_CHANGE` action; `type:mapping` binds a rank to a Discord role (empty clears) | Confirmation |

### 4.5 Applications & bridge

| Command | Role | Options | Purpose | Output |
|---|---|---|---|---|
| `/application-review` | OFFICER | `id?` | Omit to list the queue, pass an id to open one | List embed, or the applicant's answers |
| `/accept-member` | OFFICER | `id*` `reason?` | Accept and add to the roster; also promotes to `MEMBER` | Confirmation, and an explicit report when the roster row is missing |
| `/deny-member` | OFFICER | `id*` `reason?` | Reject | Confirmation |
| `/tickets` | MODERATOR | `action*` `id?` (autocomplete) `reason?` | `list`/`view` read the database; `close`/`transcript` go over loopback to the bridge bot, which holds the gateway | Queue embed, ticket card, or a `.md` transcript attachment |
| `/join-queue` | MODERATOR | — | Live in-game join requests; expires stale rows on read | List embed, remaining window first, then verdict and risk |
| `/join-accept` | MODERATOR | `ign*` (autocomplete) | Accept inside the window, invite past it, then mark the row | Confirmation naming the route taken |
| `/join-deny` | MODERATOR | `ign*` (autocomplete) | Type `/guild deny` in-game and mark the screening DENIED | Confirmation |
| `/guild-invite` | MODERATOR | `ign*` | Invite somebody who never asked; decides no screening row | Confirmation |
| `/guild-kick` | MODERATOR | `ign*` `reason?` | Remove a member from the in-game guild | Confirmation |
| `/guild-mute` | MODERATOR | `ign*` `duration*` | Silence a member in guild chat (`30m`, `12h`, `7d`) | Confirmation |
| `/guild-unmute` | MODERATOR | `ign*` | Lift an in-game guild mute | Confirmation |
| `/guild-promote` | MODERATOR | `ign*` | Raise a member one in-game guild rank | Confirmation |
| `/guild-demote` | MODERATOR | `ign*` | Lower a member one in-game guild rank | Confirmation |
| `/bridge-suspend` | OFFICER | — | Stop relaying both directions | Confirmation |
| `/bridge-unsuspend` | OFFICER | — | Resume relaying | Confirmation |

---

## 5. Drift against `COMMANDS.md`

The spec and the code disagree in the following places. Each is a decision to
make in the tightening pass — either the code moves or the spec does.

### 5.1 Specified but not implemented (6)

| Spec | Where | Note |
|---|---|---|
| `/subscribe`, `/unsubscribe` | §5 | No subscription surface exists in any registry |
| `/mayor`, `/firesales`, `/bingo` | §5 | No Hypixel election/firesale/bingo commands exist |
| admin `/ticket` | §14 | Tickets are member-side only; there is no staff open-on-behalf, assign or close-other command |
| admin `/attendance` (mark/report) | §13 | Only the member-side read-only `/attendance` exists — nothing marks attendance |

### 5.2 Implemented but not specified (7)

`/lockdown-lift`, `/safety-status`, `/wordlist` (list), `/help` on the bridge
bot as a static catalog, `/joinrun` and `/leaverun` as separate commands rather
than buttons only, and the RSVP/run **button routes**.

### 5.3 Wrong permission tier in the spec (6)

| Command | Spec says | Code has |
|---|---|---|
| `/kick` | Officer | MODERATOR |
| `/audit` | Officer | MODERATOR |
| `/lockdown` | Admin | OFFICER |
| `/antiraid-on` / `/antiraid-off` | Admin | OFFICER |
| `/set-recruitment` | Admin | OFFICER |
| `/create-event` | Officer, on the **admin** bot | Any member with `RUN_COMMAND`, on the **bridge** bot |

The last one is the largest gap: the spec treats event scheduling as staff work,
the code treats it as a member capability. The web panel sides with the spec —
every `event.*` mutation is OFFICER-tier there — so the same action
currently has two different bars depending on the surface.

### 5.4 Option drift (7)

| Command | Difference |
|---|---|
| `/unlink` | Spec has `account?`; code always unlinks the one on file |
| `/events` | Spec has `range?`; code always returns the upcoming list |
| `/auctions` | Spec and code agree on `player?` alone since the item half moved to the `/price` card |
| `/ban` | Spec has `delete_days?`; not implemented |
| `/kick` | Spec has `also_guild?`; not implemented |
| `/infractions` | Spec has `page?`; code auto-pages |
| `/wordlist-remove` | Spec has `pattern` **or** `rule_id`; code has one `rule` option that accepts either |

### 5.5 Model drift (3)

- **Capability coverage.** §17 says the in-game surface authorizes via
  `BridgePermission`. It deliberately does not — authorization there is the
  `inGame` allow-list plus the link requirement, because `BridgePermission` rows
  are per Discord user and reusing them would lock every unlinked member out of
  `!stats`, which §17 explicitly allows. The spec should record this.
- **`RUN_COMMAND` is inconsistently applied.** Ten commands declare it and 21 do
  not, with no principle separating them: `/stats` requires it, `/me` and
  `/profile` do not, though all three do the same work. The spec's Public/Linked
  tiers don't map onto this at all.
- **`!weight`.** §17 lists it as its own progression command; the code aliases it
  to `stats`.

### 5.6 Consistent (worth keeping)

`/link`'s social-field semantics (`/verify`'s too, now that it is the same handler), the `/mute` cross-surface
contract, the `/purge` Discord limits, `/online`'s two distinct failures and its
Discord-only stance, in-game truncation and per-IGN cooldowns, cooldown key
shape, and `CommandUsage` on every invocation all match the spec as written.
