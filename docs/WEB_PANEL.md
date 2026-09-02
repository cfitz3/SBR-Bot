# Web Control Panel — SBR Guild Platform

Design for `apps/web-panel` — the Discord-OAuth control suite that configures both bots and surfaces analytics/ops. All logic delegated to shared packages (`identity`, `config`, `community`, `moderation`, `analytics`, `hypixel`). The panel is **stateless** — sessions live in Redis (`sess:*`), the source of truth is Postgres, and hot config/permissions are cache-backed.

**Core principles**
- **Discord OAuth is the only login.** No local passwords.
- **You only see guilds you can manage** — either Discord `MANAGE_GUILD` over a server the platform has a `Guild` record for, or moderator rank or above on that guild here. See `docs/PANEL_SECURITY.md` for the whole model.
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

**The look is the Nocturne design system** (`public/app.css`): a single dark palette — ground `#161826`, surface `#232532`, blurple accent `#9184d9` — on Inter where it is installed, with cards as rounded surfaces lifted by a hairline ring rather than a border, buttons outlined instead of filled, status pills that lead with a coloured dot, and table rules that fade out at the table's edges. Three things in the source design could not be ported literally, all for the same reason — the CSP has no `'unsafe-inline'` and no off-origin host:

- **Inline `style=` attributes became classes.** Anything genuinely computed (a bar's width, a legend swatch's colour) goes through `dom.ts`'s `style()`, which sets properties via the CSSOM and is not covered by CSP at all.
- **The webfont became a font stack.** Inter is named first and used if the operator has it; the system stack carries the same measurements otherwise.
- **The Phosphor icon font became inline SVG** (`client/icons.ts`): 24×24, stroked, taking their colour from `currentColor` so an active nav row tints its icon without a second rule.

**The words and the palette are both overridable, and neither is compiled into the client.** Every sentence the panel renders comes from a key in the brand layer, and every colour, spacing step, radius, shadow and font stack in that `:root` block is a token an operator can override — see [`BRANDING.md`](BRANDING.md). Two mechanisms, because the panel has no bundler and the two halves are reached differently:

- **Copy arrives over HTTP.** `client/*.ts` compiles straight to `public/app/` and the browser loads exactly those modules, so a client module may only `import type` from a workspace package. The resolved copy is served by `GET /api/copy` and installed by `installCopy()` in `main.ts`'s `boot()` before the first render — which is why copy readers in `client/` are always *functions* (`const t = scope("members")`), never module-level constants that would materialise a string before the fetch resolves. Client-adjacent `*.test.ts` files are exempt: they run under `node --test`, never in a browser, so they may import `@sbr/brand` at runtime.
- **Tokens arrive as a generated stylesheet.** `src/chrome.ts` renders `theme.panel` into a `:root` block served at `/theme.css` and linked *after* `app.css`, so overrides win by cascade with no rule in `app.css` rewritten. Same-origin, so `default-src 'self'` already allows it and the CSP is untouched — an inline `<style>` would have needed `'unsafe-inline'`, the one thing this panel is built to avoid. `app.css`'s `:root` stays as the documented fallback, and a test asserts every generated token has a declaration there so the fallback cannot develop a hole.

`index.html` is a server-rendered template rather than a static file, because the tab title, the theme colour and the `noscript` line are all on screen before any script runs — setting them from JS would flash the wrong name on every load, and the `noscript` line has to read correctly in a browser where `main.ts` never runs at all.

The chrome is a 272px sticky sidebar rather than a top tab strip: eleven pages do not fit across a laptop's width without wrapping, and the sidebar has room to group them under **Monitor**, **Queues** and **Configure** — watching, then the queues that need a person, then the settings that change how the platform behaves. Below 900px the whole thing stacks and the nav becomes a wrapped row, so every page stays reachable on a phone. The design's own light variant is not implemented and is not planned; a light Nocturne would be a second design, not a second theme.

**Built so far:** Guild Selector (§3.2), Overview (§3.3), Analytics (§3.5), Health (§3.11), Events (§3.8), Moderation (§3.6), Members (§3.10), Settings (§3.4), Milestones (§3.13) and Tickets (§3.14) — each with the writes its section describes, over the pipeline below. The Filter (§3.15) is no longer a page of its own: it is a section of Moderation.

**Eleven pages, not fourteen.** Three of the pages this document originally specified are gone as pages, and the sections that describe them (§3.7, §3.9, §3.12) are kept as the record of why rather than deleted, so the numbering the source files cite stays put:

- **Mapping (§3.9) folded into Settings (§3.4); XP (§3.12) folded in and then back out.** The split between them was never one an admin could predict — "which channel does the bridge use" and "is the bridge suspended" are the same question asked twice, and finding them on different tabs cost more than the shorter pages saved. One page is also one access decision and one round trip for what is one page's worth of configuration.
- **Recruitment (§3.7) is gone entirely.** Join screening (§3.4) decides admission automatically, so there is no queue of applications for a human to work; the ticket queue that shared the page moved onto Tickets (§3.14), which is where the people in those tickets already are.

Partial within the built pages, and deliberate: Health reports process liveness and job freshness but not queue depths or the Hypixel budget; the remaining operational actions of §3.11 (requeue a specific failed job, restart the bridge session) are not wired; and Events now schedules, edits, scores and finishes but still does not mark attendance — see §3.8 for why. Snowflake fields now resolve through the bot's live directory (§3.4), and the Overview's activity feed is a real read (§3.3); both were stubs and no longer are.

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

Available now: `config.channel`, `config.setting`, `config.screening`, `config.role-mapping`, `config.feature`, `config.recruitment`, `config.hypixel`, `xp.source`, `xp.adjust`, `xp.suggest`, `milestone.upsert`, `milestone.remove`, `progression.metrics`, `help.link`, `config.triggers`, `ticket.type.upsert`, `ticket.type.remove`, `ticket.panel.save`, `wordlist.upsert`, `wordlist.delete`, `moderation.defaults`, `moderation.relay-sync`, `automod.test`, `automod.rule.upsert`, `automod.rule.remove`, `automod.enable`, `config.cooldowns`, `roles.binding`, `roles.rank`, `roles.capability`, `roles.command`, `roles.exception`, `roles.exception.remove`, `health.run-job`, `bridge.suspend`, `moderation.action`, `application.decide`, `ticket.close`, `event.create`, `event.update`, `event.complete`, `event.attendance`, `event.board.publish`, `event.cancel`, `member.role`, `member.unlink`.

`config.recruitment` and `application.decide` are the two with **no control on any page**, and stay because the JSON API is independently usable (§0) and because removing a mutation is a contract break where removing a tab is not. Nothing in the UI calls them since Recruitment went away (§3.7).

**`config.channel` accepts whatever `CONFIG_CHANNEL_SLOTS` lists**, not a copy of that list. The registry in `@sbr/shared-types` is what the mutation validates against *and* what the Settings page's Channels card renders a control for, so a slot cannot exist as a control that saves into a rejection, nor as an accepted name with no way to set it. The browser half cannot import the registry at runtime (no bundler, so a bare specifier would not resolve), so its copy lives in `client/pages/channel-slots.ts` beside a Node test that fails when the two lists differ.

**`config.setting` is the write path for config that isn't worth a column** — embed templates, per-feature payloads. The key namespace is open by design: a feature becomes configurable by picking a key, not by editing the mutation layer. What this layer enforces is what is true of every setting — a dotted lowercase key, a value that round-trips through JSON, and a 64 KiB ceiling — and it audits the key and byte count, never the payload, because a template can carry someone's words. Its tier is Admin: the keys are not enumerable here, so the one mutation has to sit at the highest tier any of them would need. Shape validation belongs to whichever feature owns the key; there is no generic settings editor, and reads of a setting arrive with the page that needs one.

