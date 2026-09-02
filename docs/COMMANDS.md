# Command Surface — SBR Guild Platform

Full command specification for the three surfaces: the **member-facing Bridge bot** (Discord slash commands + in-game bridge), the **staff-facing Admin bot**, and the **in-game command system** carried over the bridge.

**Data-source legend**
- **Live** — real-time Hypixel API call (via `packages/hypixel`).
- **Cache** — Redis-cached data (profiles, prices, config, permissions).
- **DB** — PostgreSQL via `packages/db` (durable records).
- Many commands are **mixed** (e.g. Cache→Live on miss, then persisted).

**Permission tiers** (resolved by `packages/identity` / `BridgePermission`): `Public` (any linked member), `Linked` (requires verified link), `Subscriber` (opt-in), `Staff` (`MODERATOR`+), `Officer` (`OFFICER`+), `Admin` (`ADMIN`/`OWNER`).

**Descriptions are copy, not code.** Every sentence Discord shows for a command or an option comes from `command.<name>.description` / `command.<name>.option.<opt>` in the brand layer, applied inside `buildBridgeRegistry()` and `buildAdminRegistry()` — the one place each registry is assembled — so slash registration, `/help`, in-game `!help` and the panel's command docs cannot disagree. Change a word in [`brand/copy.ts`](../brand/README.md), rebuild, restart ([`BRANDING.md`](BRANDING.md) covers the whole loop, including what `npm run brand check` catches before Discord rejects an over-long description); the spec keeps its name, cooldown, capability and handler. The *Purpose* column below is documentation prose and is written independently of it.

**Common error states** (assumed for all commands, not repeated per row): rate-limited/cooldown (Redis `cd:*`), missing permission, guild not configured, Discord API failure, internal error. Command-specific errors are listed.

---

