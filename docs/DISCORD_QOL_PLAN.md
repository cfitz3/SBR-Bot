# Discord QoL Layer — Plan

Scope: **configurable auto-roles, welcome/farewell messages, self-service role
menus, and the small member-facing conveniences people expect from a general
Discord bot.** Everything the platform does today points *inward* — it reads
Discord and writes Postgres. This is the first body of work that makes it write
Discord back, which is why most of the decisions below are about restraint
rather than features.

Status: **planned, not started.** Written 2026-08-20, after Phase 16b.

---

## 0. What already exists, and what is genuinely missing

| Capability | Today | Needed |
| --- | --- | --- |
| Read a member's Discord roles | `discord-member-sync` mirrors `GuildMember.roleIds` every 2h | — |
| Roles → platform authority | `resolveMemberRole` in `@sbr/guild-config` | — |
| Grant or remove a Discord role | **nothing** | new |
| Observe someone joining the *Discord server* | **nothing** — the bridge bot runs without the `GuildMembers` intent; the admin bot has it but ignores member events | new |
| Observe someone joining the *Hypixel guild* | `transport.ts` `event.kind === "JOINED"`, plus `guild-scan`'s joined/left diff | reuse |
| Observe a link | `IdentityServiceImpl.linkByIgn` | reuse |
| Observe an achievement | the milestone announcer's pass | reuse |
| Per-guild config blobs | `GuildSetting` + tolerant `parseX` (see `parseAutomod`) | reuse |
| Privileged Discord writes | admin bot `POST /internal/g/:id/enforce` (kick/ban/timeout) | extend |

The gap is narrow and specific: **an effector, a rule model, and a way to hear
about Discord-side membership.** Everything else is wiring into hooks that
already fire.

---

## 1. Governing decisions

**1. Role writes go through the admin bot's internal API.** A second token
holding Manage Roles is a second thing to leak. The admin bot already owns the
privileged Discord write path (`/enforce`), already has the `GuildMembers`
intent, and is already the process the panel calls for anything that has to
*reach* Discord. Granting a role is a permission grant, so it belongs on the
same audited chokepoint as a ban — not on the member-facing bridge token.

**2. Desired state, not events.** Every rule resolves to *the set of roles this
member should hold right now*, and the effector diffs that against what they do
hold. Event handlers only mark a member dirty. This is the difference between a
feature that works and one that quietly rots: gateway events are dropped during
a reconnect, the bot is offline during deploys, and a rule added today has to
apply to the 300 members who already qualify. A pure resolver plus a periodic
reconcile makes every one of those the same code path.

**3. We only ever remove what we granted.** A `RoleGrant` ledger records
`(guildId, discordId, roleId, ruleKey, grantedAt)` and a revoke is scoped to
rows we wrote. Without it, a rule edited at 2am strips roles a human assigned by
hand and nothing can tell which ones those were. Removal is also **opt-in per
rule** (`revokeWhenUnqualified`, default `false`): the failure mode of "forgot
to grant" is a member asking a mod; the failure mode of "wrongly revoked 300
people" is an incident.

**4. Refuse before Discord does.** Preflight every rule against the bot's own
top role position and the target role's permissions. A role above the bot in the
hierarchy, a managed integration role, or a role carrying Administrator, Manage
Roles, Manage Guild, Ban or Kick is refused at *configuration* time with a
reason, not attempted at runtime. A bot that hands out Administrator because
somebody picked the wrong row in a dropdown is the worst outcome in this
document, and it is worth a whole class of refusals to make it unreachable.

**5. Templates interpolate, they do not execute.** Welcome text supports a
closed, enumerated token set (`{user}`, `{username}`, `{server}`,
`{memberCount}`, `{ign}`, `{guildRank}`, `{level}`). Unknown tokens render
literally. Every post sets `allowedMentions` to the joining user alone — never
`@everyone`, never roles — because a welcome message is written once by an
admin and read by the entire server every time somebody joins.

**6. Config is a `GuildSetting` blob, tolerant on read and strict on write.**
The same shape as `moderation.automod`: `parseAutoRoles(raw)` degrades a
malformed or future-versioned blob to "no rules" rather than throwing on a hot
path, and the panel mutation rejects unknown keys outright, so a typo cannot
read back as "not configured" and look identical to a working setting.

**7. Nothing silent.** Every grant, revoke and refusal is logged with the rule
that caused it, counted for the Health page, and — for anything a member can
see — attributable in the audit trail.

---

## 2. Data model

