# Web Control Panel — SBR Guild Platform

Design for `apps/web-panel` — the Discord-OAuth control suite that configures both bots and surfaces analytics/ops. All logic delegated to shared packages (`identity`, `config`, `community`, `moderation`, `analytics`, `hypixel`). The panel is **stateless** — sessions live in Redis (`sess:*`), the source of truth is Postgres, and hot config/permissions are cache-backed.

**Core principles**
- **Discord OAuth is the only login.** No local passwords.
- **You only see guilds you can manage** (Discord `MANAGE_GUILD`) *and* where our platform has a `Guild` record.
- **Depth of configuration follows the bot.** If a bot isn't present / lacks permissions in a guild, the panel shows what it can and gates the rest behind a clear "bot not installed / missing permission" state — it never lets you configure something the bot can't enforce.
- **The panel commands, it doesn't bypass.** Writes go through the same domain services the bots use; changes propagate via Redis cache invalidation + pub/sub so bots pick them up without redeploy.

---

## 0. Serving Model

One Node process (`apps/web-panel/src/server.ts`, zero-dependency `node:http`) serves three things: the OAuth routes, the guild-scoped JSON API over `PanelService`, and the browser UI that reads it.

**Why not Next.js.** The session is an `HttpOnly` cookie this server issues and resolves against Redis. A second runtime in front of it would mean either duplicating that auth or proxying every request through it, for a UI whose job is to render view models the API already computes. The panel stays dependency-free instead.

**The UI** is plain ES modules in `apps/web-panel/client/`, compiled by `tsc -p tsconfig.client.json` into `public/app/` and served verbatim — no bundler, so what the browser loads is what tsc emitted. It shares the `PanelService` view-model types with the server via `import type`, which erases at emit, so the client ships no runtime import of `@sbr/panel-core` while still failing the build if a view model changes shape.

- **Routing is hash-based** (`#/g/{guildId}/{page}`) so the server needs exactly one HTML route and deep links need no server-side rewrite table to drift out of sync.
- **Rendering goes through the DOM API**, never `innerHTML` (`client/dom.ts`). Guild names, Discord usernames, and job error strings therefore cannot become markup.
- **`index.html` carries no inline script or style**, which is what lets the server send a CSP with no `'unsafe-inline'`.
- **Static serving is allowlisted by extension** and containment-checked against the asset root (`src/static.ts`); compiled client tests are not served.
- The JSON API remains independently usable — the UI is a second consumer of it, not a wrapper around it.

- **Charts are drawn as inline SVG** (`client/chart.ts`) over series the server has already zero-filled and grouped (`panel-core/src/series.ts`). Shaping happens server-side so the raw rollup rows stay the API's contract, the browser receives arrays it can draw without re-deriving the bucket grid, and the zero-filling is unit-tested under `node --test` rather than in a browser.
- **The chart list is discovered from the data**, not hardcoded: a metric appears on the page the day something starts emitting it. Today that is only `command.used`.

**Built so far:** every page in §3 — Guild Selector (§3.2), Overview (§3.3), Analytics (§3.5), Health (§3.11), Recruitment + Tickets (§3.7), Events (§3.8), Moderation (§3.6), Members (§3.10), Settings (§3.4), Mapping (§3.9) and XP (§3.12) — each with the writes its section describes, over the pipeline below.

Partial within the built pages, and deliberate: the recruitment queue shows applicants' answers but not their fetched Skyblock stats; Mapping takes role and channel ids by hand rather than through a live Discord picker, which needs the bot to enumerate; Health reports process liveness and job freshness but not queue depths or the Hypixel budget; the operational actions of §3.11 (requeue, force sync) are not wired; and Events schedules and cancels but does not announce, edit or mark attendance — see §3.8 for why.

**The editing unit is a field, not a form.** Each control saves itself and carries its own status line, because every domain service underneath takes one value (`setChannel`, `setFeature`, `setBridgeSuspended`) and a page-wide submit would report "saved" for a write that applied four of its five parts. The two exceptions submit as a unit because their parts are not separately storable: the moderation action form (§3.6), where a type without a reason is a row the audit log should never hold, and the event scheduler (§3.8), where a title without a start time is not an event. Controls that write on change (toggles, the role dropdown) snap back when the server refuses, so a widget never displays a value that was never stored.

### Transport: HTTP or HTTPS

`WEB_PANEL_SCHEME` decides how the panel is reached, and **defaults to `https`** — running without TLS is always a deliberate act, never the result of an omitted setting. The scheme is a declaration by the operator rather than something the server sniffs, because the three things that depend on it disagree about what they can observe: a cookie's `Secure` flag has to be decided before any request arrives, the CSRF origin check needs the public address (which behind a proxy is not the address this process bound), and only the operator knows whether something in front is terminating TLS.

