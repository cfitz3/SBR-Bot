# Command Inventory — as built

Every command that exists in code today, across both bots and the in-game
surface, with what it does and what it replies with. This is a **descriptive**
document: it reports the registries as they are, not as they should be.
`COMMANDS.md` is the **prescriptive** spec, and the two have drifted — §5 at the
end lists every difference, which is the working list for the tightening pass.

Sources of truth for this file:

- `packages/commands-bridge/src/handlers.ts` — 24 member specs
- `packages/commands-bridge/src/handlers-community.ts` — 9 community specs + 2 button routes
- `packages/commands-bridge/src/ingame.ts` — the `!` surface and its aliases
- `packages/commands-admin/src/handlers.ts` — 26 staff specs
- the two dispatchers, for the gates every command passes through

**Totals: 33 member commands, 26 staff commands, 15 reachable in-game, 2 button routes.**

**Ten of the 33 are retired** (`enabled: false`): `/progress`, `/missing`,
`/nextupgrade`, `/whatnext`, `/lfg`, `/runs`, `/joinrun`, `/leaverun`,
`/editrun`, `/closerun`. They are absent from Discord's registry, refused by the
dispatcher, and silent in guild chat — but still in `buildBridgeRegistry()` with
their handlers intact, which is why they are still counted and still described
below. **23 member commands are actually reachable, and 13 in-game** (`lfg` and
`runs` leave that surface with them). `COMMANDS.md` explains why each went. The
rows below describe behaviour, not availability.

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
  is an unreachable data source, otherwise *"Something went wrong fetching that
  — try again shortly."*
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
| `/link` | `ign*` | 10s | Bind a Discord account to an IGN by matching Hypixel's Discord social field against the caller's handle | Ephemeral `Linked to {ign}. ✅`, or the specific link failure (social unset, mismatch, already owned) |
| `/verify` | `ign?` | 10s | Re-run the same social check; with no argument it re-checks the account already on file — the repair path for a stale link | Ephemeral `Verified as {ign}. ✅`, or `Nothing to verify — use /link <ign> first.` |
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
| `/skills` | `player?` `profile?` `skill?` | 15s | ✔ | Skill levels and XP to next, or one skill. Twelve skills including Hunting; capped skills are marked `✦` and counted in the header | Skills embed; text `{ign}: skill average N` |
| `/slayers` | `player?` `profile?` `boss?` (6 choices) | 15s | ✔ | Slayer XP, tiers and per-tier boss kills. Naming one boss switches to its full tier breakdown | Slayers embed; text `{ign}: N slayer xp` |
| `/slayer` | as `/slayers` | 15s | ✔ | **Deprecated alias.** Answers identically, with `` `/slayer` is now `/slayers`. `` in front. Remove after one release | as `/slayers` |
| `/dungeons` | `player?` `profile?` | 15s | ✔ | Catacombs level and progress to the next, class levels and average, completions per floor (`F…` normal, `M…` master), fastest S+ | Dungeons embed; text `{ign}: catacombs N` |
| `/networth` | `player?` `profile?` | 15s | ✔ | Networth estimate; six largest categories with their share of the total and their three most valuable items | Networth embed; text `{ign}: {total}` |
| `/milestones` | `player?` | 15s | — | Guild achievements + standing: earned (top 5) and closest unearned (top 5) w/ progress | Achievements embed; text `{ign}: N/M achievements · next: {label}` |
| `/progress` | `metric?` (4 choices) `range?` (1–365, default 30) | 15s | — | The **caller's** progression over time; requires a link | Progress embed; text `{ign}: networth over 30d — +N` or `not enough history` |

`/progress` falls back to `networth` for an unrecognised metric rather than
erroring — the option is choice-constrained in Discord, so that path only exists
for the in-game and test surfaces.

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
| `/price` | `item*` (autocomplete) | 5s | Blended market value | Price embed; text `{id}: {coins}` |
| `/bazaar` | `item*` | 5s | Bazaar order book | Bazaar embed; text `{id}: buy X / sell Y`. An item not sold on the bazaar says so and points at `/lowestbin` rather than reporting an outage |
| `/lowestbin` | `item*` | 5s | Cheapest BIN listing | Embed; text `{id}: {coins}` or `no BIN listing` |
| `/auctions` | `item?` `player?` | 15s | Two questions, one command: an item's cheapest listings, or a player's own. **`item:` wins when both are given.** A player's auctions split into sold-unclaimed (with the coins waiting), expired-unsold and active; already-collected auctions are dropped | Auctions embed; text `{ign}: N active · X to claim · N expired` |

