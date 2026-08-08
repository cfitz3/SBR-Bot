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
| F12 | **Bridge health & degradation** | Detects in-game disconnects, reconnects with backoff, and switches to a documented degraded mode. |
| F13 | **Live guild roster** | `/online` reads `/g online` through the in-game session and reports who's on, grouped by guild rank. |

---

## 2. Command Spec

The bot exposes two command channels; both route to the **same domain services** so behavior is identical.

### 2.1 Discord slash commands
Full member surface per `COMMANDS.md` §1–7 (`/link`, `/me`, `/stats`, `/networth`, `/price`, `/lfg`, `/rsvp`, `/help`, …). Permission via `packages/identity` + `BridgePermission`. Personal/admin output ephemeral; shareable lookups public.

### 2.2 In-game commands (guild chat)
Prefix commands (prefix + enabled set from `GuildConfig`). **Read-only / low-risk subset only** — never moderation, linking secrets, or config.

| In-game | Maps to | Perm | Data |
|---------|---------|------|------|
| `!stats <ign?>` `!skills` `!slayer` `!dungeons` `!nw` | `/stats`…`/networth` | `RUN_COMMAND` | Cache→Live |
| `!price <item>` `!bz <item>` `!lbin <item>` | market lookups | `RUN_COMMAND` | Cache (worker) |
| `!weight <ign?>` | Senither/farming weight | `RUN_COMMAND` | Cache→Live |
| `!lfg <activity> <slots>` `!runs` | LFG create/list | `RUN_COMMAND` (linked) | DB + Cache |
| `!help` | condensed catalog | Public | Static |

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
- Default: any **linked, non-muted** member with `RELAY_MESSAGE` may talk across the bridge.
- `RUN_COMMAND`, `MENTION`, `BYPASS_FILTER`, `BYPASS_COOLDOWN` are separate capabilities granted per Discord role / guild rank via `BridgePermission`.
- Unlinked users' Discord messages in the bridge channel are **not relayed** (optional gentle nudge to `/link`); their messages stay in Discord only.
- With no `BridgePermission` rows written, capabilities fall back to a **`GuildMember.role` floor** so an unconfigured guild is still usable — `RELAY_MESSAGE`/`RUN_COMMAND` from `MEMBER` up, `MENTION` from `MODERATOR`, `BYPASS_COOLDOWN` from `OFFICER`, `BYPASS_FILTER`/`ADMIN` from `ADMIN`. A row still wins over the floor, and a deny row wins over everything (see `DOMAIN_MODEL.md` → BridgePermission).

### 3.4 Announcements, reminders & news (F9–F10)
- **Milestones (F9):** the `profile-snapshot` worker detects crossings (skill/cata/slayer/networth thresholds) and publishes an event; the bot announces to the configured channel (`🎉 Steve just hit Catacombs 45!`) and optionally to guild chat. Deduped via `Milestone.announced`.
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
| Discord slash commands (`/stats`, `/nw`, `/price`, `/lfg`, …) | **Fully work** — they use the Hypixel API + cache, not the in-game connection |
| Discord → guild chat relay | **Paused**; messages **queued** (bounded, TTL) and flushed on reconnect, or dropped with a notice if the queue expires |
| Guild chat → Discord relay | Unavailable (no in-game feed); a status notice is posted once to the bridge channel |
| In-game `!commands` | Unavailable (no in-game input); N/A until reconnect |
| Cross-surface `/mute` | Discord timeout still applies; **guild-chat mute deferred** and applied on reconnect (logged as pending) |
| Milestones / news / reminders | Continue to Discord; guild-chat mirror suppressed until reconnect |

- **One clear signal, not spam:** the bot posts a single "bridge offline" status message (and updates it on recovery), rather than erroring on every attempted relay.
- **Queue, don't lose:** Discord→in-game messages are held in a bounded Redis queue with TTL; on reconnect they flush in order (respecting the global rate cap), and anything expired is reported as "not delivered."
- **No silent success:** users attempting to relay while down get a brief "guild chat is offline, message not sent (or queued)" acknowledgement.

---

## 7. Example Message Flows

### 7.1 Discord → in-game relay (happy path)
```
Discord #guild-bridge:  Aria: gg everyone, cata 40!
  → identify: Aria → linked IGN "AriaMC", role Member (RELAY_MESSAGE ✓)
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
worker profile-snapshot: detects Steve Catacombs 44 → 45
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
- **Degraded mode is designed, not accidental:** Discord commands keep working, relays queue, cross-surface mutes defer, and staff get one clear signal — the bridge going down never takes the bot down.