**`config.screening` is the one setting with its own validated surface.** It writes the same `GuildSetting` row `config.setting` could — `screening.policy` — but it is the setting whose contents decide whether a stranger is admitted to the guild with nobody looking, so it gets a named mutation that checks every field and **rejects unknown keys**. That strictness is the deliberate mirror of the evaluator's read path, which is tolerant: a stored policy written years ago must still evaluate, so `parsePolicy` degrades a malformed field to its default rather than taking screening offline. A policy being typed *now* should fail at the keyboard instead, because a typo'd `minCatacomb` silently accepted would read back as "no dungeon requirement" and look identical to a working setting. The form sends the whole policy on every save — a partial write against a policy someone else just edited is a lost update nobody would notice until the wrong person got in — and `autoAccept` is refused unless `enabled` is also set, since "accept automatically without screening" is a configuration no admin means to save. Unlike `config.setting`, the audit records the policy in full: it is numbers and switches with nobody's words in it, and "who lowered the bar, and to what" is the question that audit exists to answer.

**The actor is handed to each mutation, not read by it.** `run()` passes the authenticated `discordId` into the mutation body, so an action cannot be attributed to anyone but the signed-in user even if the request body claims otherwise — a body-supplied `actorDiscordId` is ignored, and there is a test that says so.

**Where this layer stops.** Validation here is shape and policy only: it never re-derives a rule a domain service already owns. `applyModeration` does not compare ranks, because `ModerationService.applyAction` already refuses a target who outranks the actor, and a second copy of that comparison is one that drifts.

Four deliberate departures from the sections below:

- **`member.role` is Admin, not Officer** (§3.10 says Officer+ for member edits). Role assignment is the one member edit that hands out authority: at Officer tier an officer could promote themselves to ADMIN and reach the config pages. Self-targeting is refused outright for the mirror-image reason — an admin demoting themselves locks themselves out of the page they did it from.
- **OWNER is not assignable** from the panel at all, and is absent from the dropdown. Handing over ownership stays a deliberate act elsewhere.
- **`ROLE_CHANGE` and `GUILD_EXPEL` are not panel actions.** They describe events the platform records when they happen; exposing them as a write would let staff hand-feed the audit log entries about events that never occurred.
- **Force re-verify (§3.10) is not implemented.** `IdentityService.linkByIgn` requires the actor to be the person linking, so there is no service call for "re-read someone else's Hypixel social" — adding one is domain work, not panel wiring.

### ID pickers

Almost every config field used to be a Discord snowflake the operator copied out of Discord by hand. They are now searchable dropdowns over the admin bot's gateway cache, reached through its loopback internal API (see `ADMIN_BOT.md` §7b for the routes, the token, and the **Server Members privileged intent** that member listing requires).

- **Three reads**, `directory-channels` / `directory-roles` / `directory-members`, on the ordinary guild-scoped read path and gated at **MODERATOR** — not Admin, because Moderator-tier pages use pickers too (a moderation target, a ticket assignee), and they disclose nothing a member cannot already see in Discord.
- **`INTERNAL_API_URL` + `INTERNAL_API_TOKEN`** configure the client. Responses are cached in Redis under `dir:{guildId}:{resource}:{q}` for 60s; **failures are never cached**, so a picker recovers by itself when the bot comes back.
- **No bot means degraded, not broken.** With the token unset, the bot down, or the token mismatched, every picker reports itself unavailable and falls back to the raw-snowflake text field with a Save button — exactly the control it replaced.
- **Three controls, one combobox.** `pickerField` (and its `channelPicker`/`rolePicker`/`memberPicker` variants) saves on selection, following the page's law that a field saves itself. `idChooser` is the same combobox as a *value*, for the two places a selection is not itself a write — the moderation lookup box and the composite action form. `multiPickerField` is the set version, chips over one search box, used for ticket staff roles. All three share `combobox()` so keyboard navigation and degradation cannot drift apart.
- **Typing an id still works** everywhere, deliberately: it is the only route when the directory is down, and the fastest one for someone who already has the id on their clipboard.
- **CSP holds.** The dropdown is positioned entirely from `app.css`; an inline `style=` would be silently dropped by `default-src 'self'`, so the class-name/stylesheet pairing is the only mechanism available and is the one used.

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
- **Manageable set** = the union of two routes: guilds where the user's Discord permissions include `MANAGE_GUILD` **∩** guilds with a `Guild` row in our DB, plus guilds where their *derived* platform role reaches `PANEL_ACCESS_FLOOR` (`MODERATOR`). The Discord-authority half is kept separately as `discordManagedGuildIds`, so a decision that genuinely turns on Discord's authority asks `managesInDiscord()` rather than the wider set.
- The guild list is cached in the session (short TTL) and re-validated on entering guild-scoped pages, so a revoked Discord permission can't linger.
- **Bot presence** is resolved per guild: `INSTALLED` (bot in server + healthy), `MISSING_PERMISSIONS` (present but lacking required Discord perms), `NOT_INSTALLED` (offer invite link). This drives what each page enables.

---

## 2. Access-Control Rules

Two layers combine on every guild-scoped request: **Discord authority** (proves you may manage the server) and **platform role** (`GuildMember.role`, what you may do inside our system). The stricter of the two wins.

| Platform role | Can view | Can edit |
|---------------|----------|----------|
| `MEMBER` (non-staff) | *No panel access* (redirect to a member landing / their own linked info only) | — |
| `MODERATOR` (Staff) | Overview, Analytics (read), Moderation/Infractions, Members, Tickets (the open queue), Events (read) | Issue/read infractions, close tickets, mark attendance |
| `OFFICER` | + Events (full), Bridge control | Create/cancel events, bridge suspend/unsuspend, unlink a member |
| `ADMIN` / `OWNER` | + Settings (config, channel mapping, feature flags, screening), XP, Permissions, Health, Milestones, Ticket config, Filter | All configuration, role/channel mapping, capability and command floors, per-subject exceptions, feature toggles, screening policy, XP policy and adjustments, milestone definitions, ticket types, chat-filter rules and the escalation ladder |

**No page sits at OFFICER any more.** The one that did was Recruitment, and the screening it existed to drive is automatic now (§3.4). The tier still exists in the role ladder and still gates individual mutations — bridge suspend, the five event writes, member unlink — it just isn't what any whole page turns on. Tickets went the other way: the page leads with the open queue, which is Moderator work (`ticket.close`), and the configuration on the same page stays Admin per-load rather than the whole page sitting at the higher tier and shutting out the people who answer tickets.

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
  - Member counts (total, linked, verified, active), recent joins/leaves, last profile snapshot.
  - Open items: open tickets, open infractions, active punishments, upcoming events.
- Ordered by what a staffer does with it — what is waiting on a human first, then membership — because a dashboard that leads with headline counts buries the queue that needed clearing this morning.
- **Job freshness is not here.** It moved to Health (§3.11) entirely: it answers a question about the platform rather than about the guild, and Health answers it in more detail than a three-row strip could.
- **Three tabs below the queue** — *Membership · Activity log · Join attempts*. All three arrive in the one overview response, so switching tabs is a change of what is shown, not another round trip.
- **Membership is two rosters, never one.** The Discord server and the in-game guild are different populations; blending them produces a number that describes neither. Joins and leaves are reported per side and per window, and each side displays the clock of the scan that produced it — a roster is only as true as its last scan, and `never` is a real answer meaning the job has not run yet.
  - The in-game side's movement is summed from `GuildScan.joined`/`.left`, **not** derived from `GuildMemberCache`: the cache mirrors *now* and has no memory of somebody who joined and left inside the window.