| Setting | Effect |
| --- | --- |
| `WEB_PANEL_SCHEME=https` (default) | Session and CSRF cookies are marked `Secure`. TLS is terminated by a reverse proxy in front of this port, or in-process when `WEB_PANEL_TLS_CERT`/`WEB_PANEL_TLS_KEY` are both set. |
| `WEB_PANEL_SCHEME=http` | Cookies are issued without `Secure`, and the server logs a startup warning naming the tradeoff. For a VPS on a bare IP with no certificate yet. |
| `WEB_PANEL_PUBLIC_URL` | The origin the CSRF check compares against. Falls back to `DISCORD_OAUTH_REDIRECT_URI`, then to the local bind address — so the check is *active* on a bare-IP box rather than silently disabled, which is what the previous derivation did when the redirect URI was unset. |
| `WEB_PANEL_ALLOW_INSECURE=true` | Required to run `http` under `NODE_ENV=production`. |

`packages/config` rejects the combinations that would otherwise fail invisibly at login time, since each presents as "login succeeds but I'm never logged in" rather than as an error: a public URL whose scheme contradicts `WEB_PANEL_SCHEME`, an `https` callback under an `http` panel (the callback never arrives), a plaintext callback on a non-loopback host under the `https` default (the browser drops the `Secure` cookie), TLS material supplied alone or alongside `http`, and plaintext production without the acknowledgement. Loopback callbacks are exempt from the plaintext check because browsers treat `http://localhost` as a secure context, which is what lets the secure default work on a dev box with no certificate.

### Write path

Writes live in `PanelMutations` (`panel-core/src/mutations.ts`), a sibling of `PanelService` rather than more methods on it, because every write shares a pipeline the reads don't have: **authorize → rate-limit → validate → call the shared domain service → audit**. No SQL and no enforcement logic lives there; the panel commands the same services the bots do.

- **One route shape, one verb.** `POST /api/guilds/{guildId}/actions/{name}` is the only path that accepts a body, so "which URLs mutate" is answerable from the URL alone. Everything else still rejects any method but `GET`/`HEAD`.
- **CSRF is double-submit with a server-side check.** Login mints a token beside the session and sets it in a readable (non-`HttpOnly`) `sbr_csrf` cookie; the client echoes it in `x-csrf-token`, and the server compares that against the copy **in the session**, constant-time. Comparing header against cookie would pass for anyone able to write cookies for the domain. A present-but-foreign `Origin` is rejected outright. A session minted before writes existed has no token: it may still read, and a write asks it to sign in again.
- **Bodies are bounded while being read** (16 KB), not trusted from `content-length`, which a chunked request can omit or lie about.
- **Tiers are per mutation, not per page** (`MUTATION_TIERS`). Bridge suspend/unsuspend is an Officer control that no Officer-tier page owns; config writes are Admin.
- **Rate limit** is per user and per mutation on `cd:web:{mutation}:{discordId}` — a guard against a stuck key or a double-clicked toggle, not a quota.
- **Audit.** Every authorized attempt is captured as `CommandUsage(surface=WEB_PANEL)`, failures included, so a burst of refused writes is visible. Config changes additionally go through a `ConfigAuditSink`; they are *not* written as `ModerationAction`s, whose `type` enum describes actions taken on a person. Today the sink emits a typed analytics event; the port is what makes a durable `ConfigAudit` table a wiring change later.

Available now: `config.channel`, `config.setting`, `config.screening`, `config.role-mapping`, `config.feature`, `config.recruitment`, `bridge.suspend`, `moderation.action`, `application.decide`, `ticket.close`, `event.create`, `event.cancel`, `member.role`, `member.unlink`.

**`config.channel` accepts whatever `CONFIG_CHANNEL_SLOTS` lists**, not a copy of that list. The registry in `@sbr/shared-types` is what the mutation validates against *and* what the Mapping page renders a control for, so a slot cannot exist as a control that saves into a rejection, nor as an accepted name with no way to set it. The browser half cannot import the registry at runtime (no bundler, so a bare specifier would not resolve), so its copy lives in `client/pages/channel-slots.ts` beside a Node test that fails when the two lists differ.

**`config.setting` is the write path for config that isn't worth a column** — embed templates, per-feature payloads. The key namespace is open by design: a feature becomes configurable by picking a key, not by editing the mutation layer. What this layer enforces is what is true of every setting — a dotted lowercase key, a value that round-trips through JSON, and a 64 KiB ceiling — and it audits the key and byte count, never the payload, because a template can carry someone's words. Its tier is Admin: the keys are not enumerable here, so the one mutation has to sit at the highest tier any of them would need. Shape validation belongs to whichever feature owns the key; there is no generic settings editor, and reads of a setting arrive with the page that needs one.