> ### Retired commands
>
> Twenty-two commands are flagged `enabled: false` and are **absent from Discord's
> command list**, from `/help`, and from guild chat. They are not deleted: the
> handlers stay compiled and under test, and turning one back on is a one-line
> change. Sections 1, 2, 4, 6 and 20 below still describe them, because what they
> did is still what they would do.
>
> - **§1, `/verify`** — folded into `/link`. It existed because `/link` had
>   failed, which made it a repair path reachable only by knowing a second
>   command name; the usual outcome was a member concluding the bot was broken.
>   `/link` with no IGN now does what `/verify` did — re-check the account on
>   file — and says so in its own words rather than claiming a fresh link.
> - **§2, progression** — `/goal`, `/progress`, `/snapshot`, merged into
>   `/progression`. They were three commands around one loop and none of them
>   named the other two, so the usual first experience of `/progress` was an
>   empty chart and no way to learn why. The chart, the goal on the charted
>   metric and the save that makes next week's chart possible are now one card
>   with the other two as buttons under it.
> - **§4, the advice engine** — `/missing`, `/nextupgrade`, `/whatnext`. The
>   advice reads a live auction house the platform no longer keeps warm, so its
>   suggestions were confident and stale. A confidently wrong upgrade
>   recommendation is worse than none.
> - **§6, looking-for-group** — `/lfg`, `/runs`, `/joinrun`, `/leaverun`,
>   `/editrun`, `/closerun`, the `run:` buttons, the `!run` alias and the `lfg`
>   channel slot. Parties get formed in guild chat; the board went stale faster
>   than anyone closed a post. `/perm` stays: the party lists it keeps are
>   useful on their own, and `LFGPost` / `LFGActivity` rows are untouched.
> - **§20, `/cringe`** — retired outright rather than replaced. It is the only
>   fun command aimed at a named person, and a public counter of how cringe
>   somebody is has no version that ages well in a guild that later has to
>   moderate itself. A guild that wants a running joke now aims a message
>   trigger (the panel's Triggers page, docs/WEB_PANEL.md) at a message
>   somebody chose to post, rather than at a name somebody else typed.
> - **Covered elsewhere** — `/stats`, `/slayer`, `/guildquote`, `/rank`, `/tag`. Every
>   number `/stats` printed is on a card that says more about it (§3), so it was
>   a fifth thing to learn rather than a shortcut. `/slayer` has been answering
>   with a "now `/slayers`" notice since the rename, which was meant to last one
>   release; leaving it registered makes a temporary deprecation permanent.
>   `/guildquote` returns one of a static handful of lines nobody has added to,
>   and `/rank` printed a made-up score beside a word that means something real
>   in a guild.
>   `/tag` is a staff tool wearing a member command — the tags themselves stay,
>   posted by the ticket flow and edited from the panel.
>
> - **§13, events** — `/events`, `/create-event`, `/rsvp`, `/attendance`, and
>   the `!event` alias. An event is one message now: posted when it is created,
>   the roster and the RSVP buttons while signups are open, the standings in
>   place once it starts, the result afterwards. None of the four has a question
>   left to answer — the channel lists what is coming and who is coming without
>   being asked, the buttons take the answer, and creation moved to the panel,
>   which is the only surface that can offer the activity choice a slash command
>   could not. Recording who actually turned up stays on the panel's events
>   page, where the tracker's observations sit beside the hand-ticked boxes.
>
> The flag is honoured in three places — `toSlashCommands` (so the command
> leaves Discord's registry), the dispatcher (so a stale client is refused with
> *"`/x` has been retired."*), and the in-game router (so guild chat answers
> with the same silence an unknown command gets). Honouring it in one place and
> not the others is what `deprecatedBy` used to do, and it reads to a member as
> a broken bot rather than as a retired feature.

---

## 1. Member Bot — Account & Identity

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/link` | Link a Discord account to a Minecraft one, or re-check the link already on file when called with no IGN | Public | `ign?` (string) | On match: success embed + role grant. On mismatch: instructions to set the Discord social link in-game (`/api`→profile→social) and rerun | IGN not found; **Hypixel social Discord field empty/unset** → reject; **social field ≠ caller** → reject; another user already owns this MC account | Live (resolve UUID + read Hypixel social field) + DB (create `LinkedAccount` `VERIFIED`) + Cache |
| `/verify` | *Retired — folded into `/link`, which re-checks when called with no IGN.* Re-run the Hypixel social check to (re)confirm or repair an existing/pending link | Public | `ign?` | Success embed + role sync, or the same mismatch guidance as `/link` | No account to verify; social field unset or mismatched | Live (re-check Hypixel social) + DB (set `VERIFIED`) + Cache |
| `/unlink` | Remove a linked Minecraft account | Linked | `account?` (if multiple) | Confirmation embed | No linked account; not owner | DB (set `UNLINKED`) + Cache invalidation |
| `/me` | Show the caller's own linked profile summary | Linked | *(none)* | Embed: IGN, selected profile, key stats, weight, networth | Not linked; no selected profile | Cache→Live + DB (selection) |
| `/profile` | View any member's Skyblock profile overview | Public | `player?` (IGN/@mention), `profile?` | Embed: profile summary for target | Player not found; profile API disabled by target | Cache→Live |
| `/setprofile` | Choose which Skyblock profile to track | Linked | `profile` (cute name / autocomplete) | Confirmation of active profile | Profile not found on account; not linked | Live (list profiles) + DB (`SelectedSkyblockProfile`) |

> **What the social field actually contains.** `player.socialMedia.links.DISCORD` holds a
> Discord **username**, not a snowflake — verified against the live API, which returns
> modern handles (`refraction`) and legacy tagged ones (`boblovespi#9817`). `/link` and
> `/verify` therefore compare it against the caller's username, case-insensitively and
> ignoring any `#discriminator`, and accept a raw id as well for the players who paste
> one. The in-game surface knows only an IGN, so it can match the id form only.

---

## 2. Member Bot — Stats & Progression

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/stats` | Broad stat overview for a player | Public | `player?`, `profile?` | Embed: skills avg, slayers, dungeons, networth, weight | Player/profile not found; API disabled | Cache→Live |
| `/skills` | Detailed skill levels + XP to next | Public | `player?`, `profile?`, `skill?` | Embed: two consolidated lists (counted skills, cosmetic skills) plus the skill closest to its next level; one skill named gets its own field and a progress bar | Player not found | Cache→Live |
| `/slayers` | Slayer XP, tiers, per-tier boss kills | Public | `player?`, `profile?`, `boss?` | Embed: one field per boss, each with tier, XP, total kills and the per-tier split; naming one boss narrows to it | Player not found | Cache→Live |
| `/slayer` | **Deprecated** alias of `/slayers`, kept for one release | Public | as `/slayers` | Same answer, prefixed with the new name | — | Cache→Live |
| `/dungeons` | Catacombs level, class levels, floor completions/PBs | Public | `player?`, `profile?` | Embed: cata level and XP to the next, class levels and average, completions per floor (normal and master), fastest S+ | Player not found; no dungeon data | Cache→Live |
| `/networth` | Full networth breakdown (gear/reforge/gems/museum/bank) | Public | `player?`, `profile?` | Embed: total + one vertical breakdown listing every category with its share; a category dropdown opens the itemised view | Player not found; museum private | Cache→Live (`skyhelper-networth` + `pricing`) |
| `/progression` | Your progress over time, your goals, and the markers behind both | Linked | `metric?`, `range?` (7/30/90 days) | Ephemeral card: change over the window, both endpoints, per-day pace, marker count, the goal on the charted metric. Under it a metric menu, the three windows, and buttons to save a marker, set a goal and clear one | Nothing saved yet → the card says so and the button under it reads *Begin tracking* | DB (`ProfileSnapshot` user-saved rows, `ProgressionGoal`, `ProfileCurrent`); **no Hypixel request** |
| `/progress` | *Retired — merged into `/progression`.* Progression over time, with the pace it implies | Linked | `metric?`, `range?` | Embed: change over the window, both endpoints (named, if the member named them), per-day pace, snapshot count | Fewer than two saved snapshots → says to run `/snapshot` | DB (`ProfileSnapshot`, user-saved rows only) |
| `/goal` | *Retired — merged into `/progression`.* Set a target on one of the four tracks and watch it | Linked | `action?` (list/set/clear), `metric?`, `target?` | Embed: bar, current/target, days at recent pace | Goal storage unwired → says so; target already met → says where they are | DB (`ProgressionGoal`, `ProfileSnapshot`, `ProfileCurrent`) |
| `/snapshot` | *Retired — merged into `/progression`.* Pin your current stats so the chart has something to compare against | Linked | `label?` | Text: saved, how many of the 24 you hold, the name if you gave one | Not read yet → says so; same reading already saved → says to wait for the next refresh | DB (`ProfileCurrent` → `ProfileSnapshot`); **no Hypixel request** |
| `/milestones` | The guild's achievements and the player's standing against them | Public | `player?` | Earned grouped by category (rarest tier first, tier badge or icon, XP paid) + the four closest unearned w/ progress bars, `n/total` headline, hidden-locked count, "measured" footer | Achievements off → says so; no snapshot → thresholds listed, progress "not measured yet"; hidden achievements counted, never named | DB (`Milestone`, `MilestoneDefinition`, `ProfileCurrent`) |

`/networth`'s breakdown is one vertical list rather than a row of columns, so
every category that holds value is on the card and the shares add up to the
headline. The itemisation sits behind the category dropdown under it: the reply
is ephemeral, so a shared card is not buried, and the dropdown is stateless —
the target and profile ride in its id and the reply is a fresh read, so a card
scrolled back to next week still opens, on today's numbers. Guild chat has
neither embeds nor dropdowns; `!nw` still answers with the total, which is the
part a chat line can carry.

---

## 3. Member Bot — Economy & Market

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/price` | The whole market for one item | Public | `item` (autocomplete) | One card: both books (instant buy/sell, spread, lowest BIN, listing count), what is moving, and a price chart over 24h / 7d / 30d with the current price stated against that window's average. Buttons switch the window and open the cheapest listings | Item unknown; neither book has it | Cache→Live (bazaar, BIN sweep) + Coflnet (history only) |
| ~~`/bazaar`~~ | Retired into `/price`, which carries the whole order book rather than the half this printed. `!bz` still routes to the card | — | — | — | — | — |
| ~~`/lowestbin`~~ | Retired into `/price`, which carries the lowest BIN *and* how many listings back it — one number without the other was always the misleading half. `!lbin`/`!lb` still route to the card | — | — | — | — | — |
| `/auctions` | A player's auction standing | Public | `player?` | Sold-but-unclaimed (with the coins waiting), expired-unsold, and active. The `item:` half moved to the **Listings** button on the `/price` card, where it sits under the price it is a list of | None active | Cache→Live (AH) |

---

## 4. Member Bot — Optimization & Guidance

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/missing` | Missing accessories/talismans (magical power gaps) | Public | `player?`, `profile?` | Embed: missing/upgradeable accessories | Player not found; inventory API off | Cache→Live |
| `/nextupgrade` | Cheapest-impact next gear/stat upgrade | Linked | `focus?` (dps/ehp/farming/…) | Ranked suggestions w/ est. cost | No profile data; API off | Cache→Live + `pricing` |
| `/whatnext` | Personalized "what to do next" progression advice | Linked | `goal?` | Prioritized recommendation list | No profile/snapshot data | DB (snapshots) + Cache→Live + `progression` |

*(These three are the highest-logic commands; they consume `packages/progression` + `pricing` and degrade gracefully to generic advice if API data is unavailable.)*

---

## 5. Member Bot — Events, Notifications & Skyblock Calendar

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/events` | List upcoming guild events | Public | `range?` | Embed list of `Event`s w/ RSVP counts | None scheduled | DB (`Event`) |
| `/subscribe` | Opt into a notification category | Public | `category` (mayor/firesale/bingo/events/…) | Confirmation of subscription | Unknown category; already subscribed | DB (subscription flags) |
| `/unsubscribe` | Opt out of a notification category | Subscriber | `category` | Confirmation | Not subscribed | DB |
| `/mayor` | Current/next SkyBlock mayor & perks | Public | *(none)* | Embed: mayor, perks, election status | Election data unavailable | Cache→Live (election endpoint) |
| `/firesales` | Active/upcoming fire sales | Public | *(none)* | Embed of current fire sales | None active | Cache→Live |
| `/bingo` | Current bingo card/goals & progress | Public | `player?` | Embed: bingo goals + player progress | No active bingo; player not found | Cache→Live |

---

## 6. Member Bot — LFG & Runs

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/lfg` | Create a looking-for-group post | Linked | `activity`, `slots?`, `title?`, `details?`, `perm?`, `permname?` | Public LFG embed w/ join / leave / close buttons | Cooldown; too many open posts; no such perm | DB (`LFGPost`) + Cache (`lfg:open:*` TTL) |
| `/runs` | List open runs/LFG posts | Public | `activity?` | List of open `LFGPost`s | None open | Cache (`lfg:open:*`) → DB |
| `/joinrun` | Join an open run | Linked | `run_id` | Updated party roster; DM/ping | Run full/closed; already joined | DB + Cache (slot update) |
| `/leaverun` | Leave a run you joined | Linked | `run_id` | Updated roster | Not in run; run closed | DB + Cache |
| `/editrun` | Change a run you host | Linked (owner or staff) | `id`, `title?`, `details?`, `slots?` | Updated embed | Nothing to change; not yours; run finished; slots below the current party | DB |
| `/closerun` | End a run | Linked (owner or staff) | `id` | Embed marked closed, buttons disabled | Not yours; already closed | DB |
| `/rsvp` | RSVP to a scheduled event | Public | `event_id`, `state` (going/maybe/no) | Updated RSVP + counts | Event full→waitlist; event past | DB (`EventRSVP`) |
| `/perm` | Standing parties — the group you always run with | Linked | — (opens the console; every action is a component) | Console: the guild's parties, paged, with a menu to open one; a party card is the roster in one field with cata and class levels | Name taken; not the owner; perm full; role not valid for the activity; already/not on the roster; not linked (taking a seat) | DB (`PermGroup`, `PermMember`) + `GuildMemberCache` and `ProfileCurrent` for enrichment |

### `/lfg` — runs

A post is a row; the message is a view of it. Every button carries the post id
in its `customId` (`run:<postId>:join|leave|close`), so the board survives a
restart and nothing ever has to look a post up by the message it was sent as.

- **Perm autofill.** `perm:true` brings the author's default perm for that
  activity; `permname:F7 core` names one, and wins over `perm:true` when both are
  given. Seats are taken in roster order until the party is full, the author is
  never duplicated, and seats with no linked Discord account are skipped — there
  is nobody to mention. A missing *default* is not an error (`perm:true` means
  "bring my usual party if I have one"); a missing *named* perm is.
- **Edits never kick anybody.** Shrinking `slots` below the current party is
  refused rather than silently truncating it. Raising slots on a full post
  reopens it, so the new seat is actually reachable.
- **Closing is a decision, expiring is not.** A closed post names who closed it;
  an expired one just says expired. Owner or staff (`MENTION`) may close; the
  buttons stay visible but disabled, so the message still reads as the run it was.
- **The board never blocks the reply.** Publishing to the configured `lfg`
  channel and refreshing the embed absorb their own failures — a broken channel
  binding must not turn a successful join into an error in a member's face.

**In-game shape stays `!lfg <activity> [slots] [details]`.** Guild chat has no
named arguments, so `title`, `perm` and `permname` are marked
`inGamePositional: false` and take no token there.

### `/perm` — standing parties

A **perm** is a fixed party a member runs with repeatedly: a name, an activity,
and a roster of seats. One command with no arguments at all: `/perm` opens a
console, and everything the eight options used to do is a control on it.

**Why the arguments are gone.** `/perm action:roster-add perm:"F7 core"
ign:Aria role:healer slot:2` asked for four things before it would do one — the
exact name of the party, the exact spelling of an IGN, which role words the
activity accepts, and that `slot` existed — and three of the four are things the
platform already knows. The parties are a menu, the roles are a menu built from
the activity's own shape, and the seat is the next free one. The only free text
left is a party's name and notes, and an IGN when an owner adds somebody who has
never linked; all of it goes through a modal, where it is validated in front of
the person who typed it. Every control carries its whole state in its customId,
so a console posted before a restart still works after one, and every action
re-checks the presser rather than trusting that a button was only shown to
somebody allowed to press it.

Three properties are worth stating because they are load-bearing:

- **Addressed by name.** Names are unique per guild while a perm is *active*,
  compared case-insensitively, and freed for reuse on disband — enforced by a
  partial unique index, since a name typed into the new-party modal is typed
  from memory. Ids still work anywhere a name does, and the console addresses
  parties by id.
- **Rosters are keyed by IGN.** A linked Discord account and a uuid are attached
  when they can be resolved and their absence is never an error. Perms are formed
  in-game, and most of a Hypixel guild has never linked an account.
- **Enrichment never calls Hypixel.** The in-guild marking comes from the 6 h
  member cache and the cata/SA columns from the member's stored `ProfileCurrent` row,
  one query each for the whole roster. `inGuild` is three-valued: a cold or
  unreachable cache renders as *nothing*, not as "left the guild".

Owner-or-staff may edit or disband a perm; only the owner may mark one as their
`/lfg` autofill default, because that is a personal preference rather than
administration. Disbanding is a status change, never a delete — a roster is a
record of who ran together.

**Not in the web panel, deliberately.** Who someone runs dungeons with is not
staff configuration (`PLATFORM_EXPANSION_PLAN.md` §4).

---

## 7. Member Bot — Meta

`/help` is generated, not written. It reads `buildBridgeRegistry()` and groups by
each spec's `category`, so a retired command cannot appear (it is filtered by the
same `enabled` flag that deregisters it from Discord) and a new one appears as
soon as it declares a category — which `help.test.ts` requires of every reachable
spec. The hand-written list it replaced named `/verify`, which no longer exists,
and omitted everything added after it was typed.

Its one button answers "how do I link?" with the platform's written steps plus
whatever the guild has configured on **Settings → Link walkthrough** — usually a
recording of the Hypixel social setting, which is where new members actually get
stuck. Both halves are optional; a guild that configures nothing still gets the
steps.

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/health` | Whether the bot, guild chat and Hypixel are answering | Public | — | Embed: three fixed rows + a count of anything else unhealthy | None — an unwired deployment says so | The member bot's own `HealthRegistry`, curated by `curateStatus` |
| `/help` | The member surface, grouped, built from the registry | Public | — | Embed: six category fields, a headline naming the caller's next step, and a "How do I link?" button | — | Static (the built registry) + DB (link state, the guild's link walkthrough) |
| `/online` | Who's in the guild right now, by rank, and how long they've been on | Public | — | Embed: rank sections + online/total counts + per-member elapsed time | Bridge offline (temporary); no in-game bridge configured (permanent) — reported separately | In-game `/g online` via the bridge session (20s shared cache) + the in-memory playtime tracker |

