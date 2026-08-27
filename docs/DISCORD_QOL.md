# Discord QoL Layer — Operator Guide

What the platform does *to* a Discord server, rather than what it reads out of
one: auto-roles, greetings, self-service role menus, and the small member-facing
conveniences people expect from a general Discord bot.

Design rationale and the decisions behind each phase live in
[`DISCORD_QOL_PLAN.md`](DISCORD_QOL_PLAN.md). This document is the operator's
half — what exists, which bot performs it, where it is configured, and what it
does when something is wrong.

---

## 0. Which bot does what

| | Application | Owns |
| --- | --- | --- |
| **SBR Bot / SBR Bridge** | one Discord application (`apps/bridge-bot`) | **every member interaction** — anything a member sees, clicks, or is addressed by |
| **SBR Admin** | a separate application (`apps/admin-bot`) | **staff-facing surfaces and automated work**, including every privileged write to Discord |

The dividing line is *audience*, not mechanism. A welcome message is a member
interaction and is spoken by SBR Bot even though a machine decided to send it. A
role grant is automated work and is performed by SBR Admin even though a member
is the one who ends up with the role.

Where a feature has both halves — staff configure it, members see it — the
configuration lives with the admin bot (same database, so it works with the
bridge down) and the message is posted by the bridge bot over its loopback
internal API. `/rolemenu` and `/sticky` are both built this way.

**Operational prerequisite.** SBR Admin needs **Manage Roles**, and its own
highest role must sit **above** every role it is asked to hand out. This is
never assumed: the preflight (§1) computes it from facts and the panel's Roles
page shows the answer. A server that invited only SBR Bot has no effector at
all, and the panel says so rather than silently doing nothing.

---

## 1. The role effector and its preflight

`POST /internal/g/:guildId/roles` on the admin bot — loopback-bound, bearer
token, same trust domain as the rest of the internal API.

```jsonc
{ "userId": "…", "add": ["roleId"], "remove": ["roleId"], "reason": "Automatic role" }
```

Answers `{ ok, memberPresent, added, removed, refused, error? }`. Only ids in
`added` / `removed` actually changed; `refused` carries a reason per role.

**What it refuses**, from `apps/admin-bot/src/role-preflight.ts` — a pure module,
so the same rules run in the panel (a bad rule cannot be saved), in the effector
(a rule saved before the server was reorganised cannot be executed), and in the
picker (an ungrantable role is greyed out rather than offered):

| Refusal | Why |
| --- | --- |
| Role carries a dangerous permission (Administrator, Manage Roles, …) | Staff promotion should be a human act with a name attached |
| Role is above or equal to the bot's highest role | Discord would refuse anyway; refusing first gives a readable reason |
| Role is `managed` (owned by an integration) or `@everyone` | Not assignable at all |
| The bot lacks Manage Roles | Reported once, not once per role |

Removal is screened more loosely on purpose: a role that was harmless when it
was granted and has since been given Manage Roles is precisely the one that most
needs to be revocable.

**Discord errors that are not failures.** `10011` unknown role and `10007`
unknown member mean the desired state already holds — the member left between
the reconciler reading and the call, or the role was deleted — and are reported
as success with nothing changed.

---

## 2. Auto-roles

### Configuration — `GuildSetting["roles.auto"]`

```jsonc
{
  "version": 1,
  "enabled": true,
  "rules": [
    { "key": "guild-member", "label": "Guild member", "trigger": { "kind": "IN_GUILD" },
      "roleId": "…", "revokeWhenUnqualified": true, "enabled": true },
    { "key": "verified",     "trigger": { "kind": "LINKED" },        "roleId": "…" },
    { "key": "rank-officer", "trigger": { "kind": "GUILD_RANK", "rank": "Officer" }, "roleId": "…" },
    { "key": "level-25",     "trigger": { "kind": "XP_LEVEL", "atLeast": 25 },       "roleId": "…" },
    { "key": "cata-40",      "trigger": { "kind": "ACHIEVEMENT", "definitionKey": "cata:40" }, "roleId": "…" },
    { "key": "regular",      "trigger": { "kind": "EVENTS_ATTENDED", "atLeast": 10 }, "roleId": "…" }
  ]
}
```