**`config.screening` is the one setting with its own validated surface.** It writes the same `GuildSetting` row `config.setting` could — `screening.policy` — but it is the setting whose contents decide whether a stranger is admitted to the guild with nobody looking, so it gets a named mutation that checks every field and **rejects unknown keys**. That strictness is the deliberate mirror of the evaluator's read path, which is tolerant: a stored policy written years ago must still evaluate, so `parsePolicy` degrades a malformed field to its default rather than taking screening offline. A policy being typed *now* should fail at the keyboard instead, because a typo'd `minCatacomb` silently accepted would read back as "no dungeon requirement" and look identical to a working setting. The form sends the whole policy on every save — a partial write against a policy someone else just edited is a lost update nobody would notice until the wrong person got in — and `autoAccept` is refused unless `enabled` is also set, since "accept automatically without screening" is a configuration no admin means to save. Unlike `config.setting`, the audit records the policy in full: it is numbers and switches with nobody's words in it, and "who lowered the bar, and to what" is the question that audit exists to answer.

**The actor is handed to each mutation, not read by it.** `run()` passes the authenticated `discordId` into the mutation body, so an action cannot be attributed to anyone but the signed-in user even if the request body claims otherwise — a body-supplied `actorDiscordId` is ignored, and there is a test that says so.

**Where this layer stops.** Validation here is shape and policy only: it never re-derives a rule a domain service already owns. `applyModeration` does not compare ranks, because `ModerationService.applyAction` already refuses a target who outranks the actor, and a second copy of that comparison is one that drifts.

Four deliberate departures from the sections below:

- **`member.role` is Admin, not Officer** (§3.10 says Officer+ for member edits). Role assignment is the one member edit that hands out authority: at Officer tier an officer could promote themselves to ADMIN and reach the config pages. Self-targeting is refused outright for the mirror-image reason — an admin demoting themselves locks themselves out of the page they did it from.
- **OWNER is not assignable** from the panel at all, and is absent from the dropdown. Handing over ownership stays a deliberate act elsewhere.
- **`ROLE_CHANGE` and `GUILD_EXPEL` are not panel actions.** They describe events the platform records when they happen; exposing them as a write would let staff hand-feed the audit log entries about events that never occurred.
- **Force re-verify (§3.10) is not implemented.** `IdentityService.linkByIgn` requires the actor to be the person linking, so there is no service call for "re-read someone else's Hypixel social" — adding one is domain work, not panel wiring.

### CSV export

`GET /api/guilds/{id}/analytics?format=csv` returns `text/csv` with a `Content-Disposition: attachment` filename stamped from the window's end date; `&table=commands` switches from the rollup rows to the per-command stats. Both go through the same `loadAnalytics` call as the on-screen page, so the access decision on a download is provably the one the reader already passed — an unauthorized request gets the ordinary JSON denial envelope, never a file. Cells beginning `=`, `+`, `-`, `@`, tab, or CR are prefixed with an apostrophe: the export's destination is Excel or Sheets, which would otherwise evaluate them.

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
- **Join screening** (`BRIDGE_BOT.md` §6A): the entry bar, the scammer-list behaviour and the auto-accept switch, on their own card. Always shows the policy *in force* — a guild that has never saved one reads back the platform defaults, because rendering blanks would say "nothing is configured" while the scammer check is already running.
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

**Built:** the schedule (title, type, start, capacity, description → `event.create`), the upcoming list with its RSVP counts, a per-event roster of who is going / waitlisted / maybe / declined, cancellation (`event.cancel`), and a history of finished and cancelled events. Both writes sit at Officer.

- **The host comes from the session, never the body.** `CommunityService.cancelEvent` refuses anyone but the host, so a form that let you name someone else would create events their supposed host could not call off.
- **That host check is the domain's, not the panel's.** An Officer cancelling a colleague's event gets `NOT_HOST` back and sees it. The panel surfaces the refusal rather than working around it — the same reasoning as the moderation rank check (§3.6).
- **Start times are converted in the browser.** The `datetime-local` control holds local wall time with no zone; the client resolves it to an instant before sending, because a zone-less string would be read as UTC and move every event by the scheduler's offset.
- **The roster travels on the events read** (`?event={id}`), the way Moderation carries `?target=`. One round trip means the counts in the list and the names in the roster can never disagree about the same event.
- **Not built, because the domain has no method for it:** editing a scheduled event, marking who actually turned up, the attendance report, reminder scheduling, and the Discord announcement with RSVP buttons. `CommunityService` exposes `createEvent`, `getEvent`, `cancelEvent`, `rsvp` and `getAttendance` and nothing else; the announcement in particular needs a gateway connection this process does not hold. A button that silently did nothing would be worse than its absence.

