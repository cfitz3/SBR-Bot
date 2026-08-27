# Bridge / Skyblock Bot — SBR Guild Platform

Design for `apps/bridge-bot` — the member-facing surface that bridges Discord ↔ in-game guild chat, answers in-game and slash commands, and drives group-finding, events, milestones, and news. The app is a **thin shell**: two transports (Discord gateway + Mineflayer in-game connector) wired to shared domain logic in `packages/bridge`, `progression`, `pricing`, `community`, `hypixel`. All relay rules, formatting, and permissions live in `packages/bridge`; the app only owns the sockets and lifecycle.

**Design anchors**
- One relay brain (`packages/bridge`), two dumb transports.
- Every inbound/outbound message passes filter → permission → format → rate-limit before delivery.
- The in-game bridge (Mineflayer) is the **fragile, ban-risk** dependency; the bot degrades gracefully when it's down and never loses Discord functionality with it.
- Cross-instance fan-out via Redis pub/sub (`chan:bridge:{guildId}`), so multiple bot instances stay consistent.

---

## 1. Feature Specification

| # | Feature | Summary |
|---|---------|---------|
| F1 | **Discord → guild chat relay** | Messages in the mapped bridge channel are formatted and sent to in-game guild chat. |
| F2 | **Guild chat → Discord relay** | In-game guild/officer chat is parsed and posted to the mapped Discord channel(s) via webhook. |
| F3 | **Relay formatting** | Consistent display-name formatting both directions (Discord member name ↔ IGN + guild rank), mention/emoji handling, colour stripping. |
| F4 | **Role-gated speaking** | `BridgePermission` decides who may relay, run commands, mention, or bypass filters/cooldowns. |
| F5 | **In-game command parsing** | Prefix commands typed in guild chat (`!stats`, `!nw`, …) parsed, executed via shared services, replies delivered back into guild chat (length-limited). |
| F6 | **Slash commands** | The full member command surface (see `COMMANDS.md`) on Discord. |
| F7 | **Group-finding (LFG) & runs** | Create/join/leave runs; live listings with TTL. |
| F8 | **Event signups** | RSVP to guild events, reminders, roster updates. |
| F9 | **Milestone/achievement announcements** | Auto-detected progression milestones announced to Discord (and optionally guild chat). |
| F10 | **Reminders & news** | Skyblock news, mayor/firesale/bingo notifications, and event reminders pushed to subscribers/channels. |
| F11 | **Anti-spam / flood control** | Per-user + global rate limiting, dedup, mute-aware relay. |
| F11b | **Automod** | One panel-configured policy enforced on Discord *and* guild chat (§6C). |
| F12 | **Bridge health & degradation** | Detects in-game disconnects, reconnects with backoff, and switches to a documented degraded mode. |
| F13 | **Live guild roster** | `/online` reads `/g online` through the in-game session and reports who's on, grouped by guild rank, with how long each member has been on. |
| F13b | **Playtime tracking** | Sessions opened on a bridge-observed join and closed on the leave, debounced so a lobby hop is one session, persisted as `PlaySession` rows. |
| F14 | **Join screening & auto-accept** | Every `/g join` request is screened against the scammer list, the applicant's stats and this guild's own history, recorded, reported to staff, and — if the guild opts in — accepted automatically. |
| F15 | **Greeting** | Welcome, farewell and guild-join messages, rendered from a guild-configured template and spoken by this bot because a member is addressed by the bot they interact with (§6D). |
| F16 | **Member conveniences** | `/userinfo`, `/serverinfo`, `/avatar`, `/remind` + `/reminders`, `/tag`, `/levelalerts`, plus level-up announcements, autoresponders and sticky messages (§6D). |
| F17 | **Self-service role menus** | The message, the buttons and the interaction handler are this bot's; the grant itself is an admin-bot effector call (§6D). |

---

## 2. Command Spec

The bot exposes two command channels; both route to the **same domain services** so behavior is identical.

### 2.1 Discord slash commands
Full member surface per `COMMANDS.md` §1–7 (`/link`, `/me`, `/stats`, `/networth`, `/price`, `/rsvp`, `/help`, …), less the ten retired there. Permission via `packages/identity` + `BridgePermission`. Personal/admin output ephemeral; shareable lookups public.

### 2.2 In-game commands (guild chat)
Prefix commands (prefix + enabled set from `GuildConfig`). **Read-only / low-risk subset only** — never moderation, linking secrets, or config.

| In-game | Maps to | Perm | Data |
|---------|---------|------|------|
| `!stats <ign?>` `!skills` `!slayer` `!dungeons` `!nw` | `/stats`…`/networth` | `RUN_COMMAND` | Cache→Live |
| `!price <item>` `!bz <item>` `!lbin <item>` | market lookups | `RUN_COMMAND` | Cache (worker) |
| `!weight <ign?>` | Senither/farming weight | `RUN_COMMAND` | Cache→Live |
| `!help` | condensed catalog | Public | Static |
| `!8ball` `!roll` `!coinflip` `!rps` `!guildquote` `!rank` `!cringe` | fun (`COMMANDS.md` §20) | Public | None (Redis counter for `!cringe`) |