`key` is stable and is what the ledger records — renaming a `label` does not
orphan grants, changing a `key` does. Read tolerantly (`parseAutoRoles` in
`@sbr/roles`), written strictly through the panel.

### Triggers

| Trigger | Qualifies when | Source of truth | Marked dirty by |
| --- | --- | --- | --- |
| `IN_GUILD` | `GuildMember.status = ACTIVE` | `GuildMember` | `guild-scan` join/leave diff, the `JOINED` relay event |
| `LINKED` | a verified `LinkedAccount` exists | `LinkedAccount` | link / unlink |
| `GUILD_RANK` | in-game rank at or above the named one | `GuildMember.guildRank` | `guild-scan` rank diff |
| `XP_LEVEL` | `level >= atLeast` | `XpBalance` | *(nothing — see below)* |
| `ACHIEVEMENT` | a `Milestone` row for that definition key exists | `Milestone` | the milestone announcer |
| `EVENTS_ATTENDED` | `count(EventAttendance) >= atLeast` | `EventAttendance` | event completion |
| `MANUAL` | granted by staff; never auto-revoked | `RoleGrant` | — |

`XP_LEVEL` has no mark of its own — awards land on several paths — so those
rules are picked up by the daily full sweep and can be up to a day late.
Milestone rewards are the exception, because detecting the milestone marks the
member.

### Reconciliation, not event handling

The `role-sync` worker job runs **every 15 minutes** (`11-59/15 * * * *`,
`LANE.bulk`). For each member it asks what the rules say should be true,
compares that to what is true, and fixes the difference. That is what makes a
gateway event dropped during a deploy heal itself, a rule written today apply to
members who qualified last year, and a role removed by hand come back.

- **Promptness comes from the dirty set** `roles:dirty:<guildId>` (Redis).
  Losing it costs latency, never correctness: a full sweep per guild marks
  everyone once a day regardless. Every writer swallows its own failures rather
  than failing the user action that caused the mark.
- **And from a nudge.** Marking a member also publishes on `chan:role-nudge`;
  the workers answer it by reconciling that one member on the spot. Somebody who
  links their account has their roles within seconds, not at the next pass.
- **Two honesty rules carry the ledger.** A removal requires an **open**
  `RoleGrant` row for that member, role and rule — a role given by hand, by
  another bot, or by a since-deleted rule is left alone. And only roles Discord
  confirmed in `added` are recorded, because a row for a grant that never
  happened would authorise revoking a role we never gave.
- A failed call claims nothing and re-queues the member.

### Why both paths, and why neither one replaces the other

The immediate path is an optimisation over the sweep. It is not a replacement,
and the sweep must not be turned into a pure event listener with no periodic
fallback — three things depend on it:

- **Revocation is only safe because something reconciles everyone eventually.**
  "Only remove what we granted" is a statement about the ledger, and the ledger
  is only trued up by a pass that visits members nothing happened to.
- **A dropped event heals.** Gateway events are lost during deploys; pub/sub
  drops messages published while the workers are down. Both are latency, not
  loss, precisely because the mark is written to Redis *before* the nudge is
  published and nothing but the sweep consumes it.
- **A rule written today is retroactive.** There is no event to replay for a
  member who qualified last year.

So the immediate path never drains the dirty set, never retries, and never
surfaces an error to the member who triggered it. A reconcile that fails logs a
warning and stops; the mark is still there and the next pass owns the retry.