### 3.9 Feature Flags & Role/Channel Mapping
- **Feature flags:** per-guild toggles from `GuildConfig.features` (e.g. in-game commands, LFG, networth, antiraid). Toggling invalidates cache + pub/sub to bots.
- **Role mapping:** map platform roles (`MODERATOR`/`OFFICER`/`ADMIN`) → Discord role IDs, and set the verified-member role. Uses a live Discord role picker (needs bot present to enumerate roles).
- **Channel mapping:** assign functional channels → Discord channel IDs, validated against the guild's channels. Every slot in `CONFIG_CHANNEL_SLOTS` gets a control: the five originals (bridge, staff, log, applications, events) plus LFG, tickets, milestones, leaderboard and modlog. The page reads them from `GuildRuntimeConfig.channels`, the canonical binding map, rather than from the five legacy `*ChannelId` columns — which is why a slot with no column behind it still shows up as "not set" instead of vanishing.
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

### 3.12 Guild XP
- **Per-source rules:** for each `XpSource` — whether it counts, its weight, its daily cap (blank = uncapped), its cooldown in seconds, and, for the two message sources, the minimum message length. Sources with no stored row render as **off**: a missing row *is* "disabled", and showing a guessed default would put a number on screen that nobody chose and no job reads.
- **Manual adjustment:** a signed amount against one member, with a **required reason** that is stored on the ledger row itself, not only in the audit trail — a member asking where 5,000 XP came from should be answerable from their own history. Armed-then-confirmed, and the form clears on success, because an adjustment is not a setting that can be corrected by typing a different value; the only way back is a second adjustment.
- **Not retroactive, and the page says so.** Weights are read when `xp-aggregate` derives a day, so a change lands on today's still-open counters and everything after; already-scored days keep the numbers they were scored under.
- **No standings, no leaderboard, no activity counters.** Those are member-facing and live behind `/standing` and `/leaderboard`. The panel owns the *rules* everyone is scored by, not the scores.
- **Degrades to a sentence** when XP is not wired into the deployment: the page says it is not enabled rather than rendering seven dead controls.
- **Access:** Admin+ (both writes, matching the page — an Officer-tier write behind an Admin-only page would be a permission nobody could exercise).

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
| XP | `xp` (`XpSourceConfig`) | `xp` → `XpSourceConfig`, `XpEvent` (adjustments) + audit |

---

## 5. Propagation & Consistency

- **Config writes** → Postgres (durable) → invalidate `cfg:guild:*` / `perm:guild:*` → publish `chan:config:{guildId}`; bots subscribe and reload effective config without redeploy. Implemented in `GuildConfigServiceImpl`: every write publishes the guild id after the row lands, and **a failed publish does not fail the write** — the durable change is done, and the subscribers' own TTLs are the fallback. Every process that reads config also subscribes, the panel included: an admin-bot `/set-channel` has to clear the panel's cache too, or the page that just showed the old value would keep showing it for the rest of the TTL.
- **Moderation writes** → DB audit + Redis enforcement mirror (`mute:*`/`ban:*`) so the bot enforces immediately. The panel holds the same `ModerationServiceImpl` the admin bot does, pointed at the same mirror — a panel mute and a `/mute` are one code path with two front doors.
- **Bot heartbeats & worker state** are published to Redis; the Health page reads live, so it reflects reality within seconds. Every process beats to `hb:{service}:{instance}` every 15s with a 45s TTL, so **absence is the signal**: a service that stops writing disappears from the keyspace and reads as DOWN rather than as a stale-but-present row. `EXPECTED_SERVICES` is a list, not a discovery, for the same reason — a dead bot has to look different from a bot that was never deployed. A beat older than 30s (between the interval and the TTL) reads STALE, which is where a process that is alive but wedged lands.
- **Reads are re-issued after a write, not patched.** A control that saved successfully re-reads the page it changed instead of splicing its new value into the rendered list, so the screen always shows what the server would answer with rather than what the browser hoped.
- **Eventual-but-fast:** the panel never assumes a write is enforced until the responsible surface acknowledges (e.g. channel mapping shows "pending bot reload" briefly, then "active"). *Not yet built* — today a saved write reports "Saved" on the strength of the service's own result.

---

## 6. Summary of Access-Control Rules

1. **Login only via Discord OAuth**; sessions in Redis, tokens encrypted, sliding expiry + refresh rotation.
2. **Guild visibility = Discord `MANAGE_GUILD` ∩ platform `Guild` record**, re-validated on entry.
3. **Every guild-scoped action authorized server-side** against `GuildMember.role`; UI gating is cosmetic only.
4. **Role tiers:** Staff (mod/tickets/read analytics) < Officer (recruitment/events/bridge) < Admin/Owner (settings/flags/mapping/health).
5. **Rank hierarchy** enforced on actions targeting people.
6. **Bot-gated configuration** — anything the bot must enforce is disabled (with explanation) when the bot is missing or under-permissioned.
7. **All writes audited** and rate-limited; **all writes go through shared domain services**, never around them.