`/health` is where every user-facing error now points, which is what fixes both
its shape and its permissions. Three named rows — guild chat, the bot, the
Hypixel API — appear whether they are up or down, because a card listing only
what is broken reads as "nothing else is checked". Everything else the registry
probes is **counted, never named**: `PlatformStatusDTO` has no field for a
component name or for what a probe threw, so a Postgres connection error naming
our host cannot reach a member however the card is later edited. The count still
rolls up, so `/health` cannot report all clear during a database outage. Public
and ungated on purpose: a capability check would hide the diagnostic behind the
permission whose absence a member might be trying to diagnose.

The Hypixel row costs no API requests. The client records the outcome of its
last real call and the probe reads that, because a probe request per health
check would spend the guild's shared budget to produce a diagnostic — most of it
exactly when members are running `/health` because something is already wrong.
The honest cost: that row is as old as the last command anybody ran, and a
failure older than five minutes stops counting.

`/online` reads the **live** roster from the Mineflayer session rather than the
Hypixel API: the guild endpoint lists members but carries no presence, and
resolving that would cost one `/status` call per member. Discord-only — in-game
the answer is `/g online`, which any player can type without spending the bridge
account's command budget. Every invocation inside the cache window shares one
answer, because a spammed command gets the bridge account silenced and that
takes the whole relay down, not just this command.

