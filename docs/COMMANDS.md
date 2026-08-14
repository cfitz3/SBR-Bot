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

## 1. Member Bot — Account & Identity

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/link` | Link a Discord user to a Minecraft account by matching Hypixel's in-game social Discord field against the caller | Public | `ign` (string) | On match: success embed + role grant. On mismatch: instructions to set the Discord social link in-game (`/api`→profile→social) and rerun | IGN not found; **Hypixel social Discord field empty/unset** → reject; **social field ≠ caller** → reject; another user already owns this MC account | Live (resolve UUID + read Hypixel social field) + DB (create `LinkedAccount` `VERIFIED`) + Cache |
| `/verify` | Re-run the Hypixel social check to (re)confirm or repair an existing/pending link | Public | `ign?` | Success embed + role sync, or the same mismatch guidance as `/link` | No account to verify; social field unset or mismatched | Live (re-check Hypixel social) + DB (set `VERIFIED`) + Cache |
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
| `/skills` | Detailed skill levels + XP to next | Public | `player?`, `profile?`, `skill?` | Embed/table of all skills or one skill breakdown, with each skill's cap and a count of those at it | Player not found | Cache→Live |
| `/slayers` | Slayer XP, tiers, per-tier boss kills | Public | `player?`, `profile?`, `boss?` | Embed per-slayer breakdown; naming one boss adds its per-tier kill counts | Player not found | Cache→Live |
| `/slayer` | **Deprecated** alias of `/slayers`, kept for one release | Public | as `/slayers` | Same answer, prefixed with the new name | — | Cache→Live |
| `/dungeons` | Catacombs level, class levels, floor completions/PBs | Public | `player?`, `profile?` | Embed: cata level and XP to the next, class levels and average, completions per floor (normal and master), fastest S+ | Player not found; no dungeon data | Cache→Live |
| `/networth` | Full networth breakdown (gear/reforge/gems/museum/bank) | Public | `player?`, `profile?` | Embed: total + category breakdown with each category's share and its three most valuable items | Player not found; museum private | Cache→Live (`skyhelper-networth` + `pricing`) |
| `/progress` | Progression over time vs. snapshots | Linked | `metric?`, `range?` | Embed/chart-link: delta since last snapshot | No snapshots yet for account | DB (`ProfileSnapshot`) + Cache (latest) |
| `/milestones` | The guild's achievements and the player's standing against them | Public | `player?` | Earned (newest first, with XP paid) + closest unearned w/ progress bars, `n/total` headline, "measured" footer | Achievements off → says so; no snapshot → thresholds listed, progress "not measured yet" | DB (`Milestone`, `MilestoneDefinition`, `ProfileSnapshot`) |

---

## 3. Member Bot — Economy & Market

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/price` | Best estimated value of an item | Public | `item` (autocomplete), `qty?` | Embed: bazaar/AH/BIN value summary | Item unknown; no market data | Cache (`pricing`) → Live refresh |
| `/bazaar` | Bazaar buy/sell/order data for an item | Public | `item` (autocomplete) | Embed: insta-buy/sell, order book summary | Item not on bazaar | Cache→Live (bazaar endpoint) |
| `/lowestbin` | Lowest BIN for an item | Public | `item` (autocomplete) | Embed: lowest BIN + link | Item has no active BIN | Cache→Live (AH) |
| `/auctions` | A player's auction standing, or an item's cheapest listings | Public | `player?` **or** `item?` | For a player: sold-but-unclaimed (with the coins waiting), expired-unsold, and active. For an item: cheapest listings | Neither/both args; none active | Cache→Live (AH) |

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
| `/perm` | Standing parties — the group you always run with | Linked | `action` (info/list/create/roster-add/roster-remove/disband/default), `perm?`, `name?`, `activity?`, `ign?`, `role?`, `slot?`, `notes?` | Roster embed: seat, IGN, linked mention, cata/SA | Name taken; not the owner; perm full; role not valid for the activity; already/not on the roster | DB (`PermGroup`, `PermMember`) + `GuildMemberCache` and `ProfileSnapshot` for enrichment |

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
and a roster of seats. One command with an `action` option rather than seven
top-level commands, for the same reason `/ticket` is one command.

Three properties are worth stating because they are load-bearing:

- **Addressed by name.** Names are unique per guild while a perm is *active*,
  compared case-insensitively, and freed for reuse on disband — enforced by a
  partial unique index, since people type `/perm perm:F7 core` from memory in
  guild chat. Ids still work anywhere a name does.