**The fun commands never echo what somebody typed**, which is a bridge concern
rather than a taste one: this bot speaks with the guild's voice in guild chat, so
a command that repeats arbitrary text is a way to make the guild say anything
through a path the relay's chat filter was never asked about. `!guildquote` is
the one command that says stored text, and it is screened through the *same*
`WordlistFilterImpl` instance the relay uses — one cache, one set of rules, no
chance of the two drifting apart.

**In-game constraints:** single-line ~256-char replies (embeds collapse to one-liners), stricter per-IGN cooldowns (`cd:ingame:*`), identity resolved by IGN → `LinkedAccount`. Unknown command → short usage hint; unauthorized → one-line refusal; errors never dump traces to chat.

**Example one-line collapse:**
```
!nw Steve →  Steve (Mango): NW ≈ 8.2b (est, some data hidden) | SnrW 12,340 | Cata 42
```

---

## 3. Message Relay Behavior

### 3.1 Pipeline (both directions)
Every message runs the same ordered pipeline in `packages/bridge`:

```
inbound msg → 1 identify (map author to member/IGN)
            → 2 permission check (BridgePermission: may relay?)
            → 3 mute/suspend check (bridge suspended? author muted?)
            → 4 content filter (wordlist: BLOCK/FLAG/REPLACE/SHADOW_MUTE)
            → 4b automod (the guild's own rules — see §6C)
            → 5 anti-spam/flood (rate + dedup)
            → 6 format (display name, mentions, emojis, truncation)
            → 7 deliver (Discord webhook  or  in-game /gc)
            → 8 log (CommandUsage/relay metric, analytics)
```
Any stage may drop the message (with a reason logged); only messages passing all stages are delivered.