**It is paced, and that is not optional.** Discord's role bucket is roughly ten
modifications per ten seconds *per guild*, one member can cost two calls (an add
and a remove), and there is no batch role-add endpoint — it is one HTTP call per
member per direction. A token bucket in front of the immediate path
(`packages/jobs/src/role-nudge.ts`: one member at a time, one every 2.5s, 50
waiting per guild, no nudges at all for a mark covering more than 25 members)
keeps twenty simultaneous links inside that budget by spreading them over the
following minute. Anything refused is still marked dirty.

**Nothing writes a role from a gateway handler.** `guildMemberAdd` marks the
member and returns; the write still goes through the effector, its preflight and
the grant ledger. That preflight is what refuses Administrator, Manage Roles and
Ban Members grants, and a listener that called `member.roles.add` directly would
be a way around every one of those rules.

**XP and leaderboards stay batched, on purpose.** XP is awarded per message, so
marking a member dirty on each award would nudge on every chat line in the
server and spend the guild's whole role budget discovering that nobody crossed a
level boundary. The daily re-derive is what makes `XP_LEVEL` rules correct; a
level-up worth rewarding promptly is a milestone, and milestones do mark.
Leaderboards are read straight from Postgres on each request
(`leaderboardSource`) with no cache in front of them, so they already reflect
recent changes — there is nothing to invalidate, and adding a cache purely so it
could be invalidated would introduce staleness where none exists today.

Full worker behaviour: [`WORKERS.md` §2.7d](WORKERS.md). Ledger semantics:
[`DOMAIN_MODEL.md` → RoleGrant](DOMAIN_MODEL.md). Keyspace:
[`REDIS_KEYSPACE.md` §8b](REDIS_KEYSPACE.md).

### Dry run

Before saving a policy, the panel answers *"this would grant 214 and revoke 3"*
using the reconciler's own resolver over real open-grant rows — not a second
estimate. A deployment with no roster to look at **refuses** rather than
reporting zeroes: "nothing would change" and "I could not look" are different
answers, and only one is safe to act on.

---

## 3. Welcome, farewell and guild-join messages

`GuildSetting["discord.welcome"]`:

```jsonc
{
  "version": 1,
  "join":  { "enabled": true, "channelSlot": "welcome", "mode": "EMBED",
             "text": "Welcome {user} to {server} — you're member #{memberCount}.",
             "dm": null, "deleteAfterSeconds": null },
  "leave": { "enabled": false, "channelSlot": "welcome", "text": "{username} left." },
  "guildJoin": { "enabled": true, "channelSlot": "bridge", "text": "{ign} joined the guild." }
}
```

All three default to `enabled: false` — installing the platform changes no
channel until somebody turns a greeting on.

**How it flows.** The admin bot observes `GuildMemberAdd` / `GuildMemberRemove`
— it already holds the `GuildMembers` intent — and publishes on the Redis member
bus (`chan:member:<guildId>`). SBR Bot subscribes and does the talking. The
payload carries everything the greeter needs to render, because a member who has
just left cannot be fetched and half a farewell is worse than none.

**Tokens** are a closed set: `{user}` (a mention), `{username}`, `{server}`,
`{memberCount}`, `{ign}`, `{guildRank}`, `{level}`. Anything else renders as the
literal characters typed, so a typo looks like a typo rather than like an
outage. Substitution is a single pass, so a nickname of `{user}` cannot expand
twice, and `@everyone` is neutered in the renderer *as well as* by
`allowedMentions` — neither is the only thing standing between an admin's typo
and eight hundred notifications.

Profile facts (`{ign}`, `{guildRank}`, `{level}`) cost three queries and are
fetched only when a template actually names one. Most welcomes do not.

The DM is sent independently of the channel post: everybody's privacy settings
are their own, and a closed DM must not cost the whole server its welcome.

`guildJoin` fires off the in-game `JOINED` screening path, so it is the Hypixel
guild, not the Discord server. The `welcome` channel slot is bound like any
other, through `/set-channel` or the panel's Mapping card.

---

## 4. Self-service role menus

