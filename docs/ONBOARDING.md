# Onboarding, Roles & Gated Access

How somebody becomes a known member of this platform — on Discord, in the
Hypixel guild, or both — what that earns them, and which process does the work.

This document is the reference for the role ladder and the permission model. It
describes the target design and marks, per section, what is **built**, what is
**partly built**, and what is **not built yet**. Nothing here is aspirational
hand-waving: every "built" claim points at the file that does it.

---

## 1. The four states a person can be in

The platform's central fact is that the Discord server and the Hypixel guild are
**two different populations**. Onboarding is the process of moving somebody from
knowing one of them to being verified in both. Four states, and every gate in
the system is a question about which one a person is in:

| State | In Discord | Verified link | In Hypixel guild | Called |
|---|---|---|---|---|
| **Guest** | ✅ | ❌ | ❌ | someone who joined the server |
| **Verified guest** | ✅ | ✅ | ❌ | linked, but not in the guild — an applicant, an alt, a friend |
| **Member** | ✅ | ✅ | ✅ | the normal case |
| **Unlinked in-game** | ❌ | ❌ | ✅ | in the guild, never joined Discord (or never linked) |

These are **derived**, never stored as a fifth column. They come from
`GuildMember` (Discord side), `LinkedAccount.status === "VERIFIED"` (the link),
and `GuildMemberCache` (in-game side) — the three tables Phase 2's
`listDirectory` already merges. The directory's `side` filter (`all` / `discord`
/ `game` / `unlinked`) is exactly this table, and the Members page already
renders it.

**Guest and Verified guest are not roles.** This is the single most important
distinction in the model. The role ladder in §2 describes *authority*; the state
table describes *standing*. Somebody can be an OFFICER who has not linked, and
that combination must not silently grant them guild-chat access. Gates check
both, separately.

---

## 2. The role ladder

Five platform roles, already in the schema (`MemberRole`) and already ordered by
`rankOf` in `packages/panel-core/src/access.ts`:

```
MEMBER  <  MODERATOR  <  OFFICER  <  ADMIN  <  OWNER
```

| Role | Who holds it | Typical Discord role | Typical Hypixel rank |
|---|---|---|---|
| `MEMBER` | everyone in the guild | `@Member` | any |
| `MODERATOR` | chat staff — Discord-side, usually no in-game authority | `@Moderator` | (none) |
| `OFFICER` | guild staff who can kick and invite in-game | `@Officer` | Officer |
| `ADMIN` | runs the configuration; panel access to everything but ownership | `@Admin` | (usually GM's deputies) |
| `OWNER` | the Guild Master, and whoever they trust with the account | `@Owner` | Guild Master |

The ladder is **strictly monotonic**: a role holds every capability the roles
below it hold. There is no orthogonal permission axis at the role level, on
purpose — the fine-grained axis is `BridgePermission` (§4), and having two
overlapping systems that can each override the other is how a permission model
becomes unauditable.

**Role comparison already gates moderation.** `ModerationServiceImpl.applyAction`
refuses when `rankOf(target) >= rankOf(actor)` — you cannot punish a peer or a
superior. That is the correct rule and it stays.

### 2.1 Where a role comes from

**Built.** Role is *derived*, with a manual override:

```
role(member) = max(
  manual override on GuildMember.role,       // /set-role, the escape hatch
  highest platform role whose mapped Discord role the member holds,
  platform role mapped from their Hypixel guild rank
)
```

Taking the **max** rather than letting one source win means adding a source can
only ever promote, never silently demote somebody mid-incident. The manual
override participates in the max like any other source, so `/set-role` is a
floor, not a lock — with one exception: an explicit demotion below the derived
value is recorded as a `roleOverride` and *does* win, because "I removed this
person's authority" must be enforceable without first unwinding three Discord
roles.

The derivation itself is pure and lives in `resolveMemberRole`
(`packages/guild-config/src/roles.ts`); `rankResolver.getRole`
(`packages/db/src/repositories/misc.ts`) supplies the four facts — stored role,
`GuildMember.roleOverride`, the member's Discord role ids (mirrored by
`discord-member-sync`) and their in-game rank — from rows one query already
touches. The Discord bindings live on `GuildConfig.roleMappings`, now a *set* of
role ids per level rather than a single id; the rank map lives in the guild's
`roles.policy` document. Both are edited on the panel's **Permissions** page.

