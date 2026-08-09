# Command Surface — SBR Guild Platform

Full command specification for the three surfaces: the **member-facing Bridge bot** (Discord slash commands + in-game bridge), the **staff-facing Admin bot**, and the **in-game command system** carried over the bridge.

**Data-source legend**
- **Live** — real-time Hypixel API call (via `packages/hypixel`).
- **Cache** — Redis-cached data (profiles, prices, config, permissions).
- **DB** — PostgreSQL via `packages/db` (durable records).
- Many commands are **mixed** (e.g. Cache→Live on miss, then persisted).

**Permission tiers** (resolved by `packages/identity` / `BridgePermission`): `Public` (any linked member), `Linked` (requires verified link), `Subscriber` (opt-in), `Staff` (`MODERATOR`+), `Officer` (`OFFICER`+), `Admin` (`ADMIN`/`OWNER`).

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
| `/skills` | Detailed skill levels + XP to next | Public | `player?`, `profile?`, `skill?` | Embed/table of all skills or one skill breakdown | Player not found | Cache→Live |
| `/slayer` | Slayer XP, tiers, boss kills | Public | `player?`, `profile?`, `boss?` | Embed per-slayer breakdown | Player not found | Cache→Live |
| `/dungeons` | Catacombs level, class levels, floor completions/PBs | Public | `player?`, `profile?` | Embed: cata level, classes, S+ counts | Player not found; no dungeon data | Cache→Live |
| `/networth` | Full networth breakdown (gear/reforge/gems/museum/bank) | Public | `player?`, `profile?` | Embed: total + category breakdown | Player not found; museum private | Cache→Live (`skyhelper-networth` + `pricing`) |
| `/progress` | Progression over time vs. snapshots | Linked | `metric?`, `range?` | Embed/chart-link: delta since last snapshot | No snapshots yet for account | DB (`ProfileSnapshot`) + Cache (latest) |
| `/milestones` | Achievements/thresholds the player has crossed | Public | `player?` | List of `Milestone` records w/ dates | No milestones recorded | DB (`Milestone`) |

---

## 3. Member Bot — Economy & Market

| Command | Purpose | Perms | Inputs / Options | Output | Command-specific errors | Data |
|---------|---------|-------|------------------|--------|-------------------------|------|
| `/price` | Best estimated value of an item | Public | `item` (autocomplete), `qty?` | Embed: bazaar/AH/BIN value summary | Item unknown; no market data | Cache (`pricing`) → Live refresh |
| `/bazaar` | Bazaar buy/sell/order data for an item | Public | `item` (autocomplete) | Embed: insta-buy/sell, order book summary | Item not on bazaar | Cache→Live (bazaar endpoint) |
| `/lowestbin` | Lowest BIN for an item | Public | `item` (autocomplete) | Embed: lowest BIN + link | Item has no active BIN | Cache→Live (AH) |
| `/auctions` | Active auctions for a player or item | Public | `player?` **or** `item?` | List of active auctions (price, ends) | Neither/both args; none active | Cache→Live (AH) |

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
| `/lfg` | Create a looking-for-group post | Linked | `activity`, `slots`, `details?` | Public LFG embed w/ join button | Cooldown; too many open posts | DB (`LFGPost`) + Cache (`lfg:open:*` TTL) |
| `/runs` | List open runs/LFG posts | Public | `activity?` | List of open `LFGPost`s | None open | Cache (`lfg:open:*`) → DB |
| `/joinrun` | Join an open run | Linked | `run_id` | Updated party roster; DM/ping | Run full/closed; already joined | DB + Cache (slot update) |
| `/leaverun` | Leave a run you joined | Linked | `run_id` | Updated roster | Not in run; run closed | DB + Cache |
| `/rsvp` | RSVP to a scheduled event | Public | `event_id`, `state` (going/maybe/no) | Updated RSVP + counts | Event full→waitlist; event past | DB (`EventRSVP`) |
| `/perm` | Standing parties — the group you always run with | Linked | `action` (info/list/create/roster-add/roster-remove/disband/default), `perm?`, `name?`, `activity?`, `ign?`, `role?`, `slot?`, `notes?` | Roster embed: seat, IGN, linked mention, cata/SA | Name taken; not the owner; perm full; role not valid for the activity; already/not on the roster | DB (`PermGroup`, `PermMember`) + `GuildMemberCache` and `ProfileSnapshot` for enrichment |

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
| `/set-recruitment` | Open/close applications & set requirements | Admin | `state` (open/closed), `min_weight?`, `min_networth?` | Confirmation of new recruitment config | Invalid thresholds | DB (`GuildConfig`) + Cache |

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
- **Read-only / low-risk subset only.** In-game commands expose the *lookup* commands (stats, skills, slayer, dungeons, networth, price, bazaar, lowestbin, weight, help) and lightweight LFG (`!lfg`, `!runs`, `!perm`). `!perm` requires a linked account even for its read actions, because those share one command with its writes and the weaker of the two requirements would otherwise govern the pair. **Never** exposes moderation, linking-secret, or config commands — those require Discord identity + permission tiers that can't be safely proven from guild chat alone.
- **Cooldowns are stricter** (per-IGN Redis `cd:ingame:*`) because guild chat is spam-prone and rate-limited by Hypixel itself.
- **Identity is by IGN → `LinkedAccount`.** If the IGN isn't linked, commands still work for public lookups but personalized commands (`/me`, `/whatnext`) reply with a "link on Discord" hint.

| In-game command | Maps to | Perms | Data |
|-----------------|---------|-------|------|
| `!stats`, `!skills`, `!slayer`, `!dungeons`, `!nw` | `/stats` … `/networth` | `RELAY_MESSAGE`+`RUN_COMMAND` | Cache→Live |
| `!price`, `!bz`, `!lbin` | `/price`,`/bazaar`,`/lowestbin` | Run cmd | Cache→Live |
| `!weight` | `progression` (Senither/farming) | Run cmd | Cache→Live |
| `!lfg`, `!runs` | `/lfg`,`/runs` | Run cmd (linked) | DB + Cache |
| `!perm` | `/perm` | Run cmd (linked) | DB + member cache |
| `!help` | `/help` (condensed) | Public | Static |

**In-game error handling:** invalid command → short usage hint; on cooldown → silent or `⌛` reply; API failure → `⚠ data unavailable, try later`; unauthorized → `no permission` one-liner. Errors never dump stack traces into guild chat.

---

## Cross-Cutting Behaviors (all commands)

- **Cooldowns & rate limits:** enforced in Redis before execution (`cd:{surface}:{command}:{user}`); bridge/in-game tiers are stricter than Discord.
- **Every invocation logs `CommandUsage`** (surface, command, success, latency) — buffered in Redis, flushed by `apps/workers`.
- **Permission checks** run through `packages/identity` + `BridgePermission`; staff commands additionally enforce **rank hierarchy** (can't action equals/superiors).
- **Data freshness:** lookups read Redis cache first and fall back to live Hypixel calls on miss, then re-cache. Commands surface a subtle "as of Xm ago" when serving cached data.
- **Graceful degradation:** when the Hypixel API is down, live-data commands serve last-known cache with a staleness note rather than hard-failing.
- **Ephemeral by default** for anything personal/administrative; public embeds only for shareable lookups.