`GuildSetting["roles.menus"]` — up to **10 menus** per guild, **25 options**
each, keys matching `^[a-z0-9]+(?:[-.][a-z0-9]+)*$`.

The message, the buttons and the interaction handler are SBR Bot's; the grant
itself is an effector call, so a menu can never offer a role the preflight would
refuse. Staff post one with:

```
/rolemenu action:post id:<menu> channel:<#where>      (Officer)
/rolemenu action:list                                  (Officer)
```

`list` reads the document directly and therefore works with the bridge bot down;
`post` needs it, and says so plainly when it cannot be reached. Menus are edited
on the panel's Roles page.

---

## 5. Member conveniences

All member-facing, all on SBR Bot.

| Command | What it does | Notes |
| --- | --- | --- |
| `/whois [member] [public]` | Who a member is here, in one card | Ephemeral unless `public:true`; standing and your record are private-only |
| `/serverinfo` | The server at a glance | 10s cooldown |
| `/levelalerts [on\|off]` | Your own level-up announcements | Blank shows where you stand |
| `/remind <when> <about>` | A reminder to yourself | `30m`, `2h30m`, `1w2d` |
| `/reminders [cancel:<id>]` | Your pending reminders | Ephemeral |
| `/tag <name>` | Post one of this server's canned replies | Autocompleted |

### Level-up announcements

The workers rebuild XP balances on their schedule and record every climb; the
bridge bot drains what is waiting into the guild's `levels` channel every five
minutes, 25 rows a pass. The `announced` flag rather than an event, so a bot that
was down for the nightly rebuild finds the backlog when it returns.

`/levelalerts off` stores the member in `GuildSetting["levels.optOut"]`. An
opted-out row is marked announced **without** being posted — the alternative is a
queue that grows forever with messages nobody will receive. Opting out does not
affect earning XP or levels. With no `levels` channel bound, rows wait rather
than being discarded.

### Reminders

A `Reminder` row and a sweeper, not a `setTimeout`: the ones worth setting are
hours or days out and a deploy in between must not swallow them. One minute
minimum, one year maximum, 10 pending per member per guild, 280 characters.

The sweeper runs every minute inside the bridge bot, delivers then flips
`delivered` — so a crash mid-post repeats a reminder rather than losing one — and
gives up on a row **24 hours** past due, by which point the channel is almost
certainly gone rather than busy.

Everything is scoped to the caller. There is no "remind someone else", which
would be a way to make the bot ping a person on command, and no way to see or
cancel another member's reminders.

### Tags and autoresponders

Tags generalise the ticket tag store. Each has a name, content, an optional
`autoPattern`, and a **scope**:

| Scope | Fires on its own in |
| --- | --- |
| `TICKET` | ticket channels only (the original behaviour, and the default) |
| `SERVER` | ordinary channels only |
| `ANY` | both |

`/tag <name>` is an explicit ask and **ignores scope** — naming a tag is always
deliberate. Automatic firing is the scoped half, and is deliberately cheap:

- messages longer than **500 characters** are skipped before any read, so a
  pasted log costs nothing;
- the compiled tag list is read at most once a minute per guild;
- a fired tag is on cooldown for that channel for a minute, so one enthusiastic
  pattern cannot turn a channel into a firehose;
- a failed read reuses the last good list rather than silently disabling every
  tag in the fleet.

A disabled tag is treated as absent, including in autocomplete.

### Sticky messages

One note a guild wants to stay at the bottom of a channel — the rules line
nobody scrolls up to. Reposted as the channel moves rather than pinned, because
a pin is one click away and the bottom of the channel is where people are
already looking.

```
/sticky action:list                                   (Officer)
/sticky action:set message:<text> [channel:<#c>]      (Officer)
/sticky action:clear [channel:<#c>]                   (Officer)
```

