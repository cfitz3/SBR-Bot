# Admin Bot — SBR Guild Platform

Design for `apps/admin-bot` — the staff-facing surface that owns **moderation, governance, onboarding, operational control, and auditability**. It is deliberately **not** the member utility bot: it carries a separate Discord token, is invited only to staff-relevant scopes, and exposes no stats/economy fun commands. Its entire reason to exist is that privileged actions must be **safe, authorized, and traceable**.

**Design anchors (safety & traceability first)**
- **Every state-changing action is authorized server-side, recorded immutably, and attributable to a real staff identity.** No exceptions, no "quiet" actions.
- **Least privilege + rank hierarchy** — you can never act on someone at or above your rank, and you only see controls your tier grants.
- **Separation from member utility** — a compromised or misbehaving member bot can't perform moderation; the two are different processes with different tokens and permission sets.
- **The panel and the bot are two faces of one moderation core** (`packages/moderation` + `identity`); they share state, audit trail, and enforcement, never diverge.

---

## 1. Feature Specification

| # | Domain | Feature | Summary |
|---|--------|---------|---------|
| M1 | **Moderation** | Actions | warn, cross-surface mute, kick, ban, purge — all audited, all rank-checked. |
| M2 | Moderation | Infraction system | `Infraction` (what happened) + `ModerationAction` (what staff did); history, notes, appeals status. |
| M3 | Moderation | Bridge control | suspend/unsuspend the guild-chat bridge with reason + duration. |
| G1 | **Governance** | Config authority | role/channel mapping, feature toggles, recruitment settings — high-trust, Admin-tier. |
| G2 | Governance | Wordlist / filters | add/remove filter rules, test messages against the compiled filter. |
| O1 | **Onboarding** | Applications | review queue, accept/deny with reasons, role grant on accept. |
| O2 | Onboarding | Tickets | open/assign/close support & appeal tickets. |
| O3 | Onboarding | Member lifecycle | set roles, notes, membership status; verification oversight. |
| P1 | **Operational** | Safety controls | lockdown, anti-raid on/off, purge. |
| P2 | Operational | Events/attendance (staff side) | create events, record attendance (member RSVP lives on the bridge bot). |
| A1 | **Auditability** | Immutable audit log | every action appended with actor, target, reason, before/after, timestamp, source. |
| A2 | Auditability | Audit query | `/audit` search + panel view; tamper-evident, exportable. |
| C1 | **Coordination** | Panel parity | shares `packages/moderation`/`identity`; changes propagate via cache invalidation + pub/sub. |

**Explicit non-features:** no `/stats`, `/price`, `/nw`, LFG, or news — those belong to the Bridge bot. The Admin bot answers *only* to staff and *only* for governance/ops.

---

## 2. Command Spec

Full list in `COMMANDS.md` §8–16. Grouped here by domain with the safety posture of each. All are **guild-scoped**, **rank-checked**, **audited**, and **confirmation-gated for destructive actions**.

### Moderation
| Command | Tier | Safety notes |
|---------|------|--------------|
| `/warn` | Staff | Logs `Infraction`+action; DMs target. |
| `/mute` (a.k.a `/timeout`) | Staff | **Cross-surface**: Discord timeout + Hypixel guild-chat mute; **duration required**; deferred guild-mute if bridge down. |
| `/kick` | Officer | Confirmation; optional guild expel. |
| `/ban` | Officer | Confirmation; optional duration + message-delete window; optional guild expel. |
| `/purge` | Staff | Bounded (≤100 msgs, ≤14d); logs count + scope, not content, by default. |
| `/infractions` | Staff | Read-only history view. |
| `/member-note` | Staff | Private staff note (audited). |
| `/tickets` | Moderator | The support queue from the admin server. `list` and `view` read the shared tables directly; `view` accepts `#12`, `12` or an id, and **refuses an id belonging to another server**. `close` and `transcript` call the bridge bot, because closing disposes of a channel this bot cannot see — a bridge that is down is reported in words, never as a silent no-op. See `TICKETS.md`. |
| `/join-queue` | Moderator | Live in-game requests, each showing how much of the five-minute window is left. Stale rows are retired to `EXPIRED` on read, so the queue never lists a button that cannot work. |
| `/join-accept` | Moderator | Accepts inside the window, **invites** past it, and says which it did — an invite still needs the applicant to accept. Sends first, marks the row second; refuses names that are not `[A-Za-z0-9_]{1,16}`. |
| `/join-deny` | Moderator | Sends the guild command through the bridge, then marks the row — never the other way round. |
| `/guild-invite` | Moderator | Invites a player who never asked; marks no screening row. |
| `/guild-kick` | Moderator | `reason?`, restricted to `[A-Za-z0-9 .,!?'()_-]{1,64}` so nothing typed here can begin a second command in-game. Decides no screening row. |
| `/guild-mute` / `/guild-unmute` | Moderator | `duration*` as `[1-9][0-9]{0,2}[smhd]` (e.g. `30m`). Recorded as history by the bridge's own notice parser, not enforced by us. |
| `/guild-promote` / `/guild-demote` | Moderator | One in-game rank each way; Hypixel decides which rank, we only ask. |
| `/bridge-suspend` / `-unsuspend` | Officer | Reason required; broadcasts status. |