**Each name carries how long that member has been on** — `Aria (42m)`, and the
headline names the longest current run. The figure comes from the bridge's own
join/leave observations, not from a sample count, so it is a measurement rather
than an estimate. Two cases are marked rather than hidden: a member the tracker
adopted from a roster read instead of watching join gets a `+` suffix
(`1h 35m+`), because the elapsed time is a floor and not the whole session; a
member the tracker has never seen gets no time at all rather than `0m`, which
would read as a claim. A restart empties the tracker, so every name is bare
until the next roster read adopts them.

---

## 8. Admin Bot — Moderation Actions

All write to `ModerationAction` (audit) and, where relevant, `Infraction`; enforcement state mirrored to Redis. All emit analytics events. Actions on higher-or-equal-ranked targets are refused.

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/warn` | Issue a formal warning | Staff | `member`, `reason`, `severity?` | Confirmation + logged case id; DM target | Target outranks actor; invalid member | DB (`Infraction`+`ModerationAction`) |
| `/mute` (a.k.a. `/timeout`) | **Unified cross-surface mute**: a single moderation action that applies a Discord timeout *and* issues a Hypixel guild-chat mute for the same duration. **Duration is required** (Hypixel chat mutes are always time-bounded) | Staff | `member`, `duration` (**required**), `reason` | Confirmation showing both surfaces + expiry; DM target | **Duration missing** → reject; `duration` > Discord 28d cap (Discord side clamps/errors, guild-chat mute still applies); linked IGN unknown → guild-chat mute skipped w/ warning; bridge account lacks in-game mute perms; target outranks | Discord API (timeout) + Bridge→Hypixel (`/g mute <ign> <time>`) + DB (`Infraction`+`ModerationAction`) + Cache (`mute:*` TTL) |
| `/kick` | Remove from Discord (and optionally guild) | Officer | `member`, `reason`, `also_guild?` | Confirmation | Target outranks; not in server | Discord API + DB |
| `/ban` | Ban from Discord (+ optional guild expel) | Officer | `member`, `reason`, `duration?`, `delete_days?` | Confirmation + expiry | Target outranks; already banned | Discord API + DB + Cache (`ban:*`) |
| `/purge` | Bulk-delete recent messages | Staff | `count`, `channel?`, `user?` | Ephemeral count deleted | >100 or >14d old (Discord limit) | Discord API + DB (audit) |

---

## 9. Admin Bot — Bridge Control

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/bridge-suspend` | Pause chat relay (both directions) | Officer | `reason?`, `duration?` | Confirmation + status broadcast | Already suspended | DB (`GuildConfig`) + Cache + pub/sub event |
| `/bridge-unsuspend` | Resume chat relay | Officer | *(none)* | Confirmation + status broadcast | Not suspended | DB + Cache + pub/sub |
| `/tickets` | Work the support queue: list, view, close or export one | Moderator | `action*`, `id?` (autocomplete), `reason?` | Queue embed, one ticket's card, or the transcript as a file | Ticket belongs to another server; bridge bot unreachable | DB (reads) + bridge loopback API (close, transcript) |
| `/join-queue` | Live in-game join requests and how long is left to answer them | Moderator | *(none)* | Queue embed, remaining window per row | *(empty queue reads as such)* | DB (`Screening`) |
| `/join-accept` | Admit somebody who asked to join in-game | Moderator | `ign*` | Confirmation naming the route: accepted, or invited because the window had closed | Not a Minecraft name; bridge not in-game | DB (`Screening`) + pub/sub `GAME_COMMAND` |
| `/join-deny` | Refuse an in-game join request | Moderator | `ign*` | Confirmation | As above | DB + pub/sub |
| `/guild-invite` | Invite a player who hasn't asked to join | Moderator | `ign*` | Confirmation | As above | pub/sub |
| `/guild-kick` | Remove a member from the in-game guild | Moderator | `ign*` `reason?` | Confirmation | Reason contains characters we won't type in-game | pub/sub |
| `/guild-mute` | Silence a member in guild chat | Moderator | `ign*` `duration*` | Confirmation | Duration is not a count and a unit (`30m`) | pub/sub |
| `/guild-unmute` | Let a muted member speak in guild chat again | Moderator | `ign*` | Confirmation | As above | pub/sub |
| `/guild-promote` | Raise a member one in-game guild rank | Moderator | `ign*` | Confirmation | As above | pub/sub |
| `/guild-demote` | Lower a member one in-game guild rank | Moderator | `ign*` | Confirmation | As above | pub/sub |