### 2.5 Guild & meta

| Command | Options | CD | Purpose | Output |
|---|---|---|---|---|
| `/help` | — | 3s | Static catalog, grouped Account / Stats / Optimize / Market / Guild / Events / Groups / Help | Ephemeral 8-line list |
| `/online` | — | 30s | Guild roster read live from the Mineflayer session (the Hypixel guild endpoint carries no presence) | Roster embed by rank. **Two failures kept distinct**: no bridge configured here (permanent) vs bridge offline right now (retryable) |
| `/standing` | `member?` (user) | 10s | Guild XP, level, rank and the per-source breakdown behind it | Standing embed; text `{name}: level N ({xp} xp)`. **Public for yourself, ephemeral for anyone else** |

| `/leaderboard` | `category?` (choice of 8), `page?`, `days?` | 15s | Guild rankings over wealth, tenure, skill average, catacombs, slayer, Discord activity, guild chat and XP | Ranked embed with the caller's own row appended; text = top five on one line |

`/leaderboard` ranks **only active members**, and **only positive values** —
zero and unknown are both absent from a board rather than sitting at the bottom,
because "no data" and "worst in the guild" are different claims. Ties share a
rank (1, 2, 2, 4) and the footer quotes the **oldest** reading on the page, not
the newest. The four snapshot-backed boards are keyed by Minecraft uuid, so an
unlinked caller gets the board but no "you are here" line. Full rules in
`COMMANDS.md` §19.

`/standing` is keyed by **Discord id, not IGN** — XP is attributed to a person
on the platform, so an unlinked speaker has no standing to report. Three answers
are kept apart on purpose: XP not wired here says *"Guild XP isn't switched on
here."* (never "0", which would be a different and untrue claim), a member with
no ledger rows gets the encouraging empty state, and everyone else gets the
embed. Someone else's standing stays ephemeral because printing a member's rank
into a channel on request invites exactly the comparison nobody asked for.

`/online` is Discord-only by design — in-game the answer is `/g online`, which
costs the bridge account nothing. The 30s cooldown and the transport's shared
cache exist because a spammed `/g online` gets the bridge account silenced,
which takes the whole relay down.

### 2.6 Events & RSVP

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
  `networth`, `price`, `bazaar`, `lowestbin`, `events`, `runs`, `leaderboard`
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

**Aliases:** `nw`→networth, `bz`→bazaar, `lbin`/`lb`→lowestbin, `s`→stats,
`weight`→stats (the stats one-liner already ends in the Senither figure),
`sk`→skills, `sl`→slayer, `dungs`/`cata`→dungeons, `run`→runs, `event`→events,
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
| `/note` | MOD | `target*` `note*` | Private staff note | Ephemeral card |
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
| `/tickets` | MODERATOR | `id?` (autocomplete) `reason?` | The queue and one ticket read the database; Close and Transcript are buttons that go over loopback to the bridge bot, which holds the gateway | Queue embed, ticket card, or a `.md` transcript attachment |
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

### 5.4 Option drift (8)

| Command | Difference |
|---|---|
| `/help` | Spec has `command?` for per-command help; code is a fixed list |
| `/unlink` | Spec has `account?`; code always unlinks the one on file |
| `/events` | Spec has `range?`; code always returns the upcoming list |
| `/auctions` | Spec errors on neither/both args; code prefers `item:` and defaults to the caller |
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

`/link` and `/verify` social-field semantics, the `/mute` cross-surface
contract, the `/purge` Discord limits, `/online`'s two distinct failures and its
Discord-only stance, in-game truncation and per-IGN cooldowns, cooldown key
shape, and `CommandUsage` on every invocation all match the spec as written.