### Governance
| Command | Tier | Safety notes |
|---------|------|--------------|
| `/set-role` | Admin | Cannot map/grant a role above the actor's own rank. |
| `/set-channel` | Admin | Validated against guild channels. |
| `/feature-toggle` | Admin | Per-guild flag; audited; pub/sub to bots. |
| `/set-recruitment` | Admin | Open/close + thresholds. |
| `/wordlist-add` / `-remove` | Officer | Regex validated; recompiles filter. |
| `/filter-test` | Staff | Dry-run, no state change. |
| `/rolemenu` | Officer | `list` reads the document here and works with the bridge down; `post` asks SBR Bot to put the menu up. A menu can only offer roles the preflight would grant. |
| `/sticky` | Officer | Saves here, applied by SBR Bot. An unreachable bridge means "not yet", not a failed command — the configuration is stored either way. |

### Onboarding
| Command | Tier | Safety notes |
|---------|------|--------------|
| `/application-review` | Officer | Opens app + fetched (cached) applicant stats vs thresholds. |
| `/accept-member` / `/deny-member` | Officer | Decision + reason; role grant on accept; DM applicant. |
| `/ticket` | Staff | open/assign/close. |

### Operational safety
| Command | Tier | Safety notes |
|---------|------|--------------|
| `/lockdown` | Admin | Channel/server scope; reason; auto-expiry; **confirmation**. |
| `/antiraid-on` / `-off` | Admin | Sensitivity + duration; announces to staff. |
| `/audit` | Officer | Search the log by actor, target, type, or date range; overview first, cases on click (§7d). |
| `/case` | Officer | One case by id — the same card the mod log posted. |
| `/attendance` | Officer | Mark/report attendance. |
| `/create-event` | Officer | Schedule event; announce via bridge bot. |

**Destructive-action guardrails (all of `/ban`, `/kick`, `/purge`, `/lockdown`, mass actions):**
- Interactive **confirmation** (buttons) showing exactly who/what will be affected before commit.
- **Reason is mandatory** and stored on the audit record.
- **Rank + self-target checks** run server-side before the confirmation is even offered.
- **Rate-limited** per actor to prevent runaway/abusive automation.

---

## 3. Permission Model

Two gates, both enforced **server-side** in `packages/identity`; the UI/command visibility is convenience only.

1. **Discord authority** — the bot verifies the invoker's Discord permissions in that guild (and the bot's own permissions to perform the action).
2. **Platform role** — `GuildMember.role` (`MODERATOR` < `OFFICER` < `ADMIN`/`OWNER`) determines which commands are allowed.

| Tier | Owns |
|------|------|
| **Staff (`MODERATOR`)** | warn, mute, purge, infractions view, notes, tickets, filter-test, attendance-mark. |
| **Officer** | + kick, ban, bridge suspend/unsuspend, applications decisions, wordlist, events, audit query. |
| **Admin / Owner** | + role/channel mapping, feature toggles, recruitment settings, lockdown, anti-raid. |