---

## 10. Admin Bot — Infractions & Notes

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/infractions` | View a member's infraction/mod history | Staff | `member`, `page?` | Paginated embed of cases | No history; member unknown | DB (`Infraction`+`ModerationAction`) |
| `/member-note` | Attach a private staff note | Staff | `member`, `note` | Confirmation | Member unknown | DB (`ModerationAction` type `NOTE`) |

---

## 11. Admin Bot — Membership & Recruitment

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/application-review` | Open an application to review | Officer | `application_id?` (or next in queue) | Embed: applicant answers + accept/deny buttons | Queue empty; app not found | DB (`Application`) + Cache→Live (applicant stats) |
| `/accept-member` | Accept an applicant | Officer | `application_id`, `note?` | Confirmation; role grant; DM applicant | Already decided; not linked | DB (`Application`, `GuildMember`) |
| `/deny-member` | Reject an applicant | Officer | `application_id`, `reason` | Confirmation; DM applicant | Already decided | DB |
| `/set-recruitment` | Open or close applications | Admin | `open` (true/false) | Confirmation of new recruitment config | — | DB (`GuildConfig`) + Cache |

---

## 12. Admin Bot — Roles, Channels & Features

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/set-role` | Map a platform role → Discord role, or set a member's role | Admin | `type` (mapping/member), `role`, `target` | Confirmation | Role not found; would elevate above actor | DB (`GuildConfig`/`GuildMember`) + Cache (perms) |
| `/set-channel` | Assign a functional channel (bridge/log/staff/etc.) | Admin | `purpose`, `channel` | Confirmation | Channel not in guild; bad type | DB (`GuildConfig`) + Cache |
| `/feature-toggle` | Enable/disable a platform feature per guild | Admin | `feature`, `state` | Confirmation + effective flags | Unknown feature | DB (`GuildConfig.features`) + Cache |
| `/rolemenu` | Post a self-service role menu, or list the ones this server has | Officer | `action` (list/post), `id?` (autocomplete), `channel?` | `list`: the menus and their options. `post`: confirmation that SBR Bot put it up | Unknown menu; bridge bot unreachable (the menu still exists — `list` works either way) | `GuildSetting` `roles.menus` + bridge internal API |
| `/sticky` | Keep a message at the bottom of a channel | Officer | `action` (list/set/clear), `message?`, `channel?` (defaults to here) | `list`: channel → first line. `set`/`clear`: confirmation, and whether it was applied now or will be next time somebody talks | Over 1,000 characters; already 15 stickies; channel has no sticky to clear | `GuildSetting` `discord.sticky` + bridge internal API |

---

## 13. Admin Bot — Events & Attendance

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/create-event` | Schedule a guild event | Officer | `title`, `type`, `starts_at`, `capacity?`, `description?` | Announcement embed w/ RSVP buttons | Invalid/past date; bad type | DB (`Event`) + Discord API |
| `/attendance` | Record/report attendance for an event | Officer | `event_id`, `mode` (mark/report), `members?` | Attendance summary vs. RSVPs | Event not found; not yet started | DB (`Event`,`EventRSVP`) |

---

## 14. Admin Bot — Support Tickets

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/ticket` | Manage tickets (open/assign/close on behalf) | Staff | `action` (open/assign/close), `user?`, `category?`, `reason?` | Ticket thread + status | Ticket not found; already closed | DB (`Ticket`) + Discord API |

What a member may open is configuration, not a command: the ticket menu (`TicketTypeConfig`) and the panel that advertises it (`TicketPanelConfig`) are edited on the panel's admin-only **Tickets** page. The bot reads that menu — see COMMAND_INVENTORY.md §2.8 for the member-facing `/ticket`. A guild that configures nothing offers the five built-in types, which are the fixed `TicketCategory` values.

---

## 15. Admin Bot — Server Safety & Audit

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/audit` | Query the moderation/audit log | Officer | `filters` (actor/target/type/range) | Paginated audit results | No matches | DB (audit tables) |
| `/lockdown` | Lock channel(s) to stop posting | Admin | `scope` (channel/server), `reason?`, `duration?` | Confirmation + status | Already locked | Discord API + DB + Cache |
| `/antiraid-on` | Enable raid protection (join gating, rate caps) | Admin | `sensitivity?`, `duration?` | Confirmation + active settings | Already on | DB (`GuildConfig`) + Cache |
| `/antiraid-off` | Disable raid protection | Admin | *(none)* | Confirmation | Not active | DB + Cache |

