# Web Control Panel — SBR Guild Platform

Design for `apps/web-panel` — the Discord-OAuth control suite that configures both bots and surfaces analytics/ops. Built on Next.js; all logic delegated to shared packages (`identity`, `config`, `community`, `moderation`, `analytics`, `hypixel`). The panel is **stateless** — sessions live in Redis (`sess:*`), the source of truth is Postgres, and hot config/permissions are cache-backed.

**Core principles**
- **Discord OAuth is the only login.** No local passwords.
- **You only see guilds you can manage** (Discord `MANAGE_GUILD`) *and* where our platform has a `Guild` record.
- **Depth of configuration follows the bot.** If a bot isn't present / lacks permissions in a guild, the panel shows what it can and gates the rest behind a clear "bot not installed / missing permission" state — it never lets you configure something the bot can't enforce.
- **The panel commands, it doesn't bypass.** Writes go through the same domain services the bots use; changes propagate via Redis cache invalidation + pub/sub so bots pick them up without redeploy.

---

## 1. Authentication & Session Model

### OAuth flow
1. `GET /login` → redirect to Discord OAuth (`identify`, `guilds`; `email` optional).
2. Callback → exchange code for tokens via `packages/identity`.
3. Fetch the user's guild list (`/users/@me/guilds`) and identity; store the OAuth **access + refresh tokens encrypted** server-side.
4. Create a Redis session `sess:{id}` (httpOnly, Secure, SameSite cookie). Session holds: `discordId`, cached manageable-guild ids, resolved platform roles, CSRF token, expiry.
5. Sessions are short-lived with sliding renewal; refresh tokens rotate. `/logout` revokes the session and clears the cookie.

### Guild visibility
- **Manageable set** = guilds where the user's Discord permissions include `MANAGE_GUILD` **∩** guilds that have a `Guild` row in our DB.
- The guild list is cached in the session (short TTL) and re-validated on entering guild-scoped pages, so a revoked Discord permission can't linger.
- **Bot presence** is resolved per guild: `INSTALLED` (bot in server + healthy), `MISSING_PERMISSIONS` (present but lacking required Discord perms), `NOT_INSTALLED` (offer invite link). This drives what each page enables.

---

## 2. Access-Control Rules

Two layers combine on every guild-scoped request: **Discord authority** (proves you may manage the server) and **platform role** (`GuildMember.role`, what you may do inside our system). The stricter of the two wins.

| Platform role | Can view | Can edit |
|---------------|----------|----------|
| `MEMBER` (non-staff) | *No panel access* (redirect to a member landing / their own linked info only) | — |
| `MODERATOR` (Staff) | Overview, Analytics (read), Moderation/Infractions, Tickets, Events (read) | Issue/read infractions, manage tickets, mark attendance |
| `OFFICER` | + Recruitment/Applications, Events (full), Bridge control | Applications decisions, create events, bridge suspend/unsuspend, wordlist |
| `ADMIN` / `OWNER` | + Settings, Feature flags, Role/Channel mapping, Health | All configuration, role/channel mapping, feature toggles, recruitment settings |