### 3.2 Formatting rules
- **Discord → in-game:** `[DisplayName]: message`. Resolve Discord display name (server nick > global name). Strip Discord markdown, custom emojis → `:name:` text, resolve user/channel/role mentions to readable text. Enforce Minecraft charset + length; split or truncate long messages with `…`. Block anything Hypixel would reject (disallowed chars, ad patterns).
- **In-game → Discord:** delivered via **webhook** so each message shows the player's **IGN as username + avatar** (Crafatar/Mojang head). Prefix guild **rank** (`[MVP+] IGN [GuildRank]`). Officer chat routes to the staff channel if mapped. Hypixel colour codes (`§x`) stripped; system/join/leave lines styled distinctly (see F9/events).
- **Names never spoofed:** relayed Discord users are clearly marked as coming from Discord (e.g. a `‹D›` tag or the bot's webhook), so in-game players can tell a bridged message from a real in-game one.

### 3.2.1 Echo suppression (self-authored guild chat)

Hypixel reflects the bridge account's own guild chat back to it, so every line
the bot sends with `/gc` arrives moments later as an ordinary
`Guild > BotIGN [rank]: …` message — indistinguishable from a player's, because
it *is* the same chat. Relayed naively that put every Discord message in the
channel twice: once from its author and once from the bridge wearing the bot's
name.

The rule is therefore **self-authored guild chat is not relayed to Discord**,
identified by comparing the speaking IGN against the session's own
(`bot.username` — the configured `MC_USERNAME` is an email under Microsoft auth
and never matches what Hypixel prints).

That rule alone would also swallow the one piece of bot output Discord genuinely
wants: the answer to an in-game `!command`, which Discord watched get asked but
would never see answered. So outbound lines can be registered on a short-lived
**echo ledger** (`packages/bridge/echo.ts`) before they are sent, and their echo
is claimed once on arrival and relayed. In-game command answers register;
Discord→game relays do not.

Matching is on the text Hypixel will display — colour codes stripped, whitespace
collapsed — and a miss fails *closed*: an unclaimed echo is dropped. A missed
match therefore costs one answer in Discord rather than reintroducing the
duplicate, which is the cheaper of the two failures by a wide margin.

### 3.3 Role-gated speaking
- Default: **membership of the in-game guild** is what buys a seat in guild chat. Being in the Discord server is not enough, and neither is `RELAY_MESSAGE` on its own — see the Discord→game rule below for why.
- `RUN_COMMAND`, `MENTION`, `BYPASS_FILTER`, `BYPASS_COOLDOWN` are separate capabilities granted per Discord role / guild rank via `BridgePermission`.
- **The two directions are asked different questions**, because they are not symmetric requests. Game→Discord asks *"may this line be repeated?"*; Discord→game asks *"may this person write into our guild chat?"*, which is a much stronger thing to grant.
  - *Discord → game*, in order: a **deny** row refuses outright; an explicit **allow** row (`RELAY_MESSAGE` or `ADMIN`) permits — this is the escape hatch for a guest or an ally's officer; **staff** (`MODERATOR` and up, read from the stored role *or* from a mapped Discord role the gateway can see right now) may speak without playing; otherwise the author must hold a **verified link to somebody on the in-game roster** (`GuildMemberCache`). Any verified link counts, not just the primary one — an alt on the roster is the same human, and Hypixel would let them talk.
  - *Game → Discord*: the author is an IGN, which is not a snowflake and resolves to no member, no grants and no role. An **unlinked** player is therefore relayed on Hypixel's authority — guild chat is itself the credential, since Hypixel already decided who may write in it. A **linked** player is resolved to their Discord id first, so their platform permissions (and any deny) follow them into guild chat.
- **Before the first `guild-scan`** there is no roster to check against, so the older, permissive posture stands — the stored stack, or the gateway's word that the author is at least in the server — and the fallback is logged. A gate must never close because a *scan* has not happened; it closes by itself once the roster arrives.
- Linking is therefore a prerequisite for a plain member to speak **into** the game, and it remains what makes a punishment follow someone between the two surfaces.
- Because that makes `NO_PERMISSION` the ordinary answer for a guild member who has not linked yet, it is the **one drop reason the bridge explains**: a self-deleting reply pointing at `/link`, throttled to once per author per 30 minutes. Every other reason stays silent — a shadow-mute that announced itself would not be one, and a muted member already knows.
- With no `BridgePermission` rows written, capabilities fall back to a **`GuildMember.role` floor** so an unconfigured guild is still usable — `RELAY_MESSAGE`/`RUN_COMMAND` from `MEMBER` up, `MENTION` from `MODERATOR`, `BYPASS_COOLDOWN` from `OFFICER`, `BYPASS_FILTER`/`ADMIN` from `ADMIN`. A row still wins over the floor, and a deny row wins over everything (see `DOMAIN_MODEL.md` → BridgePermission). **This floor no longer decides Discord→game relay on its own**: `discord-member-sync` writes a `GuildMember` row for every account in the server and `GuildMember.role` defaults to `MEMBER`, which is exactly `RELAY_MESSAGE`'s floor — so joining the Discord cleared it. The floor still governs every other capability.
- The gate lives in `BridgeGuardImpl.canRelay` (`apps/bridge-bot/src/adapters.ts`) and has its own test file. It has been wrong three times — open to everyone, closed to everyone, then open to the whole Discord server — and all three failures were silent, so its database reads are injected rather than imported. The third was the subtlest: the capability check was not bypassed, it was *satisfied*, which is why no amount of fixing the permission stack reached it.

### 3.4 Announcements, reminders & news (F9–F10)
- **Milestones (F9):** the `profile-refresh` worker detects crossings (skill/cata/slayer/networth thresholds) and publishes an event; the bot announces to the configured channel (`🎉 Steve just hit Catacombs 45!`) and optionally to guild chat. Deduped via `Milestone.announced`.
- **News/mayor/firesale/bingo (F10):** global workers refresh caches and publish; the bot posts to subscribers (`/subscribe` categories) or the news channel. Deduped by event id so restarts don't repost.
- **Event reminders (F8):** workers enqueue reminders at offsets before `Event.startsAt`; the bot pings RSVP'd `GOING`/`MAYBE` members.

---

## 4. Anti-Spam / Flood Handling

Enforced in the pipeline (stage 5) with Redis counters, before anything reaches a transport.

| Control | Mechanism | Effect |
|---------|-----------|--------|
| **Per-user rate** | Token bucket `cd:relay:{surface}:{userId}` | Excess messages dropped/delayed; `BYPASS_COOLDOWN` exempt |
| **Global relay cap** | Guild-level bucket | Protects against Hypixel's own guild-chat rate limit; queues/sheds when hot |
| **Duplicate suppression** | Hash of (author+content) in a short Redis window | Identical repeats within N seconds dropped |
| **Command cooldowns** | `cd:{surface}:{command}:{user}` | Per-command spacing; stricter in-game |
| **Mention throttling** | Count mentions/msg; cap mass pings | Blocks `@everyone`/spam pings across the bridge |
| **Flood escalation** | Repeated violations raise an `Infraction` (SPAM) | Auto shadow-mute or staff alert on sustained abuse |
| **Content filter** | `WordlistEntry` compiled in Redis | BLOCK/FLAG/REPLACE/SHADOW_MUTE per rule |

- **Hypixel-side protection is first-class:** the global cap exists specifically so the bot never trips Hypixel's guild-chat spam limits (which would silence the bridge). When the outbound in-game queue backs up, low-priority relays are shed and users see a brief "chat busy" state rather than the bot getting muted in-game.
- **Mute-aware:** a member muted via `/mute` (cross-surface) has their bridge messages dropped for the mute duration (`mute:*` TTL), both directions.

---

## 5. Logging & Failure Handling

### 5.1 Logging
- **Relay metrics:** every relayed/blocked message logs direction, guild, latency, and drop-reason to analytics (buffered → `apps/workers` → Postgres).
- **Command usage:** `CommandUsage(surface=BRIDGE_BOT|INGAME)` per invocation.
- **Bridge health events:** connect/disconnect/reconnect, lobby/limbo transitions, Hypixel mutes/errors → published to Redis and surfaced on the panel Health page.
- **Structured logs** with correlation ids; no secrets/tokens logged; user content redacted per policy in operational logs.

### 5.2 Failure handling
- **Typed results everywhere:** command handlers consume `packages/hypixel` typed states (`NOT_LINKED`/`MISSING_PROFILE`/`API_DISABLED`/`STALE`/`RATE_LIMITED`) and render honest messages instead of throwing.
- **Delivery failures:** a failed in-game send is retried briefly with backoff; if the bridge is down it's routed to the degraded-mode queue (below). A failed Discord webhook send is retried, then dropped with a logged reason.
- **Isolation:** an exception in one message's pipeline never crashes the transport loop — errors are caught per-message, logged, and the loop continues.
- **Idempotency:** announcements/reminders keyed by entity id + type so retries/restarts don't double-post.
- **Backpressure:** if downstream (Hypixel API or in-game queue) is saturated, non-essential work sheds first (news/milestones defer; live command replies prioritized).

---

## 6. Behavior When the Minecraft Bridge Is Unavailable

The in-game connection (Mineflayer) is the fragile link — it can drop from Hypixel restarts, kicks, lobby/limbo issues, network faults, or (worst case) an account ban. The bot treats "in-game down" as a **first-class, expected state**, not an outage.

### 6.1 Detection & reconnection
- Heartbeat/keepalive on the Mineflayer session; missed beats or a kick/disconnect flips bridge status to `DEGRADED`.
- **Reconnect with exponential backoff + jitter**, capped; the bot tries to return to limbo and rejoin. Repeated auth failures (possible ban) stop auto-retry and **alert staff** rather than hammering login.
- Status transitions (`UP`→`RECONNECTING`→`DEGRADED`/`DOWN`) are published to Redis → visible on the Health panel and optionally announced to the staff channel.

### 6.2 Degraded-mode behavior
| Capability | When in-game bridge is DOWN |
|------------|-----------------------------|
| Discord slash commands (`/stats`, `/nw`, `/price`, …) | **Fully work** — they use the Hypixel API + cache, not the in-game connection |
| Discord → guild chat relay | **Paused**; messages **queued** (bounded, TTL) and flushed on reconnect, or dropped with a notice if the queue expires |
| Guild chat → Discord relay | Unavailable (no in-game feed); a status notice is posted once to the bridge channel |
| In-game `!commands` | Unavailable (no in-game input); N/A until reconnect |
| Cross-surface `/mute` | Discord timeout still applies; **guild-chat mute deferred** and applied on reconnect (logged as pending) |
| Milestones / news / reminders | Continue to Discord; guild-chat mirror suppressed until reconnect |

- **One clear signal, not spam:** the bot posts a single "bridge offline" status message (and updates it on recovery), rather than erroring on every attempted relay.
- **Queue, don't lose:** Discord→in-game messages are held in a bounded Redis queue with TTL; on reconnect they flush in order (respecting the global rate cap), and anything expired is reported as "not delivered."
- **No silent success:** users attempting to relay while down get a brief "guild chat is offline, message not sent (or queued)" acknowledgement.

---

## 6A. Join Screening & Auto-Accept (F14)

When somebody runs `/g join Skyblock and Relax`, Hypixel prints the request into
guild chat. The bridge reads that line and screens the applicant before anyone
has had to look at them.

### 6A.1 What happens, in order

1. **Parse.** `parseJoinEvent` reads `… has requested to join the Guild!` off
   the `messagestr` stream, tolerating rank tags, colour codes and the wording
   changes Hypixel has shipped before. `… joined the guild!` is a separate event.
   **One `messagestr` is not one line**: Hypixel sends the divider, the request
   and the "Click here" instruction as a single packet with embedded newlines, so
   the transport splits on `
` and hands each line over separately. Every
   pattern is also unanchored, which is defence in depth against a future
   framing — and is why guild *speech* (`Guild > Bob: … has requested …`) has to
   be refused explicitly, so no member can have anyone screened by typing it.
   The "Click here to accept" follow-up line is deliberately *not* a second
   request, and a 60-second dedupe collapses the reprints Hypixel sends to every
   member with the invite permission.
2. **Gather**, all concurrently:
   - **Scammer list** — SkyKings, by uuid *and* by the linked Discord id when we
     have one. The uuid asks "is this account listed"; the Discord id asks "is
     the person behind it listed", which still matches after a fresh alt.
   - **Stats** — Hypixel player, profile summary, networth and profiles, with
     SkyKings' tracker filling any gap Hypixel refused. Every field taken from
     the fallback is marked in the record.
   - **History** — this guild's own record: prior denials, prior kicks or bans,
     and how many times they have asked inside the repeat window.
3. **Evaluate** (`@sbr/screening`, a pure function). Hard refusals and holds are
   *reason-driven*; the risk score exists to rank the staff queue and to escalate
   a request that collected several small concerns. **The score never turns a
   REVIEW into an ACCEPT.**
4. **Record.** One `GuildJoinScreening` row per *attempt*, carrying the verdict,
   the risk score, the reasons and the applicant's stats as they were at that
   moment — which is also the metrics capture: an applicant has no
   `ProfileSnapshot` because they are not a member yet.
5. **Act.** On ACCEPT with `autoAccept` on, the bot queues `/guild accept <ign>`
   through the `CommandQueue`; on DENY it queues `/guild deny <ign>`. The row is
   marked **only if the queue took the command** — a backlog that dropped it
   leaves the request PENDING for staff rather than recording an accept that
   never happened. On REVIEW it does nothing and waits.
6. **Report.** A full report goes to the `staff` channel. Guild chat gets at most
   a neutral line.
7. **Decide, by hand, inside five minutes.** Anything left PENDING — which is
   everything, when `autoAccept` is off — is answered either from the Accept /
   Deny buttons on the staff report, or from Discord with `/join-queue`,
   `/join-accept` and `/join-deny` (see `ADMIN_BOT.md`). The slash commands
   publish a `GAME_COMMAND` over the mod bus for this bot to type; the buttons
   are handled in-process, since they are already running here. Because that bus
   is plain pub/sub with no store-and-forward, the admin bot checks the bridge's
   heartbeat for `mcSpawned` first and tells staff the command could not be sent
   rather than losing it silently.

   **The window is the whole design.** Hypixel honours `/g accept` for five
   minutes after the request and then forgets it, so three separate places are
   bounded rather than merely fast:

   - the screening gather runs under an 8s budget per port
     (`DEFAULT_SCREEN_BUDGET_MS`), and a slow third party is recorded as
     `timed out` on the row instead of holding the decision open;
   - join answers go through the command queue's **urgent lane** — they overtake
     the ordinary backlog and displace the newest ordinary command rather than
     being refused when it is full;
   - each carries `maxAgeMs = JOIN_WINDOW_MS`, so an answer that outlived the
     window is abandoned rather than typed against a row we already marked
     ACCEPTED.

   A row past its window is retired to `EXPIRED` by the queue read, and
   `/join-accept` on an expired or unseen-but-lapsed request sends
   `/guild invite` instead — reported as an invite, never as a quieter accept,
   because the applicant still has to accept it themselves. The measured
   `decisionMs` of every auto-accept is logged; if it creeps towards the window,
   the budget or the pacing is wrong.

### 6A.2 Rules that are not negotiable

- **An outage is never an approval.** A failed scammer check is `UNKNOWN`, not
  `CLEAR`; a thrown port is `UNKNOWN` with the error recorded; a policy source
  that fails falls back to defaults, which have `autoAccept: false`. There is no
  path where something breaking results in somebody being let in.
- **"Could not read" is never "failed the bar."** A hidden dungeon API yields
  `API_DISABLED` (a hold), never `BELOW_CATACOMBS` (a claim about the player).
- **Nobody is publicly accused.** The guild-chat line names no database and
  quotes no threshold. SkyKings is a third-party list, a wrong flag is possible,
  and being called a scammer in front of a hundred players cannot be taken back.
  Detail goes to the staff channel only.
- **Defaults are safe rather than useful.** Out of the box screening records and
  reports but admits nobody. `autoAccept` is opt-in, and the honest rollout is to
  run report-only for a week and read what it *would* have done.

### 6A.3 Configuration

The policy lives in `GuildSetting` under **`screening.policy`**, edited on the
panel's **Settings → Join screening** card (`config.screening`, ADMIN tier).
Nothing about it is in `.env`: a requirement bar is exactly the kind of thing
staff change on a Friday night without wanting a redeploy.

| Field | Meaning |
|---|---|
| `enabled` | Off means the bot still records every request but decides nothing. |
| `autoAccept` | Whether an ACCEPT verdict actually sends `/guild accept`. Requires `enabled`. |
| `denyOnScammer` | A listed scammer is refused outright rather than queued. |
| `reviewOnScammerUnknown` | An unreachable list holds the request for a human. |
| `denyOnPriorExpulsion` | A previous kick or ban from this guild is refused outright. |
| `reviewOnUnreadable` | An account whose stats we cannot read holds for a human. |
| `repeatWindowDays`, `maxAttemptsInWindow` | How far back repeat attempts count, and how many are tolerated. |
| `reviewAtRisk` | Risk score (0–100) at or above which an otherwise-passing request still waits for a human. |

**There are no stat requirements, by design.** `minSkyblockLevel`,
`minSkillAverage`, `minCatacombs`, `minSenitherWeight`, `minNetworth`,
`minAccountAgeDays` and `maxInactiveDays` were fields here and are gone. The scam
check is the guild's only entry requirement: a stat bar had become a hold nobody
wanted and an accusation the applicant could not answer. Every one of those
numbers is still read from Hypixel and still recorded on `GuildJoinScreening`, so
the staff card shows the whole account — screening reports it rather than grading
it.

The read path (`parsePolicy`) is deliberately **tolerant** — a malformed or
years-old field degrades to its default rather than taking screening offline. The
write path (`config.screening`) is deliberately **strict**, and rejects unknown
keys: a mistyped switch accepted silently would read back as its default and look
identical to a working setting. The one exception is the retired bars above,
which are accepted and discarded: a panel tab opened before they were removed
still posts them, and answering "unknown field" there would read as a bug rather
than as a setting that no longer exists.

`SKYKINGS_API_KEY` is the one `.env` value this feature needs — a credential, not
a behaviour switch. Without it the scammer check returns `UNKNOWN` and, by
default, every request holds for a human. The key travels in the `Authorization`
header and never in a query string, because query strings end up in proxy logs.

**The scammer lookup route is not deployed upstream (re-verified 2026-08-13).**
`GET /user/lookup`, the only endpoint that answers the scammer question, replies
`{"error":"Endpoint not found"}` with a 404 to every caller — including for the
sample identifiers in SkyKings' own documentation, so it is not our uuid
formatting.

The decisive evidence is the **anonymous** request. SkyKings mounts its API-key
middleware per route, which makes an unauthenticated call a probe of the router
itself:

| Request | Answer | What it proves |
|---|---|---|
| `/user/info`, no key | `401 API key required` | The route exists; auth ran and refused. |
| `/user/lookup`, no key | `404 Endpoint not found` | The router found nothing to run auth for. |
| `/user/lookup`, our key | `404 Endpoint not found` | Same 404, reached the same way. |

A route that was never mounted cannot be reached by any credential, scope, header
form, method or path variant we send, so there is no request we could make that
would work. `/health`, `/user/info` and `/leaderboard/*` all answer normally on
the same key at the same moment — the API is up, this one route is absent.
SkyKings has to bring it back; support is a Discord ticket, linked from
<https://skykings.net/api>.

**`npm run skykings:probe`** re-runs exactly this test set and prints the verdict.
It exits 0 the day the lookup answers, so it works as a cron canary rather than
something somebody has to remember to check. When it goes green, delete this
section and the matching note in `packages/skykings/src/client.ts` — no code
changes, the reader and the cache TTLs are already correct.

What the platform does meanwhile, all of it already the designed behaviour:

- The verdict is `UNKNOWN` with the cause **`ENDPOINT_MISSING`** — its own cause,
  so a report reads "the endpoint is gone" rather than implying a blip that will
  clear itself. It is never `CLEAR`; §6A.2's first rule holds.
- With `reviewOnScammerUnknown` on (the default) every applicant holds for a
  human, which is the correct posture while the list is unreachable.
- The client **parks a route that 404s for five minutes** (`ROUTE_GONE_TTL_MS`)
  and answers from that, so an outage of this shape costs one request rather than
  one per applicant inside the screening path. Parking is per route: the tracker
  reads on `/leaderboard/user` keep working throughout.

---

## 6B. Moderation Commands (the enforcement bus)

The bridge account is the only process on the platform that can type in the
Hypixel guild, so it is also the only one that can carry a punishment there. It
does not decide anything: the moderation service resolves the mapping (see
WEB_PANEL.md's "In-game punishment sync") and publishes a finished command line
on `chan:mod:{guildId}`; the bridge subscribes and types it.

**The guild is checked before anything is typed.** One Redis backs every guild
on the platform, and this account has officer permissions in exactly one of
them. A command whose `guildId` is not this bridge's resolved guild is refused
and logged — including when the guild is still unresolved, which is the same
posture the relay already takes when the server is not registered.

**Commands are paced, and the queue forgets.** `CommandQueue` sends one line at
a time with at least 1.2 s between them, holds at most 50, and abandons anything
that has waited more than 10 minutes for a session:

- *Pacing* protects the account from Hypixel's per-account command limit. This
  is the same risk that puts `/g online` behind a 20 s cache, except the caller
  here is a panel operator who could issue a hundred bans in a loop.
- *Overflow drops the newest.* A full queue is a backlog of the punishments
  staff issued first; dropping those to make room for later ones would silently
  reorder enforcement. The drop is logged rather than inferred.
- *Ageing* is why a session outage does not become a surprise. Without it the
  queue would hold a mute overnight and deliver it at breakfast, against a
  punishment that expired hours earlier.

An unlinked member cannot be matched to an IGN, so nothing is published for
them; they are punished on Discord and nowhere else, and the audit row says so.

### The reverse direction is best-effort, and labelled

`mod-notice.ts` parses Hypixel's own guild-chat announcements — kicks, mutes,
unmutes — and records them as `ModerationAction` rows with
`sourceContext: INGAME`, so an action taken in-game appears in the same history
as one taken from the panel.

This is deliberately incomplete, and the panel says so rather than implying
parity:

- Hypixel emits a line for some moderation events and not others.
- The wording is not versioned and can change without notice.
- A line is only seen while the bridge is connected; anything done during a
  disconnect is not seen at all.

Rows written this way are recorded as **inactive**: an in-game mute is not
enforced by us and we cannot lift it, so marking it live would make the expiry
sweeper believe it owned something it cannot touch. Where Hypixel names nobody,
the actor is the `ingame` sentinel rather than a guessed snowflake, and the IGNs
of both parties are preserved in the reason.

Recording goes straight to the repository, not through `ModerationService`: the
service *issues* punishments, and issuing one here would relay it back into the
game the notice came from — a kick echoing into a second kick.

---

## 6C. Automod (F11b)

Automod is one policy, configured once in the panel (`GuildSetting["moderation.automod"]`),
enforced on **both** surfaces the guild actually talks on. The point of it living
here rather than in a Discord-only bot is that a guild's rules do not stop at the
Discord server boundary: a link-advertiser is an advertiser in guild chat too.

### The two enforcement points

| Surface | Where | Sees |
|---|---|---|
| `DISCORD` | `Events.MessageCreate` in `transport.ts`, before the relay branch | **every** message in the Discord server, not just the bridge channel |
| `GUILD_CHAT` | pipeline stage 4b, via the `AutomodGate` port | every line coming out of the game |

The relay gate judges **only** `GAME_TO_DISCORD`. A Discord-authored message
already passed the `MessageCreate` hook on its way in; judging it again here
would double-count its spam window and could punish it twice for one sentence.

Guild-chat lines are judged on the **unfiltered** text. By stage 4b a `REPLACE`
wordlist rule has already starred the message out, and an automod rule reading
the stars would be reading our own edit rather than what was said.

### The split, and why

`packages/moderation/src/automod.ts` is **pure**: policy in, decision out, no
I/O. `automod-runner.ts` is the impure half that reads the policy, the wordlist
and the Redis counters and then calls the enforcement. That line exists so the
panel's "Test a message" box can run the *real* evaluator against operator text
rather than an approximation — a test harness that drifted from production would
manufacture confidence rather than provide it.

### It issues nothing itself

A `WARN` or `MUTE` verdict is handed to `ModerationServiceImpl.applyAction`, the
same entry point a moderator's `/warn` uses. Escalation, the audit trail and the
§6B in-game sync therefore all apply, and automod needs to know about none of
them. `FLAG` records the match and takes no action; `deleteMessage` is a separate
flag rather than an action type, so "delete and say nothing" and "warn but leave
it up" are both expressible.

### It fails open, everywhere

If the policy will not parse, the counter store is unreachable or the evaluation
throws, the message is **delivered** and the failure is logged. Redis being down
must not turn into a guild muting itself. For the same reason an unreadable
counter counts as zero, never as a match.

A member with no linked Discord account cannot be punished by the guild-chat
side — there is no account to act on — so the runner logs the refusal and stops
rather than inventing a target.

## 6D. The Discord QoL layer (F15–F17)

Full operator guide: [`DISCORD_QOL.md`](DISCORD_QOL.md). What matters here is
which of it runs inside this process, and on what schedule.

**Subscribers.**

- **Greeter** — subscribes to the Redis member bus (`chan:member:<guildId>`),
  which the admin bot publishes to from `GuildMemberAdd` / `GuildMemberRemove`.
  Observing is automated work and needs the `GuildMembers` intent, so it happens
  over there; the talking happens here. The renderer interpolates a closed token
  set and never executes, `@everyone` is neutered in the renderer *as well as*
  by `allowedMentions`, and the DM is sent independently of the channel post so
  one member's closed DMs cannot cost the server its welcome.
- **Config bus** — invalidates the cached sticky document and guild config when
  the panel or the admin bot writes.

**Sweepers**, all in-process, all bounded per pass so a cold start after an
outage cannot become a flood:

| Sweeper | Every | Batch | Notes |
| --- | --- | --- | --- |
| Level-up announcer | 5 min | 25 | Drains what the XP rebuild recorded into the `levels` channel; an opted-out row is marked announced without being posted, so the queue cannot grow forever with messages nobody will receive |
| Reminder sweeper | 1 min | 25 | Delivers, *then* flips `delivered`, so a crash mid-post repeats rather than loses; gives up 24 h past due |
| Sticky keeper | on message | — | Posts before it deletes, and leaves a channel alone for 15 s after a repost — checked before any settings read |
| Autoresponder | on message | — | Skips anything over 500 characters before reading anything; one answer per tag per channel per minute |

**Message-path cost is the design constraint.** Every hop above runs on
`messageCreate`, so each one checks its cheapest condition first and each holds
a per-guild cache with a one-minute TTL that falls back to the last good
document when a read fails — a database blip must not silently stop every
sticky and tag in the fleet. Bot-authored messages are skipped, so nothing here
can react to its own output.

**Role menus** are posted here on request from `/rolemenu` (admin bot) or the
panel, over this bot's loopback internal API. The button interaction is handled
here and the grant itself is an admin-bot effector call — the same split ticket
actions already use, and the reason a menu can never offer a role the preflight
would refuse.

---

## 7. Example Message Flows

### 7.1 Discord → in-game relay (happy path)
```
Discord #guild-bridge:  Aria: gg everyone, cata 40!
  → identify: Aria → linked to Aria_MC, who is on the in-game roster ✓
       (no deny row, no explicit grant, not staff — so the roster is what
        answers. A server member with no roster link stops here — see §3.3)
  → not suspended, not muted ✓
  → wordlist: clean ✓
  → anti-spam: under rate ✓
  → format: "[Aria] gg everyone, cata 40!"  (markdown stripped, length ok)
  → deliver in-game: /gc [Aria] gg everyone, cata 40!
In-game guild chat:  Guild > [BOT] [Aria] gg everyone, cata 40!
```

### 7.2 In-game → Discord relay
```
In-game guild chat:  Guild > [MVP+] Steve [Officer]: anyone for f7 carry?
  → parse: IGN Steve, rank Officer
  → format: webhook username "[MVP+] Steve [Officer]", avatar = Steve's head
  → deliver: Discord webhook → #guild-bridge
Discord #guild-bridge:  (Steve avatar) [MVP+] Steve [Officer]  ·  anyone for f7 carry?
```

### 7.3 In-game command
```
In-game guild chat:  Guild > Steve: !nw Aria
  → RUN_COMMAND ✓, cd:ingame ok
  → progression + skyhelper-networth on cached profile (STALE-aware)
  → collapse to one line
Bot → /gc:  Aria (Mango): NW ≈ 8.2b (est, some hidden) | SnrW 12.3k | Cata 40
```

### 7.4 Blocked by anti-spam
```
Discord #guild-bridge:  Mallory: BUY COINS CHEAP www.badsite.xyz
  → wordlist match (advertising, BLOCK) + mention/link rule
  → message NOT relayed; Infraction(SPAM) logged; staff-channel flag
  → Mallory sees ephemeral: "Your message was blocked by the chat filter."
```

### 7.5 Milestone announcement
```
worker profile-refresh: detects Steve Catacombs 44 → 45
  → publish milestone event (Milestone.announced = false)
  → bot posts #guild-announcements: "🎉 Steve just reached Catacombs 45!"
  → (optional) /gc mirror; mark announced = true (dedup)
```

### 7.6 Bridge down → reconnect
```
Mineflayer session drops (Hypixel restart)
  → status UP → RECONNECTING (backoff), Health panel updated
  → Discord #guild-bridge one-time notice: "⚠ Guild chat bridge is offline — reconnecting."
  → Aria types in bridge channel → queued (TTL 5m), ack: "queued, guild chat offline"
  → /stats still works (API-backed) ✓
  ... reconnect succeeds ...
  → status → UP; flush queued messages in order (rate-capped)
  → notice updated: "✅ Guild chat bridge restored."
```

---

## 8. Summary

- **Two transports, one relay brain** (`packages/bridge`); every message runs identify → permission → mute/suspend → filter → anti-spam → format → deliver → log.
- **Formatting is direction-aware and never spoofs** in-game identities; webhooks carry IGN + rank + head.
- **Role-gated speaking** via granular `BridgePermission` capabilities.
- **Anti-spam protects both users and the bot's own Hypixel standing** via per-user + global caps, dedup, and mute-awareness.
- **In-game commands are the read-only subset**, one-line, stricter cooldowns.
- **Join screening fails closed:** an unreachable scammer list, a hidden API or a broken dependency all resolve to "a human should look at this", never to an accept.
- **Degraded mode is designed, not accidental:** Discord commands keep working, relays queue, cross-surface mutes defer, and staff get one clear signal — the bridge going down never takes the bot down.