**Invariant rules**
- **Rank hierarchy:** an actor can never warn/mute/kick/ban/role-change a target at **equal or higher** platform rank. Enforced before any effect.
- **Self-protection:** no acting on yourself for punitive commands.
- **Bot capability check:** if the bot lacks the Discord permission (e.g. can't ban), it refuses with a clear reason instead of half-acting.
- **Grant ceiling:** `/set-role` can't assign a role above the actor's own.
- **Every allow/deny decision is logged** (including *denied* attempts — see audit).

---

## 4. Staff Workflow Examples

### 4.1 Escalating moderation
```
1. Member spamming the bridge → auto Infraction(SPAM) already filed by the Bridge bot.
2. Staff runs  /infractions member:@Mallory  → sees prior warn + auto-flags.
3. Staff runs  /mute member:@Mallory duration:1h reason:"spam after warning"
   → rank check ✓ (Mallory is MEMBER) → confirmation → commit
   → Discord timeout applied + Hypixel /g mute Mallory 1h (or deferred if bridge down)
   → Infraction + ModerationAction written; Mallory DM'd; staff channel logged.
4. Repeat offense later → Officer runs /ban member:@Mallory duration:7d reason:"repeat spam"
   → confirmation shows scope → commit → audit trail links all cases.
```

### 4.2 Onboarding an applicant
```
1. Applicant submits via panel/ticket → Application(SUBMITTED).
2. Officer runs /application-review → embed shows answers + cached SnrW/NW vs thresholds.
3. Meets bar → /accept-member application_id:… note:"strong dungeon profile"
   → GuildMember created/updated, verified role granted, applicant DM'd.
   (or /deny-member reason:"below weight requirement" → applicant DM'd, case closed)
4. All decisions land in the audit log with reviewer identity + reason.
```

### 4.3 Responding to a raid
```
1. Anti-raid heuristics trip (join spike) → bot auto-alerts staff channel.
2. Admin runs /antiraid-on sensitivity:high duration:30m
   → new joins gated/verified, rate caps tighten, invite-age checks on.
3. If ongoing: /lockdown scope:server reason:"active raid" duration:20m
   → confirmation → posting locked; status broadcast.
4. Cleanup: /purge on affected channels (bounded), /ban on raiders (rank-checked).
5. /antiraid-off + /lockdown lift → every step in the audit log with timestamps.
```

### 4.4 Governance change (traceable config)
```
Admin runs /feature-toggle feature:ingame-commands state:off reason:"abuse review"
  → GuildConfig updated → cache invalidated → pub/sub → bridge bot disables in-game cmds live
  → audit record: actor, before(on)/after(off), reason, timestamp, source=ADMIN_BOT.
```

---

## 5. Audit-Log Behavior

Auditability is the bot's backbone — **if it changed state, it's in the log.**

- **What's recorded:** actor (Discord id + platform role), target (user/MC account/config key), action type, **reason**, **before/after** where applicable, timestamp (UTC), **source surface** (`ADMIN_BOT`/`WEB_PANEL`), correlation id, and outcome (success/denied/failed).
- **Coverage:** all moderation actions, governance/config changes, onboarding decisions, safety controls (lockdown/anti-raid), **and denied attempts** (who tried what and why it was refused). Read-only queries log to `CommandUsage`, not the audit trail.
- **Immutability:** the audit trail is **append-only**. No command edits or deletes prior records; corrections are *new* entries that reference the original (e.g. an unban references the ban). Retention per policy; exportable for review.
- **Tamper-evidence:** records carry a monotonic sequence + correlation id; deletions aren't offered through any command. (Optional hardening: hash-chain each entry to the previous for verifiable integrity.)
- **Attribution is non-negotiable:** actions are always tied to the invoking human via their session/identity — the bot never performs an unattributed action, and service/automated actions (auto-infractions, anti-raid auto-mutes) are logged as `source=SYSTEM` with the triggering rule id.
- **Surfacing:** queryable via `/audit` (Officer+) and the panel's Moderation/Audit view, filterable by actor/target/type/date range, paginated, exportable to CSV. `/audit` leads with an overview and offers the matching cases as a menu, so a case id is never a prerequisite for reading one — see §7d.

### 5.1 Warning escalation

A warning is only worth issuing if the third one means something different from the first. Left to staff memory it doesn't: nobody counts back through an audit log before typing `/warn`, so the ladder ends up living in the head of whichever staffer is online. `@sbr/moderation`'s `escalation.ts` makes it a rule the platform applies the moment a warning lands.

**Default ladder** (a guild that has configured nothing gets this): 3 warnings → 1h mute · 5 → 24h mute · 7 → 7-day ban. The window is 90 days. The top rung is deliberately not permanent — a ban a rule decided on should still be one a staffer can look at afterwards.

**Guild configuration** lives in the `GuildSetting` KV under `moderation.escalation`: `{ enabled, windowDays, rungs: [{ warns, action, durationSeconds }] }`. Rungs layer over the built-in ones **by warn count**, the same way milestone definitions and ticket types layer — editing the 3-warning rung leaves 5 and 7 alone. `enabled: false` turns the whole ladder off; there is no way to delete a single default rung, because a policy that can half-delete itself is harder to reason about than one that is either the defaults, your edits, or nothing. Anything unparseable in the stored value falls back to the default rather than failing, since it is hand-editable JSON and a mangled row must not silently switch escalation off.

**Rules worth stating:**
- **A rung fires on the warning that reaches it**, not on every warning past it. A member at four warnings against rungs of 3 and 5 is not re-muted by warning four; since the count climbs by one per warning, each rung fires exactly once.
- **Warnings age out.** Without a window, one bad week two years ago sits between a member and a ban forever.
- **Escalation runs after the warning is recorded**, and never fails it. If the escalation is refused — the bot lacks the permission, the settings store is down — the warning still stands and the refusal is logged. The record of the warning is the part that must not be lost.
- **The escalation goes through `applyAction` like any other punishment**, so the rank guard, the duration guard and the enforcement mirror all apply to it.

**Attribution deviates from the `SYSTEM` convention above, on purpose.** An auto-escalation is attributed to the staffer whose warning tripped it, not to a synthetic system actor. They took the action that caused it, an audit row whose actor is nobody is a row nobody can be asked about, and routing it through the same actor is what keeps the rank guard meaningful — escalation cannot reach somebody the warning itself was not allowed to touch. The row is still identifiable as automatic: its reason reads `Automatic escalation: N warnings in M days`, which `isEscalation()` is the single reader of. `/warn` reports the escalation back to the staffer by asking what is being enforced now, so they know before deciding whether to do anything further.

**The member sees the ladder they are on.** `/me` in the member bot carries a "Your record" field — what is being enforced right now, how many warnings still count inside the window, and which rung the next one lands on (COMMANDS.md §Your record). It reads through `MemberRecordSource`, a one-member read-only port rather than this service, so the member bot gains no ability to read anybody else's history or to act on anyone. The count and the expiry check are the same functions used here, so a member is never told a number staff would dispute.

---

## 6. Anti-Raid & Safety Controls

Designed to **fail safe** (protect the server) and **fail loud** (always tell staff), and to be fully reversible.

| Control | Trigger | Effect | Reversal |
|---------|---------|--------|----------|
| **Anti-raid mode** | `/antiraid-on` or auto heuristic (join spike, new-account flood, coordinated joins) | Join gating (min account age, verification required), tightened rate caps, restricted first-message perms, mass-mention block | `/antiraid-off`; auto-expires on `duration` |
| **Lockdown** | `/lockdown` | Deny send in channel/server scope | `/lockdown` lift; auto-expiry |
| **Auto-mute on flood** | Sustained spam past filter escalation | Shadow/temp mute + `Infraction(SPAM)` + staff alert | Time-based (`mute:*` TTL) or manual |
| **Purge** | `/purge` | Bounded bulk delete (≤100, ≤14d) | Not reversible (Discord); logged as scope+count |
| **Verification gate** | anti-raid / recruitment config | New members can't speak/relay until verified/linked | Config-driven |

**Safety properties**
- **Heuristics alert before they auto-act** where possible; auto-actions are the minimum necessary (gate/mute, not ban) and are logged as `SYSTEM` with the rule id, so staff can review and escalate.
- **Everything is time-boxed:** anti-raid and lockdown carry durations and auto-expire, so a forgotten toggle can't silently strangle the server.
- **Reversible by design:** every safety control has an explicit off switch and an auto-expiry; irreversible actions (`/purge`, `/ban`) require confirmation + reason.
- **Rate-limited actors:** even Admins are throttled on mass/destructive actions to contain a compromised staff account.
- **Blast-radius isolation:** the Admin bot's token/scopes are separate from the member bot, so its powers can't be reached through the member surface.

---

## 7. Coordination with the Web Panel

The Admin bot and the panel are **two clients of the same moderation/governance core** — they must never disagree.

- **Shared services, shared truth:** both call `packages/moderation`, `identity`, and `config`. State lives in Postgres; there is no bot-only or panel-only moderation path.
- **Live propagation:** a change made in either surface (mute, config edit, feature toggle, wordlist change) writes to Postgres, mirrors enforcement state to Redis (`mute:*`/`ban:*`), invalidates hot caches (`cfg:*`/`perm:*`/`wordlist:*`), and publishes on `chan:config:{guildId}` / `chan:mod:{guildId}`. The counterpart surface reflects it within seconds — a mute issued in the panel is enforced by the bot immediately, and vice-versa.
- **Unified audit:** both write to the same append-only audit trail with `source` distinguishing `ADMIN_BOT` vs `WEB_PANEL`, so the history is complete regardless of where an action originated.
- **Panel for depth, bot for immediacy:** the panel is better for review, bulk queries, config forms, and reporting; the bot is better for in-context, in-Discord fast actions. They intentionally overlap on core actions so staff can use whichever is at hand.
- **Bot presence gates panel config:** the panel disables enforcement-dependent config when the Admin bot is absent/under-permissioned (see `WEB_PANEL.md`), because the bot is what actually enforces it.
- **Consistency stance:** writes are durable-first (Postgres) then propagated; surfaces show a brief "pending" state until the responsible surface acknowledges enforcement, so staff never assume an action landed before it did.

---

## 7a. Member observation (the greeter's other half)

The bot holds the `GuildMembers` intent, so it — not the member-facing bot — is
what sees `GuildMemberAdd` and `GuildMemberRemove`. It publishes each one on the
Redis member bus (`chan:member:<guildId>`) and SBR Bot does the talking, because
a welcome from a staff bot most members cannot see or message would be the
platform speaking out of the wrong mouth.

The payload carries everything the greeter needs to render — display name,
server name, member count after the event — because a member who has just left
cannot be fetched, and half a farewell is worse than none. See
[`DISCORD_QOL.md` §3](DISCORD_QOL.md).

---

## 7b. Internal API (loopback)

The bot is the only process holding a Discord gateway cache, so it exposes that cache to the panel over a small HTTP server (`apps/admin-bot/src/internal-api.ts`). This is what removes ID-pasting from the panel: the channel, role and member dropdowns are reads of this endpoint.

**Posture.** Bound to `127.0.0.1` only, never a public interface. Every request carries `Authorization: Bearer <INTERNAL_API_TOKEN>`; a missing or wrong token is a 401. **Treat that token as a credential of the same weight as the bot token** — anything holding it can enforce moderation actions.

| Route | Purpose |
| --- | --- |
| `GET /internal/g/{guildId}/channels` | `{id, name, type, parentName}[]` |
| `GET /internal/g/{guildId}/roles` | `{id, name, color, position, managed, assignable, blockedReason}[]` |
| `GET /internal/g/{guildId}/members?q=` | `{id, username, globalName, nick, avatarHash, roleIds, joinedAt, bot}[]` |
| `POST /internal/g/{guildId}/enforce` | KICK / BAN / UNBAN / TIMEOUT / UNTIMEOUT, through `DiscordGuildEffects` |
| `POST /internal/g/{guildId}/scheduled-event` | Creates a Discord scheduled event, returns its id |
| `POST /internal/g/{guildId}/roles` | `{userId, add[], remove[], reason}` — grants and revokes, after a preflight |
| `POST /internal/g/{guildId}/announce` | `{channelId, embed}` — renders an `EmbedView` into that channel |

`{guildId}` is the **platform** guild id; the bot resolves it to the Discord snowflake itself, so the panel never has to hold both.

**Role writes are preflighted here, not only in the panel** (`apps/admin-bot/src/role-preflight.ts`). A role is refused before Discord is asked when the bot lacks Manage Roles, when the role no longer exists, when it is `@everyone` or integration-owned, when it sits **at or above** the bot's own highest role, or when it carries any of Administrator, Manage Server, Manage Roles, Manage Channels, Manage Webhooks, Ban Members, Kick Members or Timeout Members. That last rule is a deliberate limitation rather than an oversight: **a rule may not hand out authority**, so staff promotion stays a human act with a name attached to it. Revocation is screened more loosely — taking a dangerous role *away* is never the dangerous direction, and a role that has gained Manage Roles since it was granted is exactly the one we most need to be able to remove.

`assignable` / `blockedReason` on the roles listing are the same decision, so a picker can grey a row out and say why instead of offering a role that would fail at the API as a bare 50013.

The write is **idempotent and honest**. A role the member already holds is not added again and one they do not hold is not removed, so a reconciler pass where nothing changed costs Discord nothing. The response reports what *actually* happened — `{ok, memberPresent, added[], removed[], refused[]}` — because the caller writes a grant ledger from it, and a ledger of intentions is worse than no ledger. A member who has left the server is `ok: true, memberPresent: false`: nothing to do, nothing wrong. If the Discord call throws, nothing is claimed at all and the next reconcile finishes the job from real state.

**Environment.**

| Variable | Where | Meaning |
| --- | --- | --- |
| `INTERNAL_API_TOKEN` | both | Shared secret. Unset on the panel side means every picker reports itself unavailable. |
| `INTERNAL_API_PORT` | admin-bot | Loopback port to listen on. |
| `INTERNAL_API_URL` | web-panel | Base URL of the above, e.g. `http://127.0.0.1:8791`. |

**Manual step that cannot be done from code:** member listing requires the **Server Members** privileged intent, enabled by hand in the Discord developer portal for the admin-bot application (the code requests `GatewayIntentBits.GuildMembers`, but the portal switch is what makes Discord honour it). Without it the bot fails to log in — this is a deploy-time gate, not a silent degradation.

**`announce` exists because the panel has no mouth.** The panel process holds no gateway connection, so a `ModerationServiceImpl` built there had no way to post a mod-log card and was constructed without a sink — which is why staff moderation done from the panel, the route most of it goes through, reached no channel at all. The fix keeps the ownership split intact: the panel decides *what* to say and *where*, the admin bot performs the privileged write. The channel is fetched **through the guild** rather than off the client, so holding the loopback token for one server cannot post into another. Mentions are stripped (`allowedMentions: {parse: []}`) — a card describing a punishment should not also ping the person it names.

**Degradation is deliberate.** A panel whose bot is down, unreachable, or token-mismatched is *degraded, not broken*: each picker falls back to the raw-snowflake text field it replaced, with a Save button and the same validation as before. Directory failures are never cached, so a picker recovers on its own as soon as the bot returns.

---

## 7c. Punishments placed by hand in Discord

Staff right-click and ban. They always have. A platform that only records what
was typed into one of its own surfaces will always disagree with the server it
claims to describe — no case, no mod-log card, nothing in `/audit` — and, more
expensively, the guild-chat half never runs, so the member carries on playing in
a Minecraft guild they were just thrown out of the Discord for.

`apps/admin-bot/src/discord-mod-observer.ts` closes that. It is the mirror of the
in-game path, pointing the other way, and it feeds
`ModerationService.recordDiscordAction` — a sibling of `recordExternalAction`
rather than a reuse of it, because the two owe opposite halves: an in-game kick
still needs performing *in Discord*, a Discord ban still needs performing *in
guild chat*.

- **Bans and unbans** arrive as `GuildBanAdd` / `GuildBanRemove`. The state
  change is unambiguous; the audit log is consulted only for *who* and *why*.
- **Kicks have no event.** Discord reports one as an ordinary
  `GuildMemberRemove`, identical to somebody leaving of their own accord. The
  only thing separating the two is a `MemberKick` audit entry appearing at about
  the same moment, which is a race by construction — so it is treated as one: a
  two-second settle, eight entries scanned, a fifteen-second window.
- **Discord timeouts are deliberately not adopted.** Discord holds and lifts
  them itself; a MUTE row the expiry sweep believed it owned would start
  un-muting people this platform never muted.

**The bias is toward doing nothing.** A missed kick is a case staff can add by
hand. A wrongly adopted one is a case asserting something untrue about a real
person and — with relay sync on — a genuine kick out of the Minecraft guild for
leaving a Discord server. So an unreadable audit log, an entry for somebody
else, a stale entry, an entry with no executor, and a server this platform has
no mapping for all resolve to *record nothing* (a ban, which is unambiguous on
its own, is still recorded, with the actor `discord` standing in for the name we
could not read).

The load-bearing check is `executorId === client.user.id`. Every ban the platform
places goes through the same REST call a staffer's right-click does, so
`GuildBanAdd` fires for our own enforcement too; without that comparison every
panel-issued ban would be adopted a second time and post a duplicate card.
Adopted actions skip the Discord leg for the same reason —
`enforce({discordAlreadyApplied: true})` — since re-issuing it would be a
privileged write on no evidence, and for a KICK the member has already gone, so
the retry answers "unknown member" and only reads as success because we chose to
read it that way.

**Requires:** the `GuildModeration` gateway intent (non-privileged, but it must
be asked for — it is in `apps/admin-bot/src/transport.ts`) and the **View Audit
Log** permission. Without the permission bans are still adopted, with an unknown
actor, and kicks are not detected at all — there is nothing to distinguish them
from a departure.
---

## 7d. Reading the log: `/audit` and `/case`

An audit trail nobody can search is a compliance artefact, not a tool. `/audit`
was a hundred rows paged ten at a time with the record built into the field
*names*, and the only way to reach one case was to scroll until it went past —
which stops working at exactly the point the log gets long enough to be worth
having. `/case` took an id, and staff mostly do not have one.

**The shape is now overview first, detail on click.**

- **Page one is the answer.** How many actions matched, how many are still being
  enforced, the breakdown by type, the busiest three staff, and the range the
  numbers are about. Every figure is explicitly scoped to the matched window,
  because a total that quietly means "the first hundred" is worse than no total.
- **The listing is page two onward**, five to a page, each entry one field whose
  *name* is a label — the case id — with the record in the value. Field names
  are labels; data in a field name is rendered in bold by Discord and gives the
  reader's eye nothing to anchor on.
- **A menu of the matching cases rides under both.** Picking one opens its card.
  The value is the case id and nothing else lives in the control, so the menu
  still routes after a restart like every other persistent component here.

**Searching without an id.** `actor`, `target` and `type` were already there;
`days` answers "recently". `from` and `to` answer "that weekend in March", which
is the question staff actually arrive with. Both ends are optional and both are
read as whole days — `to:2026-03-14` includes everything that happened on the
14th, because any other reading is a silent surprise. A date the parser cannot
read is *named* in the reply and the filter is dropped: an unapplied filter that
says nothing produces a result set that looks like an answer.

Where the bounds meet, in `auditWhere` in `packages/db`: three separate options
can constrain one column, Prisma takes one object per column, and the tighter
lower bound wins — somebody asking for both "the last 7 days" and "since the
1st" is narrowing, not widening.

**Authorisation has one home.** The case menu does not read the case out of the
service. It synthesises the arguments `/case` would have received and dispatches
`case` through the ordinary path, so the actor's role check, the guild's policy
floor and the handler are the same ones a typed command goes through. A second
data path is a permission check nobody remembered to write.

**The case card is the mod-log card.** `/case` and the `modlog` channel render
through the same `modLogEmbed`, so a case pulled up months later reads
identically to the card posted when it happened — including whether enforcement
actually took. It now carries the action's own `createdAt` as the card's
timestamp rather than none at all, which is the difference between a case with a
date on it and one without.

---

## 8. Summary

- **A separate, staff-only bot** whose sole purpose is safe, authorized, traceable governance — never member utility.
- **Two-gate permissions** (Discord authority + platform role) with **rank hierarchy** and **grant ceilings**, enforced server-side.
- **Destructive actions are confirmation-gated, reason-mandatory, rate-limited, and rank-checked** before any effect.
- **Everything that changes state is in an append-only, attributable audit log** — including denied attempts and system-triggered actions.
- **Anti-raid/lockdown fail safe, fail loud, and auto-expire** — reversible by design.
- **The bot and panel share one moderation core**, propagating changes live via Redis so the two surfaces are always consistent.
