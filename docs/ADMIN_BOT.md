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
| `/audit` | Officer | Query the immutable log. |
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
- **Surfacing:** queryable via `/audit` (Officer+) and the panel's Moderation/Audit view, filterable by actor/target/type/date, paginated, exportable to CSV.

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

## 8. Summary

- **A separate, staff-only bot** whose sole purpose is safe, authorized, traceable governance — never member utility.
- **Two-gate permissions** (Discord authority + platform role) with **rank hierarchy** and **grant ceilings**, enforced server-side.
- **Destructive actions are confirmation-gated, reason-mandatory, rate-limited, and rank-checked** before any effect.
- **Everything that changes state is in an append-only, attributable audit log** — including denied attempts and system-triggered actions.
- **Anti-raid/lockdown fail safe, fail loud, and auto-expire** — reversible by design.
- **The bot and panel share one moderation core**, propagating changes live via Redis so the two surfaces are always consistent.