- **Rosters are keyed by IGN.** A linked Discord account and a uuid are attached
  when they can be resolved and their absence is never an error. Perms are formed
  in-game, and most of a Hypixel guild has never linked an account.
- **Enrichment never calls Hypixel.** The in-guild marking comes from the 6 h
  member cache and the cata/SA columns from the newest stored `ProfileSnapshot`,
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

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/help` | List commands / show help for one | Public | `command?` | Embed: command catalog or detail | Unknown command | Static + DB (feature flags to hide disabled cmds) |
| `/online` | Who's in the guild right now, by rank | Public | — | Embed: rank sections + online/total counts | Bridge offline (temporary); no in-game bridge configured (permanent) — reported separately | In-game `/g online` via the bridge session (20s shared cache) |

`/online` reads the **live** roster from the Mineflayer session rather than the
Hypixel API: the guild endpoint lists members but carries no presence, and
resolving that would cost one `/status` call per member. Discord-only — in-game
the answer is `/g online`, which any player can type without spending the bridge
account's command budget. Every invocation inside the cache window shares one
answer, because a spammed command gets the bridge account silenced and that
takes the whole relay down, not just this command.

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
- **Read-only / low-risk subset only.** In-game commands expose the *lookup* commands (stats, skills, slayers, dungeons, networth, price, bazaar, lowestbin, weight, help) and lightweight LFG (`!lfg`, `!runs`, `!perm`). `!perm` requires a linked account even for its read actions, because those share one command with its writes and the weaker of the two requirements would otherwise govern the pair. The **fun** commands (§20) are in-game too: they read nothing about anybody and write nothing anybody is accountable for. **Never** exposes moderation, linking-secret, or config commands — those require Discord identity + permission tiers that can't be safely proven from guild chat alone.
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
| `!price`, `!bz`, `!lbin` | `/price`,`/bazaar`,`/lowestbin` | Run cmd | Cache→Live |
| `!weight` | `progression` (Senither/farming) | Run cmd | Cache→Live |
| `!lfg`, `!runs` | `/lfg`,`/runs` | Run cmd (linked) | DB + Cache |
| `!perm` | `/perm` | Run cmd (linked) | DB + member cache |
| `!standing` | `/standing` | Run cmd (linked) | DB (`XpBalance`, `XpEvent`) |
| `!help` | `/help` (condensed) | Public | Static |
| `!8ball`, `!roll`, `!coinflip`, `!rps`, `!guildquote`, `!rank`, `!cringe` | §20 | Public | None (Redis counter for `!cringe`) |

`!standing` is `"linked"` although it writes nothing. XP is attributed to a
Discord account, so an IGN that resolves to no link has no standing to report —
here the link is the *lookup key*, not a permission.

**In-game error handling:** invalid command → short usage hint; on cooldown → silent or `⌛` reply; API failure → `⚠ data unavailable, try later`; unauthorized → `no permission` one-liner. Errors never dump stack traces into guild chat.

---

## 18. Member Bot — Guild XP & Standing

Guild XP is a **platform-side** progression track: it measures participation in
*this guild* (guild XP contributed, chat, commands, events, tenure), not
Skyblock progress. Nothing here reads Hypixel except the GEXP figure the roster
scan already stores.

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/standing` | A member's guild XP, level, rank and where the XP came from | Linked | `member?` | Embed: level + progress bar, rank, tenure, per-source breakdown | XP not enabled; member has never earned any | DB (`XpBalance`, `XpEvent`) |
| `/me` | Personal summary; now also carries level, total XP, rank and the caller's own record | Linked | — | Existing embed + "Guild standing", "Tenure" and "Your record" fields | (standing and record failures degrade silently) | DB |

**Visibility.** `/standing` with no argument is public in-channel; `/standing
member:` is **ephemeral**. Someone else's standing is theirs to publish, and a
command that posts it for them turns a lookup into an announcement.

**Freshness.** Standings are derived, not live: the `xp-aggregate` job weights
each day's activity counters into the ledger every three hours (see
`WORKERS.md`). The embed says so in its footer rather than implying today's
chat is already counted.

**Two documented deviations from the original plan (Phase 5):**