---

## 16. Admin Bot — Content Filtering

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/wordlist-add` | Add a filter rule | Officer | `pattern`, `match_type`, `action`, `severity?` | Confirmation + compiled rule | Invalid regex; duplicate | DB (`WordlistEntry`) + Cache (recompile) |
| `/wordlist-remove` | Remove a filter rule | Officer | `pattern` **or** `rule_id` | Confirmation | Rule not found | DB + Cache |
| `/filter-test` | Test a message against the current wordlist | Staff | `text` | Which rules match + resulting action | *(none — always returns a result)* | Cache (compiled wordlist) → DB |

---

## 17. In-Game Command System (Bridge-Linked)

Members trigger commands from **in-game guild chat**; `packages/bridge` parses, authorizes via `BridgePermission`, executes through the same services as the slash commands, and relays a **chat-length-limited** reply back into guild chat.

**Design constraints**
- **Prefix-based**, not slash: e.g. `!stats <ign>`, `!nw`, `!price <item>`, `!lfg <activity>`, `!help`. Prefix and enabled set come from `GuildConfig`.
- **Output is truncated/paginated** to fit Minecraft chat (single line, ~256 char cap); rich embeds collapse to a compact one-liner (e.g. `Player — Cata 42 | SA 45.3 | NW 8.2b | SnrW 12,340`).
- **Read-only / low-risk subset only.** In-game commands expose the *lookup* commands (stats, skills, slayers, dungeons, networth, price, weight, help) and lightweight LFG (`!lfg`, `!runs`, `!perm`). `!perm` requires a linked account even for its read actions, because those share one command with its writes and the weaker of the two requirements would otherwise govern the pair. The **fun** commands (§20) are in-game too: they read nothing about anybody and write nothing anybody is accountable for. **Never** exposes moderation, linking-secret, or config commands — those require Discord identity + permission tiers that can't be safely proven from guild chat alone.
- **Arguments are positional**, in the spec's declared order, with the last one
  absorbing the rest of the line so multi-word values work. There is no
  `key:value` syntax, so an option only Discord should see is declared
  `inGamePositional: false` — otherwise adding one silently re-maps the free-text
  argument at the end (this is why `!lfg <activity> [slots] [details]` still works
  after `/lfg` gained `title`, `perm` and `permname`).
- **A command name may start with a digit** (`!8ball`). The name pattern exists
  to keep punctuation — `!!!`, `!?` — from being parsed as a command, and an
  unrecognised name still ends in silence, so it is no stricter than that.
- **Cooldowns are stricter** (per-IGN Redis `cd:ingame:*`) because guild chat is spam-prone and rate-limited by Hypixel itself.
- **Identity is by IGN → `LinkedAccount`.** If the IGN isn't linked, commands still work for public lookups but personalized commands (`/me`, `/whatnext`) reply with a "link on Discord" hint.

| In-game command | Maps to | Perms | Data |
|-----------------|---------|-------|------|
| `!stats`, `!skills`, `!sl`, `!dungeons`, `!nw` | `/stats` … `/networth` | `RELAY_MESSAGE`+`RUN_COMMAND` | Cache→Live |
| `!price`, `!bz`, `!lbin`, `!lb` | `/price` — all four, since the shorthands outlived the commands they were short for | Run cmd | Cache→Live |
| `!weight` | `progression` (Senither/farming) | Run cmd | Cache→Live |
| `!lfg`, `!runs` | `/lfg`,`/runs` | Run cmd (linked) | DB + Cache |
| `!perm` | `/perm` | Run cmd (linked) | DB + member cache |
| `!help` | `/help` (condensed) | Public | Static |
| `!health` | `/health` | Public | Registry (no Hypixel request) |
| `!8ball`, `!roll`, `!coinflip`, `!rps` | §20 | Public | None |

`!me` is `"linked"` although it writes nothing. Standing is attributed to a
Discord account, so an IGN that resolves to no link has none to report — here
the link is the *lookup key*, not a permission.

**In-game error handling:** invalid command → short usage hint; on cooldown → silent or `⌛` reply; API failure → `⚠ data unavailable, try later`; unauthorized → `no permission` one-liner. Errors never dump stack traces into guild chat.

---

## 18. Member Bot — Guild XP & Standing

Guild XP is a **platform-side** progression track: it measures participation in
*this guild* (guild XP contributed, chat, commands, events, tenure), not
Skyblock progress. Nothing here reads Hypixel except the GEXP figure the roster
scan already stores.

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/me` | The member's own card: SkyBlock progress, guild standing, achievements, events and their own record | Linked | — | One card; "Guild standing" carries level, progress bar, rank, tenure and the per-source breakdown | XP not enabled, or the member has never earned any (the section is absent, not zeroed) | DB (`XpBalance`, `XpEvent`) + Hypixel |
| `/whois` | Somebody else's standing, as one line on their card | Public | `member?` | See §16 | — | DB |

**Visibility.** Standing appears in full only on `/me`, which is the caller's
own card and ephemeral. Someone else's is theirs to publish, so `/whois` carries
a one-line summary and only on the private card — a lookup that posts another
member's XP for them turns a lookup into an announcement.

**Freshness.** Standings are derived, not live: the `xp-aggregate` job weights
each day's activity counters into the ledger every three hours (see
`WORKERS.md`). The card says so in its footer rather than implying today's
chat is already counted — and only when the standing section is actually on it,
because a caveat about a section that is not there is noise.

**Two documented deviations from the original plan (Phase 5):**

- **`/profile` shows no standing.** `/profile` addresses a *player* by IGN,
  while standing is keyed by Discord id, and `IdentityService` exposes no
  IGN → Discord id resolution. Widening that interface for a decorative field
  would have touched every fake of it in the test suite. Standing therefore
  lands on `/me` — the one lookup certain the account and the person are the
  same — and, as a single line, on `/whois member:`.