Stored in `GuildSetting["discord.sticky"]` — up to **15 channels**, **1,000
characters** each (shorter than Discord's 2,000 on purpose: a sticky that fills
a screen makes the channel unreadable, which is the opposite of what it was
added for). One channel, one sticky. `enabled: false` keeps the text without
reposting it, so a seasonal notice can be switched off rather than retyped.

Behaviour worth knowing:

- **A repost posts, then deletes.** The sticky is briefly duplicated rather than
  briefly missing, and a failed delete leaves a stale copy rather than an empty
  channel.
- **A channel is quiet for 15 seconds after a repost**, checked before any
  settings read. A burst of messages can therefore leave the sticky a few lines
  up until someone speaks again. That is the accepted trade — the alternative is
  a timer per channel for a few seconds of tidiness.
- **Bot messages are ignored**, so the sticky cannot react to its own arrival,
  and mentions are stripped, so text reposted forever can never become an
  `@everyone`.
- `set` and `clear` apply immediately through the bridge. If the bridge cannot
  be reached the reply says so — *"It'll appear the next time somebody talks
  there"* — because the configuration **is** saved and the channel will catch
  up. That is "not yet", not a failed command.
- The live message id lives in the bridge process's memory, not the database. A
  restart leaves at most one orphan message per channel, superseded by the next
  repost.

There is no panel surface for stickies yet; they are managed through `/sticky`.

### Not built, and why

- **`/rank`** — already exists as a joke command (`packages/commands-bridge/src/fun.ts`),
  and `/me` plus `/standing` already deliver level, XP and record. A third
  spelling of the same answer is not a feature.
- **Starboard** — deferred: needs `GuildMessageReactions` on the shared
  member-facing token and a reaction hot path.
- **Birthdays** — deferred: storing a date of birth for minors is a privacy
  decision, not a feature decision.
- **Economy / gambling** — no: a second currency competing with guild XP.
- **Music** — no: wrong product.

---

## 6. Failure modes, in the words operators will see

| Symptom | Meaning |
| --- | --- |
| Roles page reports the bot cannot manage roles | SBR Admin lacks Manage Roles, or its highest role sits below the target — fix in Discord, nothing here can work around it |
| A rule appears in the refusals list | The role was refused by the preflight; the reason is on the card |
| Auto-roles are correct but late | Expected for `XP_LEVEL` (daily sweep); otherwise check `role-sync` on Health |
| Dry run refuses instead of showing counts | No roster to compare against — do not save on the assumption it would change nothing |
| Welcome message never appears | No `welcome` channel bound, or `join.enabled` is false; a failed DM never suppresses the channel post |
| `/rolemenu post` or `/sticky set` says the bridge is unreachable | The document saved; the message in the channel did not. Retry once the bridge bot is up |
| Level-ups stop appearing for one member | They ran `/levelalerts off` |
| A reminder never arrived | Channel deleted, or more than 24 hours past due |

---

## 7. Where each piece lives

| Concern | Module |
| --- | --- |
| Preflight (pure) | `apps/admin-bot/src/role-preflight.ts` |
| Effector | `apps/admin-bot/src/internal-api.ts` → `applyRoles` |
| Rules, resolver, menus, welcome renderer (pure) | `packages/roles` |
| Sticky document (pure) | `packages/guild-config/src/sticky.ts` |
| Tag matching and scope (pure) | `packages/tickets/src/tags.ts` |
| Member observer | `apps/admin-bot/src/member-observer.ts` |
| Greeter, level announcer, reminder sweeper, sticky keeper, autoresponder | `apps/bridge-bot/src/{welcome,levels,reminders,sticky,autoresponder}.ts` |
| Staff commands | `packages/commands-admin/src/handlers.ts` (`/rolemenu`, `/sticky`) |
| Member commands | `packages/commands-bridge/src/handlers-{info,levels,remind,tags}.ts` |
| Reconciler | `apps/workers/src/jobs.ts` → `role-sync` |
| Panel page | `apps/web-panel/client/pages/roles.ts` |