- **`/profile` shows no standing.** `/profile` addresses a *player* by IGN,
  while standing is keyed by Discord id, and `IdentityService` exposes no
  IGN → Discord id resolution. Widening that interface for a decorative field
  would have touched every fake of it in the test suite. Standing therefore
  lands on `/me` — the one lookup certain the account and the person are the
  same — and on `/standing member:`.
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
| `/leaderboard` | Guild rankings across nine categories (SkyBlock Level leads) | Member | `category?` (choice, default `xp`), `page?`, `days?` (1–365, activity boards only) | Embed: ranked page with 🥇🥈🥉, the viewer's own row appended, footer with page, total ranked, window and staleness | Leaderboards not enabled; unknown category (lists the real ones) | DB (`ProfileSnapshot`, `GuildMember`, `ActivityDaily`, `XpBalance`) |

**The catalog is closed.** `wealth`, `tenure`, `skill-average`, `catacombs`,
`slayer`, `discord-activity`, `guild-chat`, `xp`. A leaderboard is a claim about
the guild, and each of these has a stated source and a stated freshness — an
open-ended "rank by any metric" surface could make neither promise. Common
spellings are accepted (`nw`, `cata`, `sa`, `gc`, `top`), so guild chat does not
have to type the canonical id.

**Sources and freshness.**

| Family | Source | How fresh |
|--------|--------|-----------|
| `SNAPSHOT` — wealth, skill average, catacombs, slayer | newest `ProfileSnapshot` per linked account | up to one snapshot cycle behind (~6–12h) — the *only* family that can be stale |
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

Seven commands whose entire job is that guild chat is a social room. They are
listed here because they are held to constraints the rest of the platform is
not, and those constraints are the design.

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/8ball` | Ask the magic 8-ball | Member | `question` (required) | One of the classic twenty answers | Nothing asked | None |
| `/roll` | Roll dice | Member | `dice?` (`100`, `d20`, `2d6`; default `100`) | Total, plus each die for 2–8 dice | Unparseable, or beyond `20d1000` | None |
| `/coinflip` | Flip a coin | Member | — | Heads or Tails | — | None |
| `/rps` | Rock, paper, scissors | Member | `throw` (choice, required) | The two throws and the verdict | Not one of the three | None |
| `/guildquote` | A quote from the guild's collection | Member | — | One quote | Nothing quotable (every attempt was filtered) | `GuildSetting` `fun.quotes` |
| `/rank` | An unofficial vibe rank | Member | `player?` (default you) | A title, a score out of 100, and a disclaimer | Not a Minecraft name; unlinked caller with no name given | None |
| `/cringe` | Add one to somebody's cringe tally | Member | `player` (required) | The new total | Not a Minecraft name; no counter wired | Redis `fun:tally:*` |

**They never echo what somebody typed.** `/8ball` answers without repeating the
question, `/rps` echoes only the throw it managed to parse out of a fixed set,
and `/rank` and `/cringe` accept a Minecraft name or nothing. The bridge speaks
with the guild's voice, so a command that repeats arbitrary text is a way to make
the guild say anything — through a path the chat filter was never asked about.

**A stored quote is screened before it is said.** `/guildquote` is the one
command here with an author, and an old quote can outlive the standards of the
people who added it, so it goes through the same compiled filter a relayed
message does (the same instance, so the two cannot drift apart on a stale
cache). A quote that fails is skipped, up to three attempts — a guild whose whole
list trips the filter says "nothing quotable right now" rather than walking a
hundred entries on every call. With no filter wired, quotes are said as stored.

**A vibe rank sticks.** `/rank` hashes the subject rather than rolling, so the
same person gets the same rank next week. A joke rank that rerolls is a random
number generator; one that sticks is something people compare and argue about.
The reply says it is not a real rank, because guild ranks are a real thing with
real permissions attached.

**The only state is a counter.** `/cringe` increments a Redis key keyed by the
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

## Cross-Cutting Behaviors (all commands)

- **Cooldowns & rate limits:** enforced in Redis before execution (`cd:{surface}:{command}:{user}`); bridge/in-game tiers are stricter than Discord.
- **Every invocation logs `CommandUsage`** (surface, command, success, latency) — buffered in Redis, flushed by `apps/workers`.
- **Permission checks** run through `packages/identity` + `BridgePermission`; staff commands additionally enforce **rank hierarchy** (can't action equals/superiors).
- **Data freshness:** lookups read Redis cache first and fall back to live Hypixel calls on miss, then re-cache. Commands surface a subtle "as of Xm ago" when serving cached data.
- **Graceful degradation:** when the Hypixel API is down, live-data commands serve last-known cache with a staleness note rather than hard-failing.
- **Ephemeral by default** for anything personal/administrative; public embeds only for shareable lookups.