- **`/me` carries a record, but not through the moderation service.** The
  deviation as first written said `/me` would show no infractions at all,
  because the member `HandlerDeps` holds no `ModerationService` and adding one
  for a count would hand every member-facing handler the audit log and the
  ability to punish people. Phase 10 kept that constraint and dropped the
  conclusion: `MemberRecordSource` takes a guild and a member id, has no write
  path, and returns a DTO with no ids in it, so the widest thing a member
  surface can do with it is exactly what `/me` does. See §Your record below.

**"Your record" on `/me` (Phase 10).** A member's own standing with staff, as
one field on their own card:

- **Absent for a clean member.** A field reading "0 warnings" on every card
  trains everyone to skip the section, and the one time it says something would
  look the same as the times it does not.
- **What is being enforced right now**, soonest to end first, with anything
  permanent last — "your mute ends in an hour" is the line being looked for, and
  a standing ban is not news that was missed. Expiry-aware through the same
  check the audit surfaces use, so a mute whose clock ran out is not listed
  because a sweep has not cleared its flag yet.
- **The reason staff typed is shown.** It is the member's own punishment and
  they were told it at the time; a mute whose reason is a secret is one they can
  only guess how to avoid repeating.
- **Warnings inside the escalation window**, counted by the same function the
  ladder fires off — if the card says two, the third is the one that escalates.
- **What the next warning would cost**, when it lands on a rung. Omitted when
  the ladder is off, when no policy source is wired, and when the next warning
  falls between rungs, because promising a punishment that will not happen is
  worse than promising nothing.
- **Only ever the caller's own.** `/stats <player>` addresses an IGN and never
  carries a record; the source is keyed by the Discord id `/me` already knows is
  the caller's.

**Anti-abuse** is split across the two moments it can be enforced (see
`DOMAIN_MODEL.md`): per-message length and per-user cooldown at *capture*, daily
caps at *aggregation*. A capped day is silently capped — no member is told they
have hit a limit, because that is an instruction on how to farm just under it.

---

## 19. Member Bot — Leaderboards

Eight boards over data the platform already keeps. Nothing here fetches from
Hypixel at command time: every value is read from a table some job has already
filled, which is why a board answers in one query and why it can be honest about
how old its numbers are.

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/leaderboard` | Guild rankings across nine categories (SkyBlock Level leads) | Member | `category?` (choice, default `xp`), `page?`, `days?` (1–365, activity boards only) | Embed: ranked page with 🥇🥈🥉, the viewer's own row appended, footer with page, total ranked, window and staleness | Leaderboards not enabled; unknown category (lists the real ones) | DB (`ProfileCurrent`, `GuildMember`, `ActivityDaily`, `XpBalance`) |

**The catalog is closed.** `wealth`, `tenure`, `skill-average`, `catacombs`,
`slayer`, `discord-activity`, `guild-chat`, `xp`. A leaderboard is a claim about
the guild, and each of these has a stated source and a stated freshness — an
open-ended "rank by any metric" surface could make neither promise. Common
spellings are accepted (`nw`, `cata`, `sa`, `gc`, `top`), so guild chat does not
have to type the canonical id.

**Sources and freshness.**

| Family | Source | How fresh |
|--------|--------|-----------|
| `SNAPSHOT` — wealth, skill average, catacombs, slayer | `ProfileCurrent` per linked account | up to one snapshot cycle behind (~6–12h) — the *only* family that can be stale |
| `TENURE` — tenure | `GuildMember.joinedAt` | exact, derived at read time |
| `ACTIVITY` — Discord activity, guild chat | summed `ActivityDaily` over a rolling window (default 30d) | same counters XP is derived from |
| `XP` — guild XP | `XpBalance`, rebuilt by `xp-aggregate` | up to three hours behind |

The footer reports the **oldest** reading on the page, never the newest: the
page is only as current as its stalest row, and quoting the freshest would
overstate it.

**Ranking rules.**

- **Competition ranking** — 1, 2, 2, 4. Tied members share a rank and consume
  the ones after it, so "third place" is never two different people.
- **Ties break by label ascending**, purely so repeated calls return the same
  order. It is not a claim that one tied member is ahead of the other.
- **Non-positive values are not ranked at all.** A member with zero guild chat
  is absent from the guild-chat board rather than ranked last, and a profile
  with its API off is *unknown*, not "poorest in the guild".
- **Only active members of the guild are ranked.** Someone who left keeps their
  history — the ledger and the snapshots are not rewritten — but a leaderboard
  is a statement about the guild as it stands.

**Where am I.** The caller's own row is appended below the page rather than
merged into it: it answers a different question, and slotting a rank-41 row into
the top ten would misrepresent the ranking. A caller who is not ranked simply
has no such line — including an unlinked caller on a snapshot board, whose
values are keyed by uuid.

**In guild chat**, `!leaderboard` / `!top` returns the top five on one line. The
`page` and `days` options are Discord-only: in-game args are positional, and a
second number would make `!top wealth 2` ambiguous with a category.

**No panel surface.** Leaderboards are member-facing, and the web panel is
admin-only — there is deliberately no leaderboard page, and no staff control
over who appears on one.

---

## 20. Member Bot — Fun

Six live commands whose entire job is that guild chat is a social room. They are
listed here because they are held to constraints the rest of the platform is
not, and those constraints are the design.

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/8ball` | Ask the magic 8-ball | Member | `question` (required) | One of the classic twenty answers | Nothing asked | None |
| `/roll` | Roll dice | Member | `dice?` (`100`, `d20`, `2d6`; default `100`) | Total, plus each die for 2–8 dice | Unparseable, or beyond `20d1000` | None |
| `/coinflip` | Flip a coin | Member | — | Heads or Tails | — | None |
| `/rps` | Rock, paper, scissors | Member | `throw` (choice, required) | The two throws and the verdict | Not one of the three | None |
| `/guildquote` | A quote from the guild's collection | Member | — | One quote | Nothing quotable (every attempt was filtered) | `GuildSetting` `fun.quotes` |
| `/cringe` | *Retired — see the note above §1.* Add one to somebody's cringe tally | Member | `player` (required) | The new total | Not a Minecraft name; no counter wired | Redis `fun:tally:*` |