**Enforcement rules**
- Every guild-scoped API route resolves `(session.discordId, guildId) → GuildMember` via `packages/identity` and checks the required tier **server-side**; the UI hiding a control is never the only guard.
- **Rank hierarchy** applies to actions on people (can't action equal/higher rank), same as the Admin bot.
- **Bot-gated writes:** config that the bot must enforce (channels, wordlist, antiraid) is disabled with an explanatory banner when bot status is `MISSING_PERMISSIONS`/`NOT_INSTALLED`.
- **Audit:** every panel write emits a `ModerationAction`/audit + `CommandUsage(surface=WEB_PANEL)` record.
- **CSRF** on all mutations; **rate-limited** per session (`cd:web:*`).

---

## 3. Page-by-Page Behavior

### 3.1 Login / Logout
- **Login:** minimal page → "Sign in with Discord." Handles OAuth start/callback, error states (`access_denied`, expired code). On success → redirect to intended page or Guild Selector.
- **Logout:** revoke session + refresh token, clear cookie, redirect to Login.
- **Access:** public (login); authenticated (logout).

### 3.2 Guild Selector
- Lists the user's **manageable guilds** as cards: guild name/icon, bot status badge (`INSTALLED`/`MISSING_PERMISSIONS`/`NOT_INSTALLED`), member count, and the user's platform role there.
- `NOT_INSTALLED` guilds show an **Invite bot** action (OAuth bot invite w/ required scopes) instead of an Enter button.
- Selecting a guild sets the active `guildId` in session and routes to that guild's Overview.
- **Access:** any authenticated user; empty state if they manage no platform guilds.

### 3.3 Guild Overview Dashboard
- At-a-glance health + activity for the selected guild:
  - Bridge status (active/suspended, last relay, latency) and **command usage sparkline**.
  - Member counts (total, linked, verified, active), recent joins/leaves.
  - Open items: pending applications, open tickets, active infractions, upcoming events.
  - Worker/sync freshness summary (last profile snapshot, last guild-roster sync) with STALE flags.
- Everything is a summarized read; deep-dive links route to the specialized pages.
- **Access:** Staff+ (read).

### 3.4 Settings & Configuration
- Edit `GuildConfig`: prefixes, timezone, cooldown defaults, recruitment thresholds, notification defaults, bridge behavior toggles.
- Validated forms; on save → write through `config.SettingsService` → Postgres + Redis cache invalidation + pub/sub so bots reload live.
- **Bot-gated** fields clearly marked; changing a channel/role field cross-links to the mapping page.
- **Access:** Admin+ (edit); Staff read-only view.

### 3.5 Analytics & Reports
- **Bridge metrics:** messages relayed (each direction), relay latency, dropped/reconnect events, suspension history.
- **Command usage:** top commands, per-surface split (bridge/admin/web/in-game), success rate, latency percentiles, active users, trend over range.
- **Progression/engagement (optional):** milestones earned, event attendance rates.
- Date-range + surface filters; export (CSV). Data comes from `packages/analytics` (aggregated from `CommandUsage`, bridge health events, moderation events) — **read-only**, no live Hypixel calls.
- **Access:** Staff+ (read).

### 3.6 Moderation / Infractions View
- Searchable/filterable list of `Infraction` + `ModerationAction` (by member, actor, type, severity, date, active/expired).
- Per-member drill-down: full case history, notes, active mutes/bans with expiry.
- Actions (permission-gated): issue warn/note, revoke/adjust an active mute/ban, view but not alter another staffer's higher-rank actions.
- **Bridge suspensions** surfaced here and on Overview; officers can suspend/unsuspend with reason.
- Writes go through `moderation.ModerationService` (audit + Redis enforcement mirror + analytics event).
- **Access:** Staff+ (view/act within rank); Officer+ for bridge suspend.

### 3.7 Recruitment / Applications Queue
- Queue of `Application`s by status (`SUBMITTED`/`UNDER_REVIEW`/decided), with applicant answers and **fetched Skyblock stats** (weight/networth via `packages/hypixel`, cached) shown inline against recruitment thresholds.
- Actions: claim for review, accept (→ role grant + `GuildMember`), deny (reason + DM), request-info.
- Recruitment open/closed + thresholds editable here (Admin) or in Settings.
- Also surfaces **Tickets** (open/assigned/closed) with assign/close actions.
- **Access:** Officer+ (decisions); Staff can view/handle tickets.

### 3.8 Events & Attendance Manager
- Create/edit `Event`s (title, type, schedule, capacity, description); posts announcement + RSVP buttons via the bot.
- View `EventRSVP`s (going/maybe/no/waitlist) and manage the roster.
- **Attendance:** mark attendees, compare vs RSVPs, produce an attendance report; feeds engagement analytics.
- **Reminders:** schedule reminder pings (enqueued to workers) at offsets before start.
- **Access:** Officer+ (create/manage); Staff can mark attendance.

### 3.9 Feature Flags & Role/Channel Mapping
- **Feature flags:** per-guild toggles from `GuildConfig.features` (e.g. in-game commands, LFG, networth, antiraid). Toggling invalidates cache + pub/sub to bots.
- **Role mapping:** map platform roles (`MODERATOR`/`OFFICER`/`ADMIN`) → Discord role IDs, and set the verified-member role. Uses a live Discord role picker (needs bot present to enumerate roles).
- **Channel mapping:** assign functional channels (bridge, staff, log, applications, events) → Discord channel IDs, validated against the guild's channels.
- **View/edit raw role IDs & channel IDs** with validation and a "resolve name" preview; invalid/stale IDs flagged.
- **Bot-gated:** picker requires `INSTALLED`; degrades to manual-ID entry with validation warnings if the bot can't enumerate.
- **Access:** Admin+.

### 3.10 Linked Members & Verification
*(reachable from Overview/Recruitment; may be its own tab)*
- List `GuildMember`s with linked `MinecraftAccount`(s), verification status (`VERIFIED`/`PENDING`/`UNLINKED`), primary IGN, guild rank, last seen.
- Filter by verification state; spot unlinked/unverified members.
- Actions (Officer+): force re-verify (re-read Hypixel social), unlink, adjust member role/status.
- **Access:** Staff+ (view); Officer+ (edit).

### 3.11 Health / Status Panel (Bots & Workers)
- **Bots:** bridge-bot & admin-bot connection status, gateway latency, in-game bridge connection (Mineflayer session up/down, current lobby/limbo), last heartbeat, error rate.
- **Workers:** queue depths, active/failed/**stale jobs**, last run + duration per job type (bazaar/ah-sweep/pricing/snapshots/roster/global), from `WorkerJobLog` + live BullMQ state.
- **Sync freshness:** last successful bazaar/AH sweep, per-guild roster sync, snapshot coverage — with `STALE` thresholds and alerts.
- **Data layer:** Hypixel rate-limit budget remaining, API error/`API_DISABLED` counts, cache hit rates.
- Operational actions (Admin+): retry/requeue a failed job, force a sync, restart bridge session (where safe).
- **Access:** Admin+ (Staff may get a read-only subset).

---

## 4. Data Sources per Page

| Page | Reads from | Writes to |
|------|-----------|-----------|
| Login/Logout | `identity` (Discord OAuth), Redis session | Redis session |
| Guild Selector | Discord guilds + DB `Guild`, bot presence | Session (active guild) |
| Overview | DB summaries + Redis freshness + `analytics` | — |
| Settings | `config` (DB+cache) | `config` → DB + cache invalidation + pub/sub |
| Analytics | `analytics` (aggregated `CommandUsage`, bridge/mod events) | — (CSV export) |
| Moderation | DB (`Infraction`,`ModerationAction`) + Redis enforcement | `moderation` → DB + Redis + analytics |
| Recruitment/Tickets | DB (`Application`,`Ticket`) + `hypixel` (cached stats) | DB + role grant + DM |
| Events | DB (`Event`,`EventRSVP`) | DB + Discord (announce) + workers (reminders) |
| Flags/Mapping | `config` + live Discord roles/channels (bot) | `config` → DB + cache + pub/sub |
| Linked Members | DB (`GuildMember`,`LinkedAccount`) + `hypixel` | DB + Redis (re-verify) |
| Health | `WorkerJobLog` + live BullMQ + bot heartbeats + `rl:hypixel` | Requeue/force-sync (workers) |

---

## 5. Propagation & Consistency

- **Config writes** → Postgres (durable) → invalidate `cfg:guild:*` / `perm:guild:*` → publish `chan:config:{guildId}`; bots subscribe and reload effective config without redeploy.
- **Moderation writes** → DB audit + Redis enforcement mirror (`mute:*`/`ban:*`) so the bot enforces immediately.
- **Bot heartbeats & worker state** are published to Redis; the Health page reads live, so it reflects reality within seconds.
- **Eventual-but-fast:** the panel never assumes a write is enforced until the responsible surface acknowledges (e.g. channel mapping shows "pending bot reload" briefly, then "active").

---

## 6. Summary of Access-Control Rules

1. **Login only via Discord OAuth**; sessions in Redis, tokens encrypted, sliding expiry + refresh rotation.
2. **Guild visibility = Discord `MANAGE_GUILD` ∩ platform `Guild` record**, re-validated on entry.
3. **Every guild-scoped action authorized server-side** against `GuildMember.role`; UI gating is cosmetic only.
4. **Role tiers:** Staff (mod/tickets/read analytics) < Officer (recruitment/events/bridge) < Admin/Owner (settings/flags/mapping/health).
5. **Rank hierarchy** enforced on actions targeting people.
6. **Bot-gated configuration** — anything the bot must enforce is disabled (with explanation) when the bot is missing or under-permissioned.
7. **All writes audited** and rate-limited; **all writes go through shared domain services**, never around them.