- **The activity log is a real read** (`PanelReads.listActivity`): five bounded queries — moderation actions, join screenings, milestones, event status changes, roster scans — interleaved by timestamp in JS, not unioned in SQL. The sources have different shapes, ownership and indexes, and a database-side union needs a common projection every future source has to be bent into. Each entry arrives already worded, because five client-side formatters would be five copies drifting from the five that exist elsewhere. Config changes are deliberately absent — they belong to the audit trail, which records who changed what rather than what the platform did on its own.
- **Join attempts** render `GuildJoinScreening` rows with the stat block as it stood at the moment of the request. The scam check keeps **three** states — *clear* / *listed* / *not checked* — because collapsing the null into "clear" is exactly how an outage reads as an all-clear. A dash in the stat line means the player's API was unreadable, never that the value is zero.
- Everything else is a summarized read; deep-dive links route to the specialized pages.
- **Access:** Staff+ (read).

### 3.4 Settings & Configuration

**One page for everything an admin configures.** It absorbed what §3.9 and §3.12 describe as separate Mapping and XP tabs; those sections stay below as the record of the behaviour, which did not change when it moved. Cards, in order:

- **Guild** — identity and the Hypixel guild binding (`config.hypixel`).
- **Bridge** — behaviour toggles and the suspend control.
- **Channels** — every slot in `CONFIG_CHANNEL_SLOTS`, an unbound one rendered as "not set" rather than omitted (§3.9).
- **Roles** — platform role → Discord role id mapping (§3.9).
- **Feature flags** — per-guild toggles from `GuildConfig.features` (§3.9).
- **Link walkthrough** (`help.link`, Moderator) — the image and the extra note behind `/help`'s "How do I link?" button. Linking is where new members get stuck, and the reason is a Hypixel setting three menus deep that no embed prose explains as well as a recording of somebody doing it; this is where a guild puts theirs. Both halves are optional and neither replaces the platform's written steps — a guild that configures nothing still gets those.
- **Triggers** (`config.triggers`, Admin) — the rules that say what the bot
  watches for and what it does about it: a reaction count or a phrase, and a
  repost, a pin or a reply. A starboard is the first pair and the shape a new
  rule is pre-filled with, because almost every guild that opens this card
  wants that rule and an empty form would make them supply four answers before
  seeing what the feature does. Each rule carries its own channel scope,
  exemptions and bot/self switches — a board that reposts out of the staff
  channel is a leak, and that has to be decidable per rule rather than once
  for the guild.
- **Join screening** (`BRIDGE_BOT.md` §6A) — the entry bar, the scammer-list behaviour and the auto-accept switch. Always shows the policy *in force*: a guild that has never saved one reads back the platform defaults, because rendering blanks would say "nothing is configured" while the scammer check is already running. This is what replaced the application queue of §3.7.

Everything arrives in **one read** (`SettingsVM`) and therefore one access decision and one round trip. Writes stay per-field, as everywhere else (§0), routed to whichever domain service owns the value — `config.SettingsService`, then Postgres + Redis cache invalidation + pub/sub so bots reload live. Two cards are the exceptions. The **link walkthrough** saves its two halves together, because the validator judges them together and a guild swapping a recording usually rewords the note in the same sitting; two writes would leave the button briefly captioning a video it no longer has. **Triggers** batches the whole list, because a rule is not one control: an emoji, a count, a destination and a scope saved one at a time would mean a rule briefly reading “repost every star from anyone, into nowhere” while somebody finishes typing it, and the validator judges the list as a set — unique ids, under the cap — so it has to be asked about the list rather than a field of it. What comes back stored is the *parsed* list, which is what normalises a custom emoji typed `<:star:123>` into the `star:123` form the gateway actually reports; a rule saved verbatim would never match.

- **Bot-gated** fields clearly marked.
- **Access:** Admin+.

### 3.5 Analytics & Reports

Six fixed cards, plus one chart per rollup series that actually has events in the window.

| Card | Source | What it answers |
| --- | --- | --- |
| **Messages** | `ActivityDaily`, summed | Discord lines and guild-chat lines, **never their sum**, each with a per-day rate. |
| **Engagement** | `ActivityDaily` | How many people said anything, and how much the average one said. |
| **Playtime** | `PlaySession`, `GuildGexpDaily` | Measured in-game hours; the Discord half is still an estimate — see below. |
| **Guild experience** | `GuildGexpDaily`, summed per day | The GEXP trend, drawn through the same `lineChart` the rollups use. |
| **Top members** | `ActivityDaily` ⋈ `GuildGexpDaily` | One table spanning both surfaces, so somebody who only plays and somebody who only talks both rank. |
| **Top commands** | `CommandUsage` | Usage, success rate and latency per command. |

The fixed cards read the daily counters directly, so they populate on a guild that has never had a rollup run. The rollup charts are additive: `bridge.relay`, `mod.action` and `filter.hit` are emitted from `BridgeService.processInbound`, `ModerationServiceImpl.applyAction`, `AutomodRunner.run` and the relay's wordlist filter, through synchronous `void`-returning metrics ports — telemetry can never delay a chat message or fail a punishment.

**In-game playtime is measured; the Discord half is still an estimate, and the card keeps them apart.** In-game hours are the sum of closed `PlaySession` rows — real elapsed time between a bridge-observed join and the matching leave, debounced so a reconnect is one session rather than two. That replaces the old `presenceSamples × 360 minutes` proxy, which multiplied a sample count by a cadence and produced a number with no relationship to any member's actual evening. Discord presence is still unsampled: **nothing calls `XpService.recordPresence`**, so that half reads "Not sampled" rather than rendering a plausible-looking nothing.

**Unknown is never zero.** A member with no verified link has no uuid, so their GEXP and active-day counts are `null` and render as an em dash. Printing `0` would claim they earned none, which is a different and unfounded statement.

Date-range + bucket-size filters; export (CSV) for the rollups and for command stats. Read-only — no live Hypixel calls.
- **Access:** Staff+ (read).

### 3.6 Moderation / Infractions View

**Four sections on one page, not four pages.** The page carries a tab strip — *History · Automod · Filter · Cooldowns* — rather than sub-routes, because everything that acts on a member without a person in the loop belongs next to the history of what it did. The Filter section is the former §3.15 page folded in whole (`pages/wordlist.ts` now exports `filterCards` and renders nothing of its own); the automod rules read the same wordlist, and two places to configure one list is the friction this overhaul exists to remove.