**They never echo what somebody typed.** `/8ball` answers without repeating the
question, `/rps` echoes only the throw it managed to parse out of a fixed set,
and `/cringe` accepts a Minecraft name or nothing. The bridge speaks
with the guild's voice, so a command that repeats arbitrary text is a way to make
the guild say anything — through a path the chat filter was never asked about.

**A stored quote is screened before it is said.** `/guildquote` is the one
command here with an author, and an old quote can outlive the standards of the
people who added it, so it goes through the same compiled filter a relayed
message does (the same instance, so the two cannot drift apart on a stale
cache). A quote that fails is skipped, up to three attempts — a guild whose whole
list trips the filter says "nothing quotable right now" rather than walking a
hundred entries on every call. With no filter wired, quotes are said as stored.

**`/rank` is withdrawn.** It printed a made-up score out of 100 beside the word
*rank*, in a guild where rank is a real thing with real permissions attached to
it, and the disclaimer at the end of the line is not where anybody stops
reading. It is `enabled: false` rather than deleted — the handler still
compiles and the hash-not-roll behaviour that made the joke worth having is
intact, so bringing it back under a word that is not already taken is one line.

**The only state was a counter.** `/cringe`, retired, incremented a Redis key keyed by the
*typed name* — never by a Discord id — with a 90-day expiry reset on every bump,
so a joke nobody is still telling disappears on its own. The port behind it can
only add: there is no read, no reset and no listing, because a tally that can be
enumerated is a leaderboard, and a leaderboard about who is cringe is a
different decision than the one made here.

**Cooldowns are 5–15s**, longer than the lookups'. A lookup answers a question
once; these are the commands somebody will happily run twenty times to see a
different number.

**No guild config, no panel surface.** The only configurable thing is the quote
list, in `GuildSetting` `fun.quotes` — a JSON array of strings, bounded on
*read* at 100 entries of 200 characters, with anything unreadable falling back
to the shipped quotes. There is no command and no panel page to edit it, which
is deliberate for now: the shipped list is about Skyblock rather than about
anybody, and a staff-editable quote list is a content-moderation surface that
should be designed as one rather than added as a side effect of a dice roller.

**Shipped quotes are about the game, not about players.** A shipped quote list
that made jokes at a type of player would be the platform picking on someone in
a room where nobody chose it.

---

## 21. Member Bot — Discord Conveniences

The general-bot layer: things members expect from any Discord bot, spoken by the
bot they interact with. [`DISCORD_QOL.md`](DISCORD_QOL.md) covers the operator
side — configuration, limits and failure modes.

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/whois` | Who a member is here: Discord account, roles, link and standing | Public | `member?` (default you), `public?` (default off) | Ephemeral card; `public:true` posts the Discord half in the channel. Title links the full-size avatar and the url is in the text fallback | Discord has no account with that id; no gateway on this deployment | Discord (gateway cache), `LinkedIdentity`, XP standing, `MemberRecord` (caller only) |
| `/serverinfo` | This Discord server at a glance | Public | — | Embed: the Discord half (members, channels, roles, emoji, boosts, owner, created) and the platform's own week (tracked and linked members, active members, Discord and guild-chat message counts, the busiest member) | Bot cannot see the server → says so | Discord (gateway) + DB (`ActivityDaily`, `GuildMember`, `LinkedAccount`) |
| `/levelalerts` | Turn your own level-up announcements on or off | Member | `state?` (`on`/`off`; blank shows where you stand) | Ephemeral confirmation | — | `GuildSetting` `levels.optOut` |
| `/remind` | Have the bot remind you later | Member | `when` (`30m`, `2h30m`, `1w2d`), `about` | Ephemeral confirmation with a live `<t:…:R>` timestamp | Unparseable duration; under a minute or over a year; already 10 pending; over 280 characters | DB (`Reminder`) |
| `/reminders` | Your pending reminders | Member | `cancel?` (id) | Ephemeral list, or confirmation of a cancellation | Unknown id; not yours | DB (`Reminder`) |
| `/tag` | Post one of this server's canned replies | Member | `name` (required, autocomplete) | The reply, posted publicly | No reply by that name (a disabled tag reads as absent); tags not set up on this deployment | DB (ticket tag store) |

**`/serverinfo` answers from two places and says which is which.** Discord
knows how many accounts are in the server; it does not know how many of them
this platform tracks, how many have linked a Minecraft name, or who has been
talking. Those come from the same daily counters the activity leaderboards
read, over a rolling seven days, and a deployment that keeps none of them gets
the Discord half of the card and an explicit note rather than a section of
zeroes. The counts cover members, not bots: our roster is smaller than
Discord's number and is supposed to be.

**Reminders are yours alone.** There is no "remind someone else" — that would be
a way to make the bot ping a person on command — and no way to list or cancel
another member's reminders. Delivery is a row plus a one-minute sweeper rather
than a timer, so a deploy between setting and firing does not swallow one; a
reminder more than 24 hours past due is given up on, by which point the channel
is almost certainly gone.

**Tags answer in two ways.** `/tag` is an explicit ask and ignores scope —
naming a tag is always deliberate. A tag with an `autoPattern` also fires on its
own, but only where its scope allows (`TICKET`, `SERVER` or `ANY`), at most once
per channel per minute, and never on a message over 500 characters.

**Level-up announcements** go to the guild's `levels` channel, drained every
five minutes from what the XP rebuild recorded. Opting out stops the
announcement, not the XP.

---

## Cross-Cutting Behaviors (all commands)

- **Cooldowns & rate limits:** enforced in Redis before execution (`cd:{surface}:{command}:{user}`); bridge/in-game tiers are stricter than Discord.
- **Every invocation logs `CommandUsage`** (surface, command, success, latency) — buffered in Redis, flushed by `apps/workers`.
- **Permission checks** run through `packages/identity` + `BridgePermission`; staff commands additionally enforce **rank hierarchy** (can't action equals/superiors).
- **Data freshness:** lookups read Redis cache first and fall back to live Hypixel calls on miss, then re-cache. Commands surface a subtle "as of Xm ago" when serving cached data.
- **Graceful degradation:** when the Hypixel API is down, live-data commands serve last-known cache with a staleness note rather than hard-failing.
- **Ephemeral by default** for anything personal/administrative; public embeds only for shareable lookups.