---

## 3. Discord permission layout

The bots do **not** manage Discord channel permissions today and should not
start: a bot that rewrites server permission overwrites is a bot that can lock
an owner out of their own server. What the platform does instead is *name* the
channels it uses (`CONFIG_CHANNEL_SLOTS`) and describe the layout it expects, so
an operator can build it once.

### 3.1 The recommended server layout

Ten channel slots exist (`packages/shared-types/src/services.ts`). Grouped by
who should be able to see them:

**Public — `@everyone` can read**
| Slot | Purpose | Write access |
|---|---|---|
| — | rules / welcome | nobody |
| `leaderboard` | posted boards | bot only |
| `milestones` | achievement announcements | bot only |

**Member — requires `@Member`**
| Slot | Purpose | Notes |
|---|---|---|
| `bridge` | the guild-chat relay | **the gated one.** See §4. |
| `events` | event posts and RSVPs | |
| `lfg` | looking-for-group posts | |
| `tickets` | the ticket panel post | members open, staff answer |

**Staff — requires `@Moderator` or above**
| Slot | Purpose |
|---|---|
| `staff` | screening reports land here (`postStaffReport`) |
| `modlog` | moderation actions |
| `log` | bot diagnostics |
| `applications` | join requests awaiting a human |

The `bridge` channel deserves its own overwrite set, because it is the only
channel where a Discord message leaves Discord:

```
@everyone         view: ❌
@Member           view: ✅  send: ✅
@Unverified       view: ✅  send: ❌      ← lets a guest see what they're missing
@Muted            send: ❌               ← the Discord half of a relay mute
bot (bridge-bot)  view ✅ send ✅ manage-messages ✅  ← automod DELETE needs this
```

### 3.2 Bot permissions

**admin-bot** needs `Manage Roles`, `Kick Members`, `Ban Members`,
`Moderate Members` (timeout), `Manage Events`, and — already required by Phase 1
— the **Server Members privileged intent**, which must be enabled by hand in the
Discord developer portal. Its role must sit **above** every role it is expected
to assign or remove; Discord refuses otherwise, and the failure is a silent
403 unless someone reads the log.

**bridge-bot** needs `View Channel` / `Send Messages` / `Manage Messages` /
`Embed Links` in the relay channel, plus `Message Content` (already held). It
deliberately does **not** hold `GuildMembers` — it has no reason to enumerate
the roster, and every intent is attack surface.

### 3.3 Two roles the bot should own outright

- **`@Verified`** (or `@Member`) — granted on successful `/link`, removed on
  unlink. This is the role the channel overwrites above are written against, so
  verification actually opens the server up rather than merely writing a row.
- **`@Muted`** — the Discord side of a mute, applied and removed by the
  moderation service. Today a mute is a Redis key that only the *relay* checks
  (`BridgeGuardImpl.isMuted`), so a muted member can still post freely in every
  other channel.

Both are created by the bot on first use if absent, and their ids stored as new
entries in `roleMappings` — not as new columns, since the mapping table is
already the right shape and §2.1 is about to make it load-bearing anyway.

---

## 4. Gated bridge access

### 4.1 The capability model

Six capabilities (`BridgeCapability`), each with a role floor. The floors below
are the platform defaults (`DEFAULT_CAPABILITY_FLOOR` in
`packages/guild-config/src/roles.ts`, mirrored by `MIN_ROLE` in
`packages/identity/src/service.ts` for deployments with no policy store); a
guild raises or lowers any of them on the panel's Permissions page, and only the
floors that differ from the default are stored, so a later change to a platform
default reaches every guild that never touched it.