### 2.1 `GuildSetting["roles.auto"]`

```jsonc
{
  "version": 1,
  "enabled": true,
  "rules": [
    {
      "key": "guild-member",            // stable; the ledger keys off this, not the label
      "label": "Guild member",
      "trigger": { "kind": "IN_GUILD" },
      "roleId": "1234...",
      "revokeWhenUnqualified": true,    // leaving the guild takes the role back
      "enabled": true
    },
    { "key": "verified",   "trigger": { "kind": "LINKED" }, "roleId": "..." },
    { "key": "rank-officer", "trigger": { "kind": "GUILD_RANK", "rank": "Officer" }, "roleId": "..." },
    { "key": "level-25",   "trigger": { "kind": "XP_LEVEL", "atLeast": 25 }, "roleId": "..." },
    { "key": "cata-40",    "trigger": { "kind": "ACHIEVEMENT", "definitionKey": "cata:40" }, "roleId": "..." },
    { "key": "regular",    "trigger": { "kind": "EVENTS_ATTENDED", "atLeast": 10 }, "roleId": "..." }
  ]
}
```

### 2.2 `GuildSetting["discord.welcome"]`

```jsonc
{
  "version": 1,
  "join":  { "enabled": true, "channelSlot": "welcome", "mode": "EMBED",
             "text": "Welcome {user} to {server} — you're member #{memberCount}.",
             "dm": null, "deleteAfterSeconds": null },
  "leave": { "enabled": false, "text": "{username} left." },
  // The in-game side: a different audience, a different channel, the same engine.
  "guildJoin": { "enabled": true, "text": "{ign} joined the guild." }
}
```

New channel slot: `welcome`, added to `CONFIG_CHANNEL_SLOTS` and
`CONFIG_CHANNEL_SLOT_LABELS`.

### 2.3 New table — `RoleGrant`

| Field | Notes |
| --- | --- |
| `guildId`, `discordId`, `roleId` | unique together with `ruleKey` |
| `ruleKey` | which rule granted it; the only thing that authorises a revoke |
| `grantedAt`, `revokedAt` | soft-deleted, so "we gave this and took it back" survives |

### 2.4 The dirty set

Recommendation: a Redis set `roles:dirty:<guildId>`, drained by the reconciler,
rather than a table. A member marked dirty five times between passes is one unit
of work, and losing the set to a flush costs one full reconcile rather than
correctness — which is exactly the trade decision 2 was made to allow.

---

## 3. Trigger catalogue

| Trigger | Qualifies when | Source of truth | Marked dirty by |
| --- | --- | --- | --- |
| `IN_GUILD` | `GuildMember.status = ACTIVE` | `GuildMember` | `guild-scan` join/leave diff, the `JOINED` relay event |
| `LINKED` | a verified `LinkedAccount` exists | `LinkedAccount` | `linkByIgn` / `unlink` |
| `GUILD_RANK` | in-game rank equals (or outranks) a named rank | `GuildMember.guildRank` | `guild-scan` |
| `XP_LEVEL` | `levelForXp(balance) >= atLeast` | `XpBalance` | the XP award path |
| `ACHIEVEMENT` | a `Milestone` row for that definition key exists | `Milestone` | the milestone announcer pass |
| `EVENTS_ATTENDED` | `count(EventAttendance) >= atLeast` | `EventAttendance` | event completion |
| `MANUAL` | granted by staff; never auto-revoked | `RoleGrant` | — |

All of them are cheap SQL against tables that already exist. The reconciler
reads one bundle per member (`GuildMember` + link + XP balance + achievement
keys + attendance count) and evaluates every rule against it in memory — one
query set per member, not one per rule.

---

## 4. Phases

Each is independently shippable: migration → domain package → service →
transport → tests → docs, and none begins before the previous typechecks and
tests green.

### D1 — The effector
- `POST /internal/g/:id/roles` on the admin bot: `{ userId, add: [], remove: [], reason }`.
  The hierarchy and dangerous-permission checks live here as well as in the
  panel, so a compromised caller still cannot grant Administrator.
- A client alongside the existing `directory.ts` / `ticket-effects.ts` callers,
  plus a worker-side one for the reconciler.
- Discord error mapping: 10011 unknown role and 10007 unknown member mean
  "already in the desired state", not failure.
- **Tests:** hierarchy refusal, permission refusal, idempotent no-op, error mapping.

### D2 — Rules and the resolver
- New package `@sbr/roles`: `parseAutoRoles`, `resolveDesiredRoles(bundle, rules)`,
  `diffGrants(desired, held, ledger)`. **Pure** — no Discord, no Prisma.