- **Tiers are per load, not per page.** The page stays gated at `MODERATOR`; the view model carries `canConfigure` (Admin+), and a Moderator gets History alone with the tab strip hidden entirely rather than three tabs that refuse on click. Raising the page to Admin would have taken the infraction history away from the people who use it most.
- **The `wordlist` read route stays on the JSON API** even though the nav entry is gone. Removing a route is a contract break for anything driving the API directly; the panel simply reaches that data through the moderation view model, which already carries it.
- **A new rule defaults to flag-only with no deletion** — it records what it *would* have caught while the operator is still finding out whether it catches the right things. The "Test a message" box runs the real evaluator against sample text with stubbed counters: nothing is written, and the tested message itself is never recorded (the audit line holds its length and the rule ids, not its text).
- **Trigger-kind switching rebuilds only the parameter fields**, in place, rather than re-reading the page — a re-read would collapse the row being edited. `state.editing` likewise survives the reload a save triggers.
- Searchable/filterable list of `Infraction` + `ModerationAction` (by member, actor, type, severity, date, active/expired). The lookup box searches **name, IGN or id** through the Phase-2 directory read, so staff who know a member by their username do not have to go and fetch a snowflake first.
- Per-member drill-down: full case history, notes, active mutes/bans with expiry.
- An **In force now** card lists only what is currently being enforced (`ModerationService.listInForce`). It answers a different question from the history table below it: "is this person already muted" is what decides whether to escalate, and reading it off a history means checking every row's expiry by eye. With no target it is the guild-wide list of live mutes and bans.
- Each history row carries a resolved state — **in force / expired / lifted**, and nothing at all for a warn or kick, which had no duration to run out. The state is computed on the server (`ModerationActionVM.state`, from `@sbr/moderation`'s `punishmentState`) rather than read off the `active` flag: the expiry sweep clears that flag, so a flag-only reading would credit a staffer with every unmute the clock performed.
- Actions (permission-gated): issue warn/note, revoke/adjust an active mute/ban, view but not alter another staffer's higher-rank actions.
- **Bridge suspensions** surfaced here and on Overview; officers can suspend/unsuspend with reason.
- Writes go through `moderation.ModerationService` (audit + Redis enforcement mirror + analytics event).
- **Access:** Staff+ (view/act within rank); Officer+ for bridge suspend.

### 3.7 Recruitment / Applications Queue — *removed*

**There is no Recruitment page.** It was built, then taken out; this section is kept so the numbering the source files cite stays put and so the reasoning is on record.

What it did is now done in two places, neither of them a queue:

- **Admission is decided automatically** by join screening (§3.4). The page existed to put a human in front of an applicant's answers and their fetched Skyblock stats; the screening policy applies the same entry bar — weight, networth, the scammer list — at the moment of the join request, with an audit line behind it. A queue in front of a decision nobody was making by hand is a tab that only ever reads "nothing waiting".
- **Tickets moved to §3.14**, which now leads with the open queue. They only shared a page with applications because both were "things staff work through"; the people in a ticket and the ticket's configuration belong together more than the ticket and a membership application ever did.

The `Application` model, `config.recruitment` and `application.decide` all still exist — the mutations are reachable over the JSON API, and nothing in the UI calls them (§0). Removing them is a domain decision, not a panel one.

### 3.8 Events & Attendance Manager
- Create/edit `Event`s (title, type, schedule, capacity, description); posts announcement + RSVP buttons via the bot.
- View `EventRSVP`s (going/maybe/no/waitlist) and manage the roster.
- **Attendance:** mark attendees, compare vs RSVPs, produce an attendance report; feeds engagement analytics.
- **Reminders:** schedule reminder pings (enqueued to workers) at offsets before start.
- **Access:** Officer+ (create/manage); Staff can mark attendance.

**Built:** the schedule (title, type, start, capacity, description → `event.create`), the upcoming list with its RSVP counts, a per-event edit form covering the tracker's settings (`event.update`), the live scoreboard with its unlinked warnings, a per-event roster of who is going / waitlisted / maybe / declined, an on-demand board redraw (`event.board.publish`), finishing an event (`event.complete`), a turnout card recording who was actually there (`event.attendance`), cancellation (`event.cancel`), and a history of finished and cancelled events whose rows open the same result view. Every write sits at Officer.

- **The host comes from the session, never the body.** `CommunityService.cancelEvent` refuses anyone but the host, so a form that let you name someone else would create events their supposed host could not call off.
- **That host check is the domain's, not the panel's.** An Officer cancelling a colleague's event gets `NOT_HOST` back and sees it. The panel surfaces the refusal rather than working around it — the same reasoning as the moderation rank check (§3.6).
- **Start times are converted in the browser.** The `datetime-local` control holds local wall time with no zone; the client resolves it to an instant before sending, because a zone-less string would be read as UTC and move every event by the scheduler's offset.
- **The roster travels on the events read** (`?event={id}`), the way Moderation carries `?target=`. One round trip means the counts in the list and the names in the roster can never disagree about the same event.
- **Editing is staff work, unlike cancelling.** `updateEvent` and `completeEvent` take an `isStaff` flag, and the panel passes it: reaching either mutation already required the Officer tier, and an officer who cannot fix a colleague's typo has to cancel and re-create the event to do it. `cancelEvent` deliberately still refuses anyone but the host — calling an event off is the host's decision in a way that correcting its start time is not.
- **Cross-guild ids are refused by the panel, not the service.** Every event mutation re-reads the event and compares its `guildId` before writing. `CommunityService` knows about events, not about which server is asking, so pasting another guild's event id into this guild's page has to fail here or nowhere.
- **The whole form is sent on Save**, including untouched fields. `updateEvent` writes only what it is given, and sending everything means the values on screen are the values stored — a field left alone has no way to keep an older one. A past start is refused only while the event is `SCHEDULED`: a live event's start is in the past by definition.
- **Un-ticking a metric hides its scores, it does not delete them.** The scoreboard reads every `EventScore` for the event and renders one column per *currently tracked* metric, in the event's own order — so the leftmost column is the one the Discord board sorts by, and a metric turned off can be turned back on with its history intact.
- **The unlinked list is the more useful half of that card.** A member going who has no `VERIFIED` link cannot be polled, so their absence from every leaderboard is a gap in the data rather than a quiet night. It is computed from the same roster read as the names.
- **Finishing is a person's call, not the clock's.** The scheduler knows only that a start time passed; an event that ran long would get its result card written mid-run. `event.complete` stamps `endsAt` and lets the board job write the final card once.
- **"Update board now" exists because the pass is half-hourly.** An organiser who has just corrected the metric list should not wait thirty minutes to see the board agree. It posts through the bridge's loopback API (`WORKERS.md §2.7c`), and a panel process with no bot behind it says so instead of reporting a phantom post.
- **Turnout is a separate record from the RSVP, not a flag on it.** `EventAttendance` is keyed by `(eventId, discordId)` and exists because attendance is not a subset of the roster: a walk-in who never touched the buttons was still there, and a "going" who never showed was not. Rows carry a `source` — `TRACKED` when the poller scored the member during the event, `MARKED` when a person said so.
- **The tracker seeds the list at completion, and only then.** `completeEvent` writes a `TRACKED` row for everyone with an `EventScore`, because that is the one moment the scored set stops growing. Somebody correcting it afterwards is correcting something rather than typing a roster from memory.
- **A hand-marked save replaces `MARKED` rows and leaves `TRACKED` ones alone.** The page submits the ticked boxes rather than a diff, so what is on screen is what is stored — but the poller watched the event and the person ticking boxes is remembering it, so the observation wins. Tracked names render as a badge instead of a box, because offering to untick an observation would be offering a lie.
- **The card only appears once the event has started** (or once something has already been recorded, which can happen when a start time is corrected later). Before that there is nothing to answer.
- **Still not built:** the attendance report and on-demand reminders. The report needs the Phase 16 aggregate to count against; the reminders belong to the scheduler, and a button racing it would post twice.

### 3.9 Feature Flags & Role/Channel Mapping — *now three cards on Settings (§3.4)*

Not a tab of its own. The behaviour below is unchanged and is what the Channels, Roles and Feature flags cards do; only the address moved.

- **Feature flags:** per-guild toggles from `GuildConfig.features` (e.g. in-game commands, LFG, networth, antiraid). Toggling invalidates cache + pub/sub to bots.
- **Role mapping:** *moved to the Permissions page (§3.16)*, and widened there from one Discord role per level to a set. The card is gone from Settings; `config.role-mapping` stays on the API for the same reason every superseded mutation does.
- **Channel mapping:** assign functional channels → Discord channel IDs, validated against the guild's channels. Every slot in `CONFIG_CHANNEL_SLOTS` gets a control: the five originals (bridge, staff, log, applications, events) plus LFG, tickets, milestones, leaderboard and modlog. The page reads them from `GuildRuntimeConfig.channels`, the canonical binding map — which is why a slot nothing has ever written still shows up as "not set" instead of vanishing. (It read that map over five mirrored `*ChannelId` columns until Phase 11 backfilled and dropped them; the page never had to change.)
- **View/edit raw role IDs & channel IDs** with validation and a "resolve name" preview; invalid/stale IDs flagged.
- **Bot-gated:** picker requires `INSTALLED`; degrades to manual-ID entry with validation warnings if the bot can't enumerate.
- **Access:** Admin+.

### 3.10 Members — the unified directory
*(its own tab, reachable from Overview)*

The page lists **both rosters merged**, not only the people who have linked. Its previous shape could describe a person only if they had a platform membership row, which made the two questions staff actually ask — *who is in the guild but not in the server*, and *who is in the server but not in the guild* — unanswerable from the panel.

- **Read:** `PanelReads.listDirectory(guildId, {q, side, limit})`. The Discord side (`GuildMember`→`DiscordUser`, written by `discord-member-sync` every 2 h) and the in-game side (`GuildMemberCache`, written by `guild-scan` every 6 h) are loaded whole and merged in JS through `LinkedAccount`→`MinecraftAccount`. It is a full outer join with no shared key — the two sides meet only through the link table, and the rows that matter most are exactly the ones where that join fails — so it is not expressible as one Prisma query. Both sides are guild-sized, which is why loading them whole is cheaper than the query that would avoid it.
- **Linked means a `VERIFIED` link.** An unverified one is a link *attempt*; treating it as a match would put somebody else's stats on the row.
- **Tabs:** *All / Discord only / In-game only / Unlinked*. "Discord only" and "in-game only" mean *absent from the other side*, not *present on this one* — otherwise a linked member would appear under both and neither tab would answer the question it is named after. An unrecognised `side` in the URL falls back to the unfiltered list rather than erroring.
- **Search is server-side** and matches username, nickname, IGN, guild rank, Discord id **and** uuid. It cannot be done in the browser any more: half the fields it matches on belong to rows the browser would otherwise never receive. The input is debounced so a keystroke is not a query.
- **Counts describe the roster, not the search** — `discordCount`, `guildCount`, `linkedCount` are computed before filtering, so the tabs do not each report a different guild size. Linked is shown as a percentage *and* a fraction: the percentage says how healthy linking is, the fraction says how many people are left to chase.
- **Each roster shows its own scan clock.** A roster is only as true as its last scan, and a page that displays stale numbers without saying so is the one that gets acted on. Never scanned reads as "Never scanned", not as zero.
- **There is no "awaiting verification".** Nothing in `packages/identity` ever writes `LinkStatus.PENDING`: verification either succeeds and the link is VERIFIED, or it does not and there is no link. The old tile therefore counted a state that could not occur, while inviting staff to wait for something that was never going to arrive. Linked is a yes or a no.
- **Actions (Officer+):** platform role and unlink, both only on rows that have a Discord side — an in-game-only row has no membership to hold a role and no link to detach. It is still listed, because finding it is the point of the tab.
- **Access:** Staff+ (view); Officer+ (edit).

### 3.11 Health / Status Panel (Bots & Workers)
- **Bots:** bridge-bot & admin-bot connection status, gateway latency, in-game bridge connection (Mineflayer session up/down, current lobby/limbo), last heartbeat, error rate.
- **Workers:** queue depths, active/failed/**stale jobs**, last run + duration per job type (bazaar/ah-sweep/pricing/snapshots/roster/global), from `WorkerJobLog` + live BullMQ state.
- **Sync freshness:** last successful bazaar/AH sweep, per-guild roster sync, snapshot coverage — with `STALE` thresholds and alerts.
- **Data layer:** Hypixel rate-limit budget remaining, API error/`API_DISABLED` counts, cache hit rates.
- **Run now (Admin+).** Each job row carries a button that starts that job out of cadence — the "force a sync" of the original spec, generalised: there is no separate force-sync control because every sync *is* a job, and a button per row needs no list of which ones count.
  - **The panel does not enqueue.** It publishes `{jobName, guildId, actorDiscordId}` on `chan:jobs` and the worker process adds it to BullMQ, so exactly one process writes the queue and the panel carries no BullMQ dependency. The consequence is that success means **requested**, not **ran**, and the button says so: the last-run column is the only thing that can confirm the work happened, and the page re-reads a few seconds later to show it.
  - **The allow-list lives in `@sbr/redis` beside the bus** (`RUNNABLE_JOBS`), which both the panel and the workers already depend on. `HealthVM` carries `runnable` per row rather than the client holding its own copy — a client-side list is exactly the drift the allow-list exists to prevent. `heartbeat` and `analytics-ingest` are excluded: they run on a seconds-scale timer, so starting one by hand means nothing. A worker test asserts every runnable name is in `SCHEDULE`.
  - **A second cooldown, keyed per job and per guild** (`MANUAL_JOB_COOLDOWN_MS`, 60s) sits on top of the standard per-user mutation gate. Not per actor, deliberately: two admins each inside their own two-second window is exactly how a snapshot pass gets run four times in a minute.
  - A deployment with no worker bus wired reports `SERVICE_ERROR` and renders no buttons at all, rather than a disabled control the reader has no way to enable.
- **Waiting to be announced.** A card above the tables, present only when the number is non-zero, reporting how many of the guild's achievements the announcer is holding (`PanelReads.pendingMilestones` — `Milestone` rows with `announced = false`). The announcer no longer discards what it cannot deliver (`apps/bridge-bot/src/milestones.ts`), so an unbound `milestones` channel accumulates a backlog instead of silently losing it, and this is the one surface that says so. The second line names the likely cause: no channel bound, or — when one is — a failing announcer, which the Workers table below then explains.
  - Deliverability is not computed in SQL. The count is "pending", and whether a channel is bound comes from the guild config the page already reads, because the announcer's own rule (post, or leave it) is the only place that judgement belongs.
- Remaining operational actions (retry a specific failed job, restart the bridge session) are still unwired.
- **Access:** Admin+ (Staff may get a read-only subset).

### 3.12 Guild XP — *a page of its own again (`xp`, Admin)*

It was folded into Settings and outgrew it: eight source forms were most of that page's height and none of the rest of Settings was about XP. `XpVM` / `PanelService.loadXp` / `client/pages/xp.ts`.

Moving it out is what let it gain the two read-only lists it now carries. An admin changing a weight is guessing until they can see the standings the current weights produced, and an adjustment nobody can see afterwards is an unauditable write. Neither list is a report — twenty rows each, because `/leaderboard` is the member-facing board and the ledger is in the database for anyone who needs all of it.

- **Per-source rules:** for each `XpSource` — whether it counts, its weight, its daily cap (blank = uncapped), its cooldown in seconds, and, for the two message sources, the minimum message length. Sources with no stored row render as **off**: a missing row *is* "disabled", and showing a guessed default would put a number on screen that nobody chose and no job reads.
- **Each source is one line until you open it,** and the three anti-abuse limits sit behind a second disclosure inside it. The switch and the weight are what an admin came for; cap, cooldown and minimum length are tuning, and all five controls across eight sources read as forty fields.
- **Suggested settings** (`xp.suggest`) writes `SUGGESTED_POLICY` from `@sbr/xp` — the engine's own numbers rather than a second set kept in the panel, so the button cannot drift from what the engine documents as sane. It covers seven of the eight sources (`MILESTONE` is not one of them: a source the suggestion has no opinion about keeps whatever the guild chose) and it **overwrites**, which is why it is confirmed before it fires.
- **Standings:** the top twenty under the current rules, from the same `XpService.leaderboard` the bots read. Names come from the guild's linked members; somebody who earned XP without ever linking renders as their Discord id, which is honest and pasteable rather than "Unknown member".
- **Recent adjustments:** the last twenty MANUAL ledger rows, newest first, with amount, author and reason. `XpService.recentAdjustments` is **optional** — a deployment whose XP service predates it renders an empty history rather than an error — and both this and the standings absorb their own failure. The policy is the page; the two lists are commentary on it, and losing a ranking query must not cost the admin the weights they came to change.
- **Manual adjustment:** a signed amount against one member, with a **required reason** that is stored on the ledger row itself, not only in the audit trail — a member asking where 5,000 XP came from should be answerable from their own history. Armed-then-confirmed, and the form clears on success, because an adjustment is not a setting that can be corrected by typing a different value; the only way back is a second adjustment.
- **Not retroactive, and the page says so.** Weights are read when `xp-aggregate` derives a day, so a change lands on today's still-open counters and everything after; already-scored days keep the numbers they were scored under.
- **No standings and no activity counters here.** Those are member-facing and live on `/me`. The panel owns the *rules* everyone is scored by, not the scores. (Standings themselves did get a panel surface — §3.18 — but a read-only one, on a different page, with no control on it.)
- **Degrades to a sentence** when XP is not wired into the deployment: the section says it is not enabled rather than rendering seven dead controls. The rest of Settings still renders — a deployment without XP still has channels to bind.
- **Access:** Admin+ (both writes, matching the page it now sits on — an Officer-tier write behind an Admin-only page would be a permission nobody could exercise).

### 3.13 Milestones
- **Definitions, not standings.** Each row is one thing the guild recognises: its key, the metric it reads (`MILESTONE_METRICS`), the threshold, the type, whether it is announced, and what reaching it pays. Who has reached what is member-facing and stays in the bots behind `/milestones`.
- **Built-in defaults are listed alongside a guild's own rows**, because they are already in force — listing only stored rows would show an empty page for a guild that is in fact recognising thirty things. A default carries `source: "DEFAULT"` and `id: null`, so the first edit is a create: editing one writes a guild row that shadows it by key.
- **Every control saves the whole definition** rather than a patch, since for a default there is nothing on the server to merge a patch against.
- **Removal is for guild rows only.** The way to stop recognising a built-in is to switch it off, which stores it disabled — deleting a row that does not exist would just make the default reappear.
- **Grouped by family, one collapsed row each.** The catalog is twenty-two metrics across seven families (`ACHIEVEMENT_CATEGORIES`), so a flat list of open cards that read fine at six is a scroll at forty. Families appear in the platform's declared order rather than sorted by name or size, so the page reads the same on every guild. An empty family is omitted rather than shown as a heading over nothing, and a metric the browser's mirror does not recognise lands in `PROGRESSION` — matching `categoryOfMetric` upstream, so a definition from a newer deployment is grouped oddly rather than dropped and made uneditable.
- **The summary line is what somebody scanning is checking:** name (with its icon, inserted as text), tier badge, what it measures, how many members hold it, and — only when they apply — hidden, switched-off, and custom-vs-built-in. Everything editable is behind the row.
- **Tier, icon and hidden are editable here.** They already existed on `MilestoneDefinitionDTO` and were carried by the mutation; the page simply never exposed them. Tier is presentation only, the icon is capped at four characters counted as code points (so one emoji is one), and hidden means members see only that an unnamed achievement exists until they earn it — the reveal is the reward.
- **"Held by N" comes from `MilestoneDefinitionService.countHolders`**, an optional method: a page that lists what the guild recognises is worth having without a count beside each row and is not worth losing over one, so the read is absorbed to `{}` on failure and the port stays optional for callers that do not implement it. The count groups `Milestone` rows on `(metric, thresholdValue)` rather than joining on `definitionId`, because a milestone detected against a built-in default carries no definition id — a join would report the twenty-odd defaults as held by nobody, which is exactly backwards.
- **Community definitions read differently, and say so.** `COMMUNITY_MILESTONE_METRICS` (events attended, event podiums, days in the guild, guild XP) are counted by this platform rather than read from Hypixel, so they are recognised from the standing the moment the number is reached — retroactively, for members already past it — and never announced. Their families carry a note saying that, their holder badge reads "Not counted" rather than "Nobody yet" (there are no recorded crossings to count), and the "Announced" switch is omitted rather than shown-and-ignored: a control that saves happily and does nothing is worse than no control.
- **Charted metrics — what `/progression` offers.** A card above the definitions
  picks which of `SNAPSHOT_MILESTONE_METRICS` appear in the metric menu on the
  member-facing `/progression` card. It lives on this page rather than one of its
  own because it is the same question the definitions ask — which of the tracked
  numbers this guild cares about — and splitting the two would let a guild
  recognise a fairy-souls milestone while being unable to chart fairy souls.
  It is the only control here that saves as a unit, hence plain boxes and a Save
  button rather than switches: the set is one value, the cap of 25 is Discord's
  limit on a select menu, and "at least one" is a rule about the set — writing
  each tick separately would mean refusing the flip that empties the menu, which
  reads as a broken checkbox rather than as the rule it is. Narrowing it changes
  nothing about what is recorded: the tracker keeps every metric either way, and
  a reading not taken is history that cannot be recovered later.
- **`progression.metrics` is its own mutation, not `config.setting`.** The generic
  setting write is deliberately opaque about value shape, so a mistyped metric
  would be stored, silently dropped by the tolerant reader, and reported as
  saved. The typed mutation runs `validateProgressionPolicy` — which is the whole
  reason the policy module has a strict writer beside its tolerant reader — and
  its audit entry records the count rather than the list, because the list is the
  setting and the audit is a record of the change.
- **Access:** Admin+.

### 3.18 Leaderboard — standings, read-only

Added after WEB_PANEL.md §0 had already said there would be no panel surface for
leaderboards at all. The reasoning then was that a leaderboard is something the
guild reads, not something staff administers — and the second half of that is
still true, which is why this page has **no action anywhere on it**. What the
first half missed is that "staff does not administer it" is an argument for a
page without controls, not for no page.

- **Same service, same ranking.** The page reads `LeaderboardService` over
  `leaderboardSource`, which is what `/leaderboard` reads. A member who is 3rd
  in Discord is 3rd here; two ranking implementations would eventually disagree,
  and the disagreement would be invisible until somebody screenshotted both.
- **Thirteen categories as a tab strip**, built from `LEADERBOARD_CATEGORIES` so
  a category added in shared-types appears here with no panel change. Switching
  category resets to page one: page four of Catacombs has nothing to do with
  page four of Wealth.
- **Windowed categories get a window picker** (7 / 30 / 90 / 365 days), a fixed
  set rather than a number box — the service clamps to 1–365 anyway, and a board
  over a window nobody else picked is a board nobody can compare against.
- **Ranks are shown in proportion** — "3 / 42", never a bare "3rd". A third
  place on a board of four is not an achievement, and rendering it as one is a
  claim the data does not support.
- **The reader's own row is pinned** above the table when it falls outside the
  shown page, rather than requiring them to page to it. Pinned *above* rather
  than spliced in, because a 137 sitting between a 9 and a 10 reads as a bug.
- **Staleness is stated, worst-case.** The line under the board names the oldest
  reading on the page, not the newest — `SNAPSHOT` categories are up to a
  snapshot cycle behind, and reporting the freshest row would overstate the lot.
  Categories derived at read time say so instead.
- **Access: MEMBER** — the only page at that tier, because it holds nothing
  above what the guild already reads in Discord. **This does not currently widen
  reach**: gate one admits nobody below `PANEL_ACCESS_FLOOR` (`MODERATOR`), so
  in practice the same people reach it as reach everything else. The tier is
  declared honestly so the page is already correct the day the floor moves.

**The weekly digest.** The `leaderboard` channel slot is consumed by a
`leaderboard-post` worker job (Sundays, 18:23 local to the worker), which offers
every active guild a digest and lets the bridge refuse the ones with no slot
bound — binding it *is* how a guild opts in. Four boards (Level, Wealth,
Catacombs, Guild XP), top ten each, **posted fresh rather than edited**. That is
the opposite of the event tracker board and deliberately so: a tracker board is
one event's live state, so a second copy is a wrong copy, while a digest is a
record of where the guild stood on one Sunday and rewriting it destroys the only
reason to keep it. A board with nobody on it is left out rather than posted
empty, and if all four are empty nothing is posted at all.

### 3.14 Tickets
- **The queue first, then the menu.** The open tickets lead because they are the part with a clock on them: a ticket nobody answered is a member waiting, while a ticket type nobody edited is fine. Each row carries its subject, category, opener, assignee and age, plus a closing note and a `ticket.close` button. What a member *wrote* in one still stays in the bot, where the people in it are — this page offers closing it, not reading it.
- **The menu and the panel** are the rest: what a member may open with `/ticket` and the embed that advertises it.
- **Ticket types** layer exactly like milestone definitions: five built-ins (`support`, `report`, `appeal`, `application`, `other` — the same five values the old fixed `category:` option offered) are listed with `source: "DEFAULT"`, a guild's stored row shadows the built-in with the same key, and a key the built-ins don't know is that guild's own type, sorted in by position. A guild that configures nothing stores nothing, and a built-in added in a later release reaches every guild.
- **Per type:** offered or not, the name a member sees, the prompt they are asked when they open one, the category channel it opens under, the staff role ids pulled in (deduped on save, so nobody is pinged twice), the menu position, and which fixed `TicketCategory` it is filed under for reporting.
- **The key is typed, not derived from the name.** It is what a member passes to `/ticket type:` and what a guild row joins on; a key that moved when somebody reworded the name would break saved commands and shadow nothing.
- **Turning every type off closes ticketing** without touching the history — `/ticket` then says so rather than opening one under a category nobody watches. The command reads this same resolved list, so a member can never open a type the editor says is switched off.
- **The panel** holds its channel, title and description. Where it was last posted is recorded server-side, not typed here — moving it to another channel is a re-post, and changing the channel clears the stored message id so a later edit doesn't update a message in a channel the admin moved away from.
- **Access:** Moderator+ for the page and the queue, because closing a ticket is Moderator work. **Admin+ for the configuration below it** — a type names the staff roles it pulls in and the category channel it opens under, which is role and channel configuration. The view model carries that decision per load (`canConfigure`) rather than the whole page sitting at the higher tier, which would shut the people who answer tickets out of the queue.

### 3.15 Filter — *now a section of §3.6, not a page*

**There is no Filter nav entry.** The content below is unchanged and still renders — `pages/wordlist.ts` exports `filterCards`, which the Moderation page draws as its Filter tab — but it no longer has a route of its own, because the automod rules next to it read this same wordlist. A stale `#/…/wordlist` link falls through to the guild's front page like any other unknown page id. The `wordlist` **read route** on the JSON API is deliberately kept (§0): dropping it would break anything driving the API directly.

- **Two things that act on members with nobody in the loop.** The chat filter's rules fire at relay time, and the escalation ladder mutes or bans off a warning count. Both are configuration rather than a record of what somebody did, which is what separates this page from Moderation next door.
- **The rules are shown in full, patterns included** — that is the point of the page. It is not what sets the tier: `/wordlist` in the admin bot already lists the same patterns to Staff, and a filter nobody who moderates can read is a filter nobody can maintain.
- **The audit trail records which rule changed, to what, and by whom — never the pattern.** A trail that reproduced every entry would be a second copy of exactly the thing nobody wanted written down. `patternLength` is recorded instead, which is enough to tell an edit from a rewrite.
- **Every control saves the whole rule**, because the mutation validates the *result*: changing only the match type can turn a legal substring into an invalid regex, or into a collision with a rule three rows down, and neither is visible from the changed field alone. A rule keeps its id across an edit — remove-and-re-add would reorder the list under whoever was reading it and orphan the rule id in an older bridge log line.
- **A rule may be switched off rather than deleted.** Off keeps the row and stops it matching; delete is the irreversible one.
- **The note a `/wordlist-add` carried is left alone.** It is not on `WordlistRuleDTO`, so this page has never seen it — an omitted `note` means "leave it", and only an explicit `null` clears it. The alternative would have every panel edit quietly delete what a staffer typed in Discord.
- **The ladder is displayed as it is in force**, built-ins included (ADMIN_BOT.md §5.1). There is nothing stored until the first save, so a row-by-row editor would have to pretend otherwise; saving writes the ladder exactly as shown, which turns the built-ins on display into that guild's own. A mute rung with no duration is refused here rather than dropped on the way back in — `parseEscalationPolicy` would discard it silently, leaving an admin with a step that never fires.
- **Rules and ladder are independent.** Escalation runs off the moderation service, which every deployment has, so a deployment without the chat filter still gets the ladder editor.
- **In-game punishment sync** sits below the ladder as a third card. One row per Discord action (`WARN`, `MUTE`, `UNMUTE`, `KICK`, `BAN`, `UNBAN`), each naming the guild command it should type — and the choice is a closed list (`none`, `g mute`, `g unmute`, `g kick`), never free text, because the field ends up as characters typed by an account holding guild-officer permissions. Duration is either the Discord action's own (`same`) or a fixed length; a fixed `g mute` with no length is refused rather than stored as a mute that never fires. See BRIDGE_BOT.md §6B for what happens to the command after it leaves here.
- **The card states its two limits rather than hiding them.** A member with no linked account cannot be punished in-game, because the bridge has no name to type; and the reverse direction — in-game staff actions appearing in this history — is best-effort, since Hypixel does not print a line for every event and prints none at all while the bridge is disconnected.
- **`moderation.relay-sync` is Admin+**, one tier above the actions it mirrors. Issuing a mute is Moderator work; deciding that every mute also removes somebody from the guild is configuration.
- **Access:** Admin+, and deliberately one tier above the bot's own `/wordlist-add` and `/wordlist-remove`, which are Officer. The asymmetry is the ladder: an officer adding one rule is a bounded act with an audit line behind it, while this page hands over the rungs that mute and ban on a count, and that is guild configuration in the same sense as ticket types and role mapping. An officer who needs to add a rule mid-incident still has the command.

### 3.16 Permissions — who is staff, and what staff means

Its own page under **Configure**, not a Settings card: it edits four independent
dimensions plus an exception table, and a guild's whole permission model is the
one piece of configuration that has to be readable in a single sitting.

- **Levels.** Each platform role (`MEMBER` … `OWNER`) takes a *set* of Discord
  role ids, through the multi-picker. A set rather than one id because guilds
  reach the same authority by more than one route — `@Officer` and `@Staff Lead`
  are both officers — and expressing that with one slot per level meant either a
  second nav-level concept or a lie. The whole set is posted per save; an
  add-and-remove protocol would leave a half-applied binding behind if the
  second call failed.
- **In-game ranks.** Hypixel guild ranks map to levels, so promoting somebody in
  game promotes them here on the next roster scan. Rank names are guild-authored
  free text, so they are stored trimmed and lower-cased and matched that way.
- **Bridge capabilities.** One floor per `BridgeCapability`, shown beside the
  platform default. Only floors that *differ* from the default are stored — a
  guild that saves a rank mapping must not thereby freeze today's capability
  defaults into its own document, or a later platform change would skip every
  guild that had ever opened the page.
- **Command access.** One row per command in the admin bot's registry, read
  through a structural port that the composition root fills from
  `buildAdminRegistry()` — panel-core does not import the command package. The
  page shows the handler's own floor and whether this guild has overridden it;
  clearing an override stores *nothing* rather than pinning today's default, for
  the same reason as above.
- **Exceptions.** Per-subject grants and denies (`BridgePermission`), for a
  Discord user, a Discord role or an in-game rank. `allow: false` is not the
  same as no row: a deny beats every grant and every floor, so it is asked for
  explicitly rather than arrived at by clearing something. Resolution order is
  **deny → grant → role floor** (§4.1 of ONBOARDING.md).
- **Two absences are told apart.** `commandsAvailable` and
  `exceptionsAvailable` distinguish "this deployment has no such store" from
  "nothing is configured" — the page says which, and never renders an empty list
  for the first.
- **Six mutations, not one.** The page edits four stores and one of them has a
  delete; batching them behind one action name would make a failed rank mapping
  look like a failed capability floor.
- **Access:** Admin+ for every one of them, including the read. At any lower
  tier `roles.binding` alone would let an officer bind their own Discord role to
  ADMIN and reach the whole panel, and `roles.exception` would let them grant
  themselves a capability directly.

---

### 3.17 Roles & Welcome

The auto-role policy, the greeter and the self-service role menus, under
**Configure**. An auto-role policy is a write into somebody else's Discord
server across their whole roster, so the page leads with the two things worth
knowing before saving one and puts the editor underneath.

**Health card, first.** Whether SBR Admin can manage roles at all, how many
members are waiting in the dirty set, when `role-sync` last ran, and **every
rule the preflight refused, with its reason**. Until this card existed a role we
could not apply failed silently: the sync reported success, the member never got
the role, and the only trace was a line in a worker log no member of staff
reads. Refusals can be cleared once addressed (`roles.refusals.clear`).

**Dry run, before saving.** "This would grant 214 and revoke 3", computed by the
reconciler's own resolver over real open-grant rows — not a second estimate that
could disagree with what actually happens. A deployment with no roster to look
at **refuses** rather than reporting zeroes.

**Rule editor.** One card per rule (label, trigger, role, revoke-when-unqualified,
enabled) plus an add card. The trigger dropdown repaints without saving, so
somebody can pick "They hold a guild rank" before knowing which rank. Roles come
from the shared picker and anything the preflight would refuse is not offered.

**Welcome editor.** Three cards — join, leave, in-game guild join — each with a
channel slot, the template, and for the join message a DM and an optional
delete-after. It previews as it is typed through a browser copy of the greeter's
renderer that `welcome-preview.test.ts` holds character-for-character against
the real one: a preview that renders differently from the greeter is a wrong
answer given confidently at the one moment somebody is checking their work.

**Role menus.** A card per menu with its options, plus an add card;
`roles.menu.publish` asks SBR Bot to post it. Editing here and posting from
`/rolemenu` are the same document.

**Every control posts the whole policy**, because the mutation stores the whole
policy — merging a rule list on the server would make "I deleted that rule" and
"I never had that rule" indistinguishable.

**Mutations:** `roles.auto.save`, `roles.preview`, `roles.welcome.save`,
`roles.refusals.clear`, `roles.menus.save`, `roles.menu.publish`.

**Access: Admin+, including the read** — the same tier as §3.16 and for the same
reason. A role grant is authority, and a page that can bind a Discord role to a
rule can bind one to the person editing it. The dry run goes through the write
channel even though it writes nothing: it needs the same authorization and the
same body a save would take, and answering "what would this do" from the read
side would be a second way to send a policy.

Stickies (`/sticky`) have **no panel surface**; they are managed from Discord.

---

## 4. Data Sources per Page

| Page | Reads from | Writes to |
|------|-----------|-----------|
| Login/Logout | `identity` (Discord OAuth), Redis session | Redis session |
| Guild Selector | Discord guilds + DB `Guild`, bot presence | Session (active guild) |
| Overview | DB summaries + `analytics`; `GuildMember`/`GuildMemberCache`/`GuildScan` (membership), `ModerationAction`+`GuildJoinScreening`+`Milestone`+`Event`+`GuildScan` (activity), `GuildJoinScreening` (join attempts) | — |
| Settings | `config` (DB+cache) + live Discord roles/channels (bot) + `xp` (`XpSourceConfig`) + `GuildSetting['screening.policy']` | `config` → DB + cache invalidation + pub/sub; `xp` → `XpSourceConfig`, `XpEvent` (adjustments) + audit |
| Analytics | `analytics` (aggregated `CommandUsage`, bridge/mod events) | — (CSV export) |
| Moderation | DB (`Infraction`,`ModerationAction`) + Redis enforcement + `wordlist` + `GuildSetting['moderation.automod'\|'moderation.escalation'\|'moderation.relay-sync'\|'config.cooldowns']` | `moderation` → DB + Redis + analytics; `WordlistEntry`, `GuildSetting` + audit |
| Events | DB (`Event`,`EventRSVP`) | DB + Discord (announce) + workers (reminders) |
| Members | DB (`GuildMember`+`DiscordUser` from `discord-member-sync`, `GuildMemberCache` from `guild-scan`, joined via `LinkedAccount`) | DB (role, unlink) |
| Health | `WorkerJobLog` + live BullMQ + bot heartbeats + `rl:hypixel` | Requeue/force-sync (workers) |
| Milestones | `milestones` (`MilestoneDefinition` layered over built-in defaults, plus `countHolders` grouping `Milestone` rows) | `MilestoneDefinition` + audit |
| Leaderboard | `leaderboards` (`LeaderboardService` over `leaderboardSource`: `ProfileSnapshot`, `GuildMember.joinedAt`, `ActivityDaily`, `XpBalance`, `GuildGexpDaily`) | — |
| Tickets | DB (`Ticket`, open queue) + `tickets` (`TicketTypeConfig` layered over built-in defaults, `TicketPanelConfig`) | `ticket.close`; `TicketTypeConfig`, `TicketPanelConfig` + audit |
| Filter | `wordlist` (`WordlistEntry`) + `GuildSetting['moderation.escalation']` and `['moderation.relay-sync']` layered over built-in defaults | `WordlistEntry`, `GuildSetting` + audit |
| Roles & Welcome | `GuildSetting['roles.auto'|'discord.welcome'|'roles.menus']`, `RoleGrant` (open grants, for the dry run), admin-bot role preflight + refusal log | `GuildSetting` + audit; bridge internal API (post a menu) |
| Permissions | `GuildConfig.roleMappings` (level → Discord role ids), `GuildSetting['roles.policy']` (rank map, capability floors, command overrides) layered over platform defaults, `BridgePermission` (exceptions), admin-bot command registry (metadata only) | `GuildConfig.roleMappings`, `GuildSetting['roles.policy']`, `BridgePermission` + audit |

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
2. **Guild visibility = (Discord `MANAGE_GUILD` ∩ platform `Guild` record) ∪ (platform role ≥ `MODERATOR`)**, resolved at login and re-checked on entry. Full write-up in `docs/PANEL_SECURITY.md`.
3. **Every guild-scoped action authorized server-side** against `GuildMember.role`; UI gating is cosmetic only.
4. **Role tiers:** Staff (mod/tickets/read analytics) < Officer (events/bridge/unlink) < Admin/Owner (settings — config, mapping, flags, screening, XP — plus health/milestones/ticket config/chat filter + escalation). Officer gates mutations only; no whole page turns on it since Recruitment went away (§3.7). Note the split: working a ticket is Staff, but *configuring which tickets exist* is Admin, because a type names roles and channels. The filter sits at the same tier for the same kind of reason: a rule blocks or shadow-mutes at relay time and a ladder rung mutes or bans off a count, both with nobody in the loop.
5. **Rank hierarchy** enforced on actions targeting people.
6. **Bot-gated configuration** — anything the bot must enforce is disabled (with explanation) when the bot is missing or under-permissioned.
7. **All writes audited** and rate-limited; **all writes go through shared domain services**, never around them.