| Capability | Default floor | What it allows |
|---|---|---|
| `RELAY_MESSAGE` | MEMBER | speak into guild chat from Discord |
| `RUN_COMMAND` | MEMBER | use the bot's commands |
| `MENTION` | MODERATOR | have `@everyone`/role pings survive the relay |
| `BYPASS_COOLDOWN` | OFFICER | skip rate limits |
| `BYPASS_FILTER` | ADMIN | skip the wordlist |
| `ADMIN` | ADMIN | implies every other capability |

Resolution order is **deny → grant → role floor**
(`IdentityServiceImpl.hasCapability`). A deny row wins over everything, which is
the only way to silence one person without demoting them. That design is right
and stays.

### 4.2 Two defects that were wide open, and are now closed

**Defect 1 — the relay gate was disabled.** `BridgeGuardImpl.canRelay`
(`apps/bridge-bot/src/adapters.ts`) used to read
`… hasCapability(…, "RELAY_MESSAGE")) || true`, so every capability check was
computed and discarded and anyone who could see the bridge channel could speak
into guild chat. **Fixed:** the `|| true` is gone and the method is the
capability check.

**Defect 2 — the role floor defaulted to MEMBER for strangers.** `rankResolver`
ended `?? "MEMBER"`, so a Discord account with no `GuildMember` row at all
resolved to MEMBER, which carries `RELAY_MESSAGE` — fixing defect 1 alone would
not have closed the hole. **Fixed:** `getRole` returns `MemberRole | null`, null
means "not a member of this guild" and is not a point on the ladder, and
`hasCapability` denies outright on it.

**Still open:** `RELAY_MESSAGE` does not yet additionally require a **verified
link**. It should, because the relay prefixes messages with a name that in-game
readers will hold accountable and an unlinked Discord account has no name to
hold. That is the one place the state table (§1) and the role ladder (§2) are
checked together, and it is worth stating as the rule it will become:

> **To speak into guild chat you must be `Member` or `Verified guest` *and* hold
> `RELAY_MESSAGE`.** Standing and authority are separate questions and the relay
> asks both.

### 4.3 Fine-grained subjects

`BridgePermission` supports three subject types: `DISCORD_USER`, `DISCORD_ROLE`,
`GUILD_RANK`, and **all three are read**. `getCapabilityGrants`
(`packages/db/src/repositories/identity.ts`) collects the member's Discord role
ids and normalised in-game rank from the same `GuildMember` row it already
needs, then matches every subject in one query — so "every Officer gets
`BYPASS_COOLDOWN`" is one row, not twenty, and it costs the relay no extra round
trip. Rank subjects are stored under the normalised (trimmed, lower-cased) name,
because Hypixel rank names are guild-authored free text that staff re-case.

Exceptions are written from the panel's Permissions page. `allow: false` is kept
distinct from having no row at all, because the resolver treats them
differently: a deny beats every grant and every floor, so it is the strongest
statement available and has to be asked for rather than arrived at by clearing
something.

---

## 5. How a new member is handled — Discord side

### 5.1 Today

`discord-member-sync` (Phase 2) runs every 2h and upserts `DiscordUser` +
`GuildMember`. That is the entire Discord-side onboarding. There is **no**
`GuildMemberAdd` listener anywhere in the repo. Consequences:

- A new joiner is invisible to the platform for up to two hours.
- Nobody is greeted, prompted to link, or given a role.
- Their `GuildMember` row appears with the default `MEMBER` role — see §4.2.

### 5.2 Target flow

```
GuildMemberAdd fires  (admin-bot; it already holds the GuildMembers intent)
  │
  ├─ upsert DiscordUser + GuildMember{status: ACTIVE, joinedAt}   ← immediate, not in 2h
  ├─ raid check: account age < N days, or joins/min over threshold
  │     └─ over threshold → hold: no roles, staff ping in `staff`, stop
  ├─ DM the welcome + link instructions (fails soft — DMs are often closed)
  ├─ post the welcome in the welcome channel, if configured
  ├─ known returner? (a prior GuildMember row, or a verified link)
  │     ├─ yes → restore their prior role and @Verified; log it
  │     └─ no  → grant @Unverified only
  └─ if a prior ban/expulsion exists → staff ping, no roles
```