- `RoleGrant` migration and repository.
- **Tests:** every trigger; `revokeWhenUnqualified` both ways; "never removes a
  role we did not grant"; disabled rules; a malformed blob yielding no rules.

### D3 — Reconciliation
- Job `role-sync` (hourly, `LANE.bulk`) drains the dirty set; a full sweep daily.
- Dirty marks wired at the six sources in §3.
- Health card: pending dirty count, last sync, and refused rules with the reason.
- **Tests:** a missed event self-heals on the next full sweep; a rule added today
  applies to existing members; paging under `maxAccounts`.

### D4 — Welcome and farewell
- The admin bot subscribes to `GuildMemberAdd`/`GuildMemberRemove` (it already
  holds the intent) and publishes to a **member bus** on Redis, mirroring
  `RedisModBus`.
- The bridge bot subscribes and posts, because it is the voice members already
  see in that server.
- Template renderer with the closed token set from decision 5, `allowedMentions`
  locked to the joining user.
- **Tests:** unknown tokens render literally; no `@everyone` escape; an unbound
  channel holds the message rather than crashing the subscriber; a failed DM is
  not fatal to the channel post.

### D5 — Panel page: *Roles & Welcome*
- Rule table using the existing role picker: add, edit, remove, per-rule enable.
- **Dry run** — "this would grant 214 and revoke 3" before saving. The most
  valuable control on the page and nearly free, because the resolver is pure.
- Welcome editor with a live preview rendered through the embed gallery.
- **Tests:** panel VM, mutation validation, dry-run counts.

### D6 — Self-service role menus
- A button-driven picker posted to a channel (`/rolemenu` plus a panel editor),
  reusing the ticket panel's picker component and its custom-id routing.
- Restricted to roles the guild has whitelisted as self-assignable, behind the
  same preflight as D1 — so a self-service menu can never offer a staff role.

### D7 — Conveniences (recommend / defer)

| Feature | Verdict | Why |
| --- | --- | --- |
| Level-up announcements (opt-in channel, opt-out per member) | **Recommend** | XP and levels already exist; this is a renderer and a toggle |
| `/rank` card — level, XP, achievements, guild rank | **Recommend** | One query bundle, the same one the reconciler assembles |
| Sticky messages | **Recommend** | Cheap, heavily used, no new data |
| Autoresponders / tags | **Recommend** | `@sbr/tickets` already has a tag store to generalise |
| `/remind` | **Recommend** | Fits the existing scheduler; no new infrastructure |
| `/userinfo`, `/serverinfo`, `/avatar` | **Recommend** | Trivial, expected, zero risk |
| Starboard | **Defer** | Needs `GuildMessageReactions` on the bridge token and a reaction hot path |
| Birthdays | **Defer** | Stores a date of birth for minors — a privacy decision, not a feature decision |
| Economy / gambling | **No** | A second currency competing with guild XP |
| Music | **No** | Wrong product |

### D8 — Docs
`docs/DISCORD_QOL.md` (operator-facing), plus updates to `WEB_PANEL.md`,
`WORKERS.md`, `DOMAIN_MODEL.md`, `COMMANDS.md` and the embed gallery.

---

## 5. Risks

1. **Intent and permission drift.** The admin bot needs Manage Roles and a role
   position above every managed role. Detected at preflight, surfaced on Health,
   never assumed.
2. **Rate limits.** A first full sweep of a 400-member server is 400 role edits.
   The reconciler batches, paces, and is resumable — `LANE.bulk`, capped per
   pass, dirty set drained rather than the whole roster re-walked.
3. **Two bots, one server.** A guild that invited only the bridge bot has no
   effector. The panel must say so plainly instead of silently doing nothing.
4. **Revocation blast radius.** Mitigated by decision 3 and the D5 dry run, but
   the first production enable is worth watching.

## 6. Open questions

1. **Is the admin bot in the member-facing server, or a staff-only one?**
   `ADMIN_BOT.md` says "invited only to staff-relevant scopes". If it is not in
   the member server, the effector moves to the bridge bot and that token gains
   Manage Roles; nothing else in this plan changes. *This is the one answer that
   changes the shape of D1.*
2. Should `GUILD_RANK` match one rank exactly, or "this rank or above"?
   Recommendation: **or above**, with an exact-match flag.
3. Should a welcome message wait for a link before firing? Recommendation:
   **no** — post immediately, and let a `LINKED` auto-role do the rest.