**On successful `/link`:** grant `@Verified`, remove `@Unverified`, re-derive the
role (§2.1) — because a link may reveal that this person holds Officer in-game —
and post to `log`. **On unlink:** the reverse.

**On `GuildMemberRemove`:** mark `GuildMember.status = LEFT`, stamp `leftAt`,
keep the row and the link. Deleting on leave is what makes a returning member
look like a stranger, and the Overview's leave count already reads `leftAt`.

**Rejoin within N days restores standing** — role, link, and XP. The row was
never deleted, so this is a lookup, not a recovery.

### 5.3 Verification, and why it is not a second state

`LinkStatus` has a `PENDING` value that **nothing ever writes** — `/link` either
succeeds and writes `VERIFIED` or fails and writes nothing. Phase 2 already
deleted the panel's "awaiting verification" affordances for this reason. It
stays deleted. Linked is a yes/no, and any future manual-review flow must
introduce its own explicit state rather than reviving a value the code has never
produced.

---

## 6. How a new member is handled — in-game side

### 6.1 Today (this half is genuinely well built)

`parseJoinEvent` (`apps/bridge-bot/src/join.ts`) reads two Hypixel chat lines —
`X has requested to join the Guild!` and `X joined the guild!` — and
`handleJoin` in `transport.ts` does the rest:

1. Dedupe (`seenRecently`), resolve IGN → UUID.
2. `ScreeningService.screen()` — scammer lookup, stat block, prior history.
3. On `JOINED`: record outcome `JOINED`, post the report to `staff`. No gate; the
   person is already in, and the record exists to answer "what did they look like
   at the time".
4. On `REQUEST`: `shouldAccept` → send `/guild accept <ign>` and record
   `ACCEPTED`; verdict `DENY` → record `DENIED`; otherwise leave it `PENDING` for
   a human.
5. Say a deliberately vague line in guild chat (`chatLine`) **only** when we
   acted, and post the full write-up to `staff`.

Every attempt is persisted to `GuildJoinScreening` with the tri-state scammer
result — `true` / `false` / `null`, where null is "could not find out" and must
never collapse to "clear". Phase 6's join-attempts card renders all three.

Per the plan's Phase 12, the stat thresholds (weight, networth, catacombs, skill
average, account age, inactivity) are removed as *gates*. The scam check is the
only bar. The numbers are still recorded and still shown to staff — they inform,
they do not decide.

### 6.2 What is missing

- **No welcome in guild chat.** A new member joins and the bot says nothing.
- **No link prompt.** The one moment somebody is most likely to link is the
  moment they get in, and nothing asks them to.
- **No Discord-side effect.** Joining the guild grants no Discord role even for
  somebody already linked — because nothing joins the two events up.
- **`/g leave` and kicks are only seen** through the 6h `guild-scan` diff, so the
  roster can be six hours stale on departures. `parseModNotice` already reads
  kick notices; leave notices are not parsed.

### 6.3 Target flow

```
JOINED event (already parsed)
  │
  ├─ screen + record                                  ← built
  ├─ upsert GuildMemberCache immediately              ← don't wait 6h for the scan
  ├─ welcome in guild chat: "Welcome <ign>! Discord: <invite> — /link to verify"
  ├─ already linked?
  │     ├─ yes → grant @Member on Discord, re-derive role, post to `log`
  │     └─ no  → nothing more; the invite is in the welcome line
  └─ post the joined-report to `staff`                ← built
```

and symmetrically on leave: parse the leave/kick notice, mark the cache row gone,
remove `@Member` (keeping `@Verified`, since the link is still true), post to
`log`. Removing verification because somebody left the guild would force a
re-link on every return.

---

## 7. What to build, in order

Everything below is **outside** the current 12-phase panel plan and does not
block it. Ordered by "how bad is it if this stays broken".

### 7.1 Close the bridge gate — **done**, except the link requirement

- ~~Delete `|| true` from `BridgeGuardImpl.canRelay`.~~ Done.
- ~~`MemberRoleReader.getRole` returns `MemberRole | null`; null denies in
  `hasCapability` rather than defaulting to MEMBER.~~ Done.
- **Outstanding:** `RELAY_MESSAGE` additionally requires a verified link, behind
  a config switch `bridge.requireLink` (default **on**) so a guild that
  deliberately runs an open bridge says so explicitly rather than getting one by
  accident. Tests to write with it: a stranger cannot relay; an unlinked member
  cannot relay; a linked member can.

### 7.2 Make `roleMappings` real — **done**

- ~~`GuildMember.roleOverride MemberRole?` (nullable; null = derived).~~ Shipped.
- ~~A resolver that computes the max over {override, Discord roles, Hypixel
  rank}.~~ Shipped as `resolveMemberRole` + `rankResolver.getRole`. It is *not*
  cached per member: the facts come from rows the same query already reads, so
  the only extra cost is the guild's policy row, and a cache here would mean a
  demotion taking effect a minute after an incident.
- ~~A Hypixel-rank → platform-role mapping.~~ Shipped inside the one
  `GuildSetting["roles.policy"]` document rather than a key of its own, so "what
  is this guild's permission model" is one read that cannot disagree with
  itself. `roleMappings` widened to hold a *set* of Discord role ids per level.
- ~~`getCapabilityGrants` starts reading `DISCORD_ROLE` and `GUILD_RANK`
  subjects.~~ Shipped (§4.3).
- ~~Panel.~~ Shipped as its own **Permissions** page rather than a Settings
  card — four dimensions and an exception table is more than a card holds. See
  `docs/WEB_PANEL.md`.

What is still worth doing here: offering the guild's actual rank names from
`GuildMemberCache` as choices, instead of the free-text rank field the add form
uses today.

### 7.3 `GuildMemberAdd` / `GuildMemberRemove` listeners

In admin-bot, which already has the intent. Plus the `@Verified` / `@Muted`
managed roles, and the link-success / unlink role effects. This is where the
2-hour blindness goes away; `discord-member-sync` stays as the reconciler that
catches whatever the gateway missed during a restart.

### 7.4 Guild-chat welcome + link prompt

Two lines of chat and a config toggle, and it is the single highest-leverage
change for link coverage — which in turn is what makes Analytics, XP and event
tracking able to see people at all.

### 7.5 Leave/kick parsing

Extend `parseModNotice` with leave notices so departures are seen in seconds
rather than up to six hours.

### 7.6 Later — an onboarding wizard in the panel

A first-run checklist: bind the channel slots, map the roles, enable the intent,
invite the bots, run a test relay. Every step is already an existing mutation;
the wizard is presentation over a readiness read. Worth building only after
§7.1–7.5, since a wizard that configures a broken model is worse than no wizard.

### 7.7 Later — application forms

`applicationsOpen` and the `applications` channel slot both exist and neither is
used. A structured application (a modal, answers into a new table, staff
accept/deny buttons that drive `ScreeningService.decide`) is the natural home
for them. Deliberately last: the in-game request flow already works, and this is
a convenience on top of it, not a replacement.

---

## 8. Rules this model must not break

1. **Two rosters, never one blended number.** Discord and Hypixel are different
   populations. Every count says which one it means.
2. **Unknown is not zero, and unknown is not "clear".** The scam check keeps its
   three states. A stale scan shows its `refreshedAt`.
3. **Standing and authority are different questions.** Being an OFFICER does not
   imply being linked; being linked does not imply authority. Gates ask both.
4. **Deny always wins.** No role, grant, or future source may override an
   explicit deny.
5. **A role can be revoked without unwinding Discord.** Hence `roleOverride`
   beating the derived value downward.
6. **The bot never rewrites channel permissions.** It reads the layout; the
   operator owns it.
7. **Leaving is not deletion.** Rows and links survive a departure, so a return
   is a lookup rather than a recovery.
