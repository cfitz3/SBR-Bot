# Platform Expansion Plan

Scope: LFG/Perms, XP & player standing, expanded Skyblock stat commands, milestones,
guild scanning, ticketing, mod logging, wordlist, admin-only web panel, HTTP/HTTPS toggle.

This document is the contract for the build-out. It is written against the existing
monorepo (`packages/*` domain packages + `apps/*` runtimes) and preserves the current
architecture: **Prisma/Postgres is the source of truth, Redis is hot state, domain logic
lives in typed services, transports are thin adapters.**

---

## 0. Governing principles

| Rule | Consequence |
| --- | --- |
| **Panel = admin config only** | No leaderboards, no perms, no LFG usage in the panel. Panel writes only touch config/moderation tables. |
| **Bot = member-facing** | Perms, LFG, leaderboards, standing, milestones view, tickets *usage* are Discord/bridge commands only. |
| **Nothing guild-specific in `.env`** | `.env` holds secrets + process wiring. Every runtime-changeable value moves to Postgres, edited in the panel. |
| **Backward compatible** | Existing columns/commands keep working through each phase; legacy removal is the *last* phase. |
| **Background aggregation** | XP, standing and leaderboards read pre-aggregated rows; commands never compute over raw event tables. |

### Assumptions (documented rather than asked)

1. **HTTPS default means "secure cookies + https origin"**, not "this process terminates TLS".
   A VPS behind a reverse proxy is the normal deployment. Direct TLS termination is
   supported as an opt-in when `WEB_PANEL_TLS_CERT`/`WEB_PANEL_TLS_KEY` are set.
2. **Perm activities reuse the existing `LFGActivity` enum** (`DUNGEONS`, `SLAYERS`,
   `KUUDRA`, `FISHING`, `MINING`, `OTHER`) rather than introducing a parallel enum, so a
   perm can autofill an LFG post without a mapping table.
3. **Perm slot roles are validated per activity in a domain module**, not as a Prisma enum
   — Skyblock class/role vocabulary changes far more often than we want migrations.
4. **In-game chat XP requires a linked account.** An unlinked IGN speaking in guild chat
   earns nothing, because XP is attributed to a platform member.
5. **"Playtime" is proxied**, not measured: `/g online` presence samples + daily GEXP
   presence, since Hypixel exposes no playtime for guild members.
6. **Single Hypixel guild per platform guild** (already implied by `Guild.hypixelGuildId`).
7. **Live Hypixel verification is blocked** — API keys are not persisting upstream
   (known outage). GEXP/scan work is built against recorded fixtures and unit tests;
   live smoke tests are deferred, not skipped silently.

---

## 1. Phases

Each phase is independently shippable: migration → domain package → service → transport
wiring → tests → docs. No phase begins before the previous one typechecks and tests green.

| # | Phase | Delivers | Depends on |
| --- | --- | --- | --- |
| **1** | **Config foundation** *(shipped)* | HTTP/HTTPS toggle, `GuildChannelBinding` + open channel-slot registry, `GuildSetting` KV, panel config surface | — |
| **2** | **Guild scan & member cache** *(shipped)* | 6h guild scan job, rolling 6h in-game member cache, GEXP daily table | 1 |
| **3** | **Perms** *(shipped)* | `PermGroup`/`PermMember`/`PermRoster`, `PermService`, `/perm create\|info\|roster add\|roster remove\|disband`, roster autofill + stats | 2 |
| **S** | **Join screening & auto-accept** *(shipped, out of band)* | SkyKings client, `GuildJoinScreening`, `@sbr/screening` policy engine, bridge join wiring, panel policy editor | 1 |
| **4** | **LFG rework** *(shipped)* | Embed posts into a configured channel, `perm:` toggle autofill, author/staff edit + close, message tracking | 1, 3 |
| **5** | **XP & standing** *(shipped)* | XP ledger + balances, source weights/caps config, anti-abuse gates, `xp-aggregate` job, `/standing` + `/me` (see §3 for the `/profile` deviation) | 1, 2 |
| **6** | **Leaderboards** | `/leaderboard` (bot + bridge only) across wealth, tenure, SA, cata, slayer, Discord activity, guild chat | 5 |
| **7** | **Milestones/achievements** | `MilestoneDefinition` (panel-configured), XP/standing-aware detection job, `/milestones` | 5 |
| **8** | **Stat command expansion** | `/skills` caps, `/slayers` (renamed) tiers, `/dungeons` bosses+classes, `/networth` categories+top items, `/auctions` active/expired/unclaimed | — (parallel-safe) |
| **9** | **Ticketing config** | `TicketPanelConfig`/`TicketTypeConfig`, panel editor, `/ticket` reads config | 1 |
| **10** | **Moderation & wordlist** | `/audit` fixes, expiry-aware punishments, infractions on `/me`, wordlist panel CRUD, auto-warn escalation | 1, 5 |
| **11** | **Fun bridge commands + legacy cleanup** | Themed prefix commands; drop mirrored legacy channel columns and `BRIDGE_CHANNEL_ID` fallback | all |

---

## 2. Schema changes

### 2.1 Config (Phase 1)

```prisma
/// Open-ended channel binding. Replaces the fixed *ChannelId columns on GuildConfig
/// so a new slot is a row, not a migration. Legacy columns are mirrored until Phase 11.
model GuildChannelBinding {
  id        String   @id @default(cuid())
  guildId   String
  slot      String   // bridge | staff | log | applications | events | lfg | tickets | milestones | leaderboard | modlog
  channelId String
  updatedAt DateTime @updatedAt
  @@unique([guildId, slot])
}

/// Typed-at-the-edge KV for admin config that isn't worth a column
/// (embed templates, dropdown menus, feature payloads). Validated by a zod-style
/// schema registry in @sbr/guild-config, never read untyped.
model GuildSetting {
  id        String   @id @default(cuid())
  guildId   String
  key       String
  value     Json
  updatedAt DateTime @updatedAt
  @@unique([guildId, key])
}
```

**As shipped (1c, the panel surface).** Two deviations from the sketch above:

- **No schema registry in `@sbr/guild-config`.** `GuildSetting` values stay opaque
  to the config service and to the panel: the panel's `config.setting` mutation
  enforces only what is true of every setting (a dotted lowercase key, JSON that
  round-trips, a 64 KiB ceiling) and leaves shape validation to whichever feature
  owns the key. A central registry would put every future feature's payload shape
  in one file that every phase has to edit; the "typed at the edge" intent is met
  by `getSetting<T>` returning null on an unreadable value, which callers already
  fall back from.
- **No generic settings editor on the panel.** `config.setting` ships as a write
  route with no UI, because a control needs a known key *and* a read, and
  `GuildConfigService` exposes no way to enumerate keys. Each later phase brings
  its own control and its own read; this is the write path they build on.

Channel bindings, by contrast, are fully surfaced: the Mapping page renders one
control per entry in `CONFIG_CHANNEL_SLOTS` and reads them from
`GuildRuntimeConfig.channels` rather than the mirrored legacy columns, so the five
new slots are settable the moment their features land.

### 2.2 Guild scan & member cache (Phase 2)

```prisma
/// Rolling in-game guild roster. Refreshed by the scan job; rows older than
/// CACHE_TTL (6h) are considered stale and re-fetched rather than served.
model GuildMemberCache {
  id           String   @id @default(cuid())
  guildId      String
  uuid         String
  ign          String?
  guildRank    String?
  joinedAt     DateTime?
  weeklyGexp   Int      @default(0)
  lastSeenAt   DateTime?
  refreshedAt  DateTime @default(now())
  @@unique([guildId, uuid])
  @@index([guildId, refreshedAt])
}

/// One row per member per day: the diff of Hypixel's expHistory, which is what
/// GEXP-based XP is computed from. Idempotent on (guildId, uuid, day).
model GuildGexpDaily {
  id      String   @id @default(cuid())
  guildId String
  uuid    String
  day     DateTime @db.Date
  gexp    Int      @default(0)
  @@unique([guildId, uuid, day])
  @@index([guildId, day])
}

model GuildScan {
  id          String   @id @default(cuid())
  guildId     String
  startedAt   DateTime @default(now())
  finishedAt  DateTime?
  memberCount Int      @default(0)
  joined      String[] @default([])
  left        String[] @default([])
  error       String?
  @@index([guildId, startedAt])
}
```

> `packages/hypixel` needs `GuildMemberDTO` extended with `expHistory: Record<string, number>`
> and `weeklyGexp` — the normalizer currently drops both.

**As shipped** (migration `20260809140000_guild_scan_cache`), with two deviations from
the sketch above:

- **`lastSeenAt` was dropped.** It would have duplicated `refreshedAt` — the scan is the
  only writer, and a row is refreshed exactly when the member is seen. Presence sampling
  (assumption 5) needs its own grain and will get its own table in Phase 5 rather than
  overloading a column here.
- **GEXP is stored as Hypixel's daily value, not a computed diff.** `expHistory` is
  already per-day, so diffing it against the previous scan would turn an idempotent
  overwrite into a stateful accumulation that double-counts on any re-run. The table is
  a mirror of upstream's series, extended past its ~7-day window.

`packages/hypixel` gained `expHistory`/`weeklyGexp` on `GuildMemberDTO` plus
`resolveIgn(uuid)` against the Mojang session server; the pure scan logic is
`packages/jobs/src/guild-scan.ts` and the cadence is `26 1,7,13,19 * * *`.
See `docs/WORKERS.md` §2.14 for the failure and rate-limit rules.

### 2.3 Perms (Phase 3)

```prisma
enum PermStatus { ACTIVE DISBANDED }

model PermGroup {
  id            String      @id @default(cuid())
  guildId       String
  ownerDiscordId String
  name          String
  activity      LFGActivity
  status        PermStatus  @default(ACTIVE)
  /// The perm /lfg autofills from when `perm:true` and no perm is named.
  isDefault     Boolean     @default(false)
  notes         String?
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt
  members       PermMember[]
  @@index([guildId, ownerDiscordId, status])
  @@index([guildId, activity, status])
}

model PermMember {
  id          String   @id @default(cuid())
  permGroupId String
  /// Resolved where possible; a perm may hold an IGN we have no platform member for.
  discordId   String?
  uuid        String?
  ign         String
  role        String   // healer | mage | berserk | archer | tank | dps | ... (validated per activity)
  slot        Int      @default(0)
  addedAt     DateTime @default(now())
  permGroup   PermGroup @relation(fields: [permGroupId], references: [id], onDelete: Cascade)
  @@unique([permGroupId, ign, role])
  @@index([permGroupId, slot])
}
```

Partial unique index (raw SQL in the migration): at most one `isDefault` perm per
`(guildId, ownerDiscordId, activity)`.

**As shipped** (`20260809180000_perms`), with three deviations from the sketch above:

- **`PermRoster` was dropped.** The phase table named three models, but a roster is
  not a thing distinct from the perm — `PermGroup` *is* the roster, and its seats are
  `PermMember` rows. A third table would have been a one-to-one join with nothing on it.
- **A second partial unique index was added**, on `("guildId", LOWER("name"))
  WHERE status = 'ACTIVE'`. The sketch had no uniqueness on `name`, but `/perm info
  <name>` addresses perms by name from memory in guild chat, and two live perms
  called "F7 core" make that command unanswerable. Scoping it to `ACTIVE` keeps the
  name reusable after a disband, which is what makes disband-not-delete tolerable.
- **`/perm` is one command with an `action` option**, not six. Six top-level names
  for one feature is a poor trade against a shared command namespace; `/ticket`
  already made the same call.

Two things the sketch left open and the implementation had to decide:

- **Roles are data, not schema.** `role` stays a free-form string validated against a
  per-activity table in `packages/perms/src/activities.ts`, which also carries the
  capacity and an alias list (`zerk`→`berserk`, `dps`→`damage`, `cannon`→`cannoneer`).
  Skyblock's class vocabulary changes faster than migrations should.
- **Enrichment is cache-only.** `/perm info` reads `GuildMemberCache` and the newest
  `ProfileSnapshot`, one query each for the whole roster, never Hypixel — five live
  calls for a casually-run command is what the Phase 2 cache exists to prevent. Every
  enrichment read is failure-wrapped, so a downed cache degrades the roster to plain
  names rather than hiding it, and `inGuild` is three-valued: a cold cache renders as
  nothing, not as "left the guild".

**Deferred from this phase:** IGN autocomplete on `/perm ign:` off the member cache.
It needs a directory port on `HandlerDeps` that nothing else wants yet; the `perm:`
option does autocomplete, off `listPerms`. Revisit with Phase 4, which reads the same
cache.

### 2.4 LFG (Phase 4) — *shipped*

Additive columns on `LFGPost`: `channelId String?`, `messageId String?`,
`permGroupId String?`, `title String?`, `closedAt DateTime?`, `closedByDiscordId String?`.
Migration `20260809230000_lfg_rework`. No index on `messageId`: button state lives in
the `customId`, so no read ever goes message → post.

Two decisions worth carrying forward:

- **`@sbr/community` does not depend on `@sbr/perms`.** LFG wants two things from a
  perm — its name and who is in it — so it declares a `PermRosterLookup` port and
  `@sbr/db` implements it. A missing *default* perm is not an error (`perm:true`
  means "bring my usual party if I have one"); a missing *named* one is.
- **Discord-only options need marking.** In-game args are positional and the last
  option absorbs the line, so adding `title`/`perm`/`permname` would have re-mapped
  `!lfg dungeons 5 need a healer`. `CommandOptionSpec.inGamePositional: false` keeps
  them off the guild-chat shape; anything added to an `inGame` spec from here needs
  the same consideration.

### 2.5 XP & standing (Phase 5) — *shipped*

```prisma
enum XpSource { GEXP DISCORD_MESSAGE GUILD_CHAT_MESSAGE TENURE COMMAND_USAGE EVENT MANUAL }

/// Append-only ledger. Every award states its source, the raw quantity it came
/// from and the weight applied, so a balance is always explainable and rebuildable.
model XpEvent {
  id         String   @id @default(cuid())
  guildId    String
  discordId  String
  source     XpSource
  amount     Int
  rawValue   Int      @default(0)
  day        DateTime @db.Date
  /// Idempotency key: "gexp:<uuid>:<day>" style. Makes re-runs of an aggregation
  /// job a no-op instead of double-crediting.
  dedupeKey  String?
  meta       Json     @default("{}")
  createdAt  DateTime @default(now())
  @@unique([dedupeKey])
  @@index([guildId, discordId, day])
  @@index([guildId, source, day])
}

/// Denormalized standing, rebuilt by the xp-aggregate job. What commands read.
model XpBalance {
  id          String   @id @default(cuid())
  guildId     String
  discordId   String
  totalXp     Int      @default(0)
  level       Int      @default(0)
  bySource    Json     @default("{}")
  tenureDays  Int      @default(0)
  lastAwardAt DateTime?
  updatedAt   DateTime @updatedAt
  @@unique([guildId, discordId])
  @@index([guildId, totalXp])
}

/// Panel-configured weight/cap per source. Absent row = source disabled.
model XpSourceConfig {
  id            String   @id @default(cuid())
  guildId       String
  source        XpSource
  enabled       Boolean  @default(true)
  weight        Float    @default(1)
  dailyCap      Int?
  cooldownSec   Int      @default(0)
  minLength     Int      @default(0)
  updatedAt     DateTime @updatedAt
  @@unique([guildId, source])
}

/// Raw per-day activity counters, written by the hot path via Redis and drained
/// by a job. XP is derived from these, never directly from message events.
model ActivityDaily {
  id        String   @id @default(cuid())
  guildId   String
  discordId String
  day       DateTime @db.Date
  discordMessages   Int @default(0)
  guildChatMessages Int @default(0)
  commandsUsed      Int @default(0)
  presenceSamples   Int @default(0)
  @@unique([guildId, discordId, day])
  @@index([guildId, day])
}
```

Migration `20260810000000_xp_standing`. Shipped as planned, with three decisions
made during implementation:

- **Counters on the hot path, awards in a job.** Nothing that runs while a member
  is typing computes XP. The message path increments a counter behind a Redis
  cooldown gate; `xp-aggregate` weights the day's counters into the ledger. This
  is what lets a weight change apply to a day already in progress.
- **Upsert on `dedupeKey`, not skip-if-present.** A day still climbing has to
  *converge*, not freeze at the first pass's partial figure. That in turn is why
  the balance rebuild reads the whole ledger instead of applying a delta.
- **Aggregation is three-hourly, not nightly** (`48 */3 * * *`). A member asking
  for their standing should not be told about the person they were yesterday.
  Each run re-derives yesterday as well as today, since a scan straddling
  midnight can still add a late GEXP row. See `WORKERS.md` §2.10b.

### 2.6 Milestones (Phase 7)

```prisma
model MilestoneDefinition {
  id          String        @id @default(cuid())
  guildId     String
  key         String
  label       String
  description String?
  type        MilestoneType
  metric      String
  threshold   BigInt
  xpReward    Int           @default(0)
  announce    Boolean       @default(true)
  enabled     Boolean       @default(true)
  @@unique([guildId, key])
}
```
`Milestone` gains `definitionId String?` and `discordId String?`.

### 2.7 Tickets (Phase 9)

```prisma
model TicketPanelConfig {
  id          String @id @default(cuid())
  guildId     String @unique
  channelId   String?
  messageId   String?
  title       String @default("Support")
  description String?
  embed       Json   @default("{}")
  updatedAt   DateTime @updatedAt
}

model TicketTypeConfig {
  id            String  @id @default(cuid())
  guildId       String
  key           String
  label         String
  emoji         String?
  category      TicketCategory @default(SUPPORT)
  parentChannelId String?
  staffRoleIds  String[] @default([])
  prompt        String?
  position      Int     @default(0)
  enabled       Boolean @default(true)
  @@unique([guildId, key])
}
```

---

## 3. Command changes

### New (member-facing, bot only)

| Command | Surface | Notes |
| --- | --- | --- |
| `/perm action:create name: activity:` | Discord + `!perm` | Owner = caller. *Shipped.* |
| `/perm action:info perm:` | Discord + `!perm` | Roster with cata level and skill average per member, from the cache. *Shipped.* |
| `/perm action:list` | Discord + `!perm` | Every active perm in the guild. *Shipped.* |
| `/perm action:roster-add perm: ign: role: [slot]` | Discord + `!perm` | `perm:` autocompletes; `ign:` autocomplete deferred (see §2.3). *Shipped.* |
| `/perm action:roster-remove perm: ign: role:` | Discord + `!perm` | *Shipped.* |
| `/perm action:disband perm:` | Discord + `!perm` | Owner or staff. Status change, never a delete. *Shipped.* |
| `/perm action:default perm:` | Discord + `!perm` | Marks the perm `/lfg perm:true` autofills from. Owner only. *Shipped.* |
| `/leaderboard <category>` | Discord + bridge | wealth, tenure, skill-average, catacombs, slayer, discord-activity, guild-chat, xp. |
| `/standing [member]` | Discord + `!standing` | XP, level, source breakdown, tenure, rank in guild. Takes a **Discord member**, not a player: XP is attributed to a Discord account. Public for yourself, ephemeral for someone else. *Shipped.* |

### Changed

| Command | Change |
| --- | --- |
| `/lfg` | Posts an **embed** into the configured LFG channel; adds `title`, `perm` boolean and `permname`; `/editrun` + `/closerun` and a Close button for author or staff; tracks `messageId`. *Shipped.* |
| `/me` | Gained "Guild standing" (level, total XP, rank) and "Tenure" fields. *Shipped, with two deviations below.* |
| `/profile` | Unchanged. See the deviation note. |
| `/slayer` → `/slayers` | Renamed with `/slayer` kept as a deprecated alias for one release; per-tier boss kill breakdown. |
| `/skills` | New skills + current caps, capped-skill markers. |
| `/dungeons` | Boss completions per floor, cata progress to next level, class averages. |
| `/networth` | Category breakdown + top N items per category. |
| `/auctions` | Split into active / expired / unclaimed with claim value total. |
| `/milestones` | Definition-driven, shows earned + next-up with progress. |
| `/ticket` | Reads `TicketTypeConfig` instead of the hard-coded category list. |

**Two deviations from the plan's `/me`, `/profile` line, both deliberate:**

- **`/profile` carries no standing.** It addresses a *player* by IGN, standing is
  keyed by Discord id, and `IdentityService` exposes no IGN → Discord id
  resolution (only `identityRepository.findDiscordIdByIgn`, one layer below).
  Widening the service interface for a decorative field would have touched every
  fake of it across sixteen files. Standing therefore lands on `/me` — the one
  lookup certain the account and the person are the same — and on
  `/standing member:`.
- **`/me` shows no open infractions.** The member `HandlerDeps` carries no
  moderation service, by design: the member bot does not read the moderation log.
  Adding the dependency for a count would hand every member-facing handler a
  reach it has no business having.

### Bridge fun commands (Phase 11)
`!8ball`, `!roll`, `!coinflip`, `!rps`, `!guildquote`, `!rank`, `!cringe` — rate-limited
through the existing `CooldownGate`, wordlist-filtered, no state beyond Redis counters.

---

## 4. Web panel changes (admin-only)

New/changed pages, all behind the existing `MANAGE_GUILD` session check:

| Page | Contents |
| --- | --- |
| **Mapping** (existing, extended) *(shipped)* | Channel bindings for *every* slot (bridge, staff, log, applications, events, LFG, tickets, milestones, leaderboard, modlog), role mappings, feature toggles. The slots landed on Mapping rather than Settings because the existing split is by what a change *does*: Mapping changes where the platform points, Settings changes how it behaves. |
| **Settings** (existing) | Bridge suspend, recruitment, prefixes and timezone (the last two read-only until a mutation exists). |
| **XP** (new) *(shipped)* | Per-source enable/weight/daily cap/cooldown/min-length and manual adjustment with audit trail, both Admin+. No level-curve control: the curve is triangular with a closed-form inverse, and a per-guild curve would make every stored `level` a function of a setting that can change under it. No standings or leaderboard on the page — those are member-facing, and the panel owns the rules, not the scores. |
| **Milestones** (new) | CRUD over `MilestoneDefinition`, XP reward, announce toggle. |
| **Tickets** (new) | Panel embed editor, ticket types/categories, staff roles, parent channel, dropdown ordering. |
| **Wordlist** (new) | CRUD over `WordlistEntry`, match type/action/severity, auto-warn escalation thresholds. |
| **Moderation** (existing, extended) | Infractions review, expiry-aware punishment list, moderation defaults. |
| **Health** (existing, extended) | Job health incl. new scan/XP jobs, last scan result, cache staleness. |

New action routes (`POST /api/guilds/:id/actions/...`):
`config.channel` (extended to open slots) *(shipped)*, `config.setting` *(shipped)*, `xp.source`, `xp.adjust`,
`milestone.upsert`, `milestone.delete`, `ticket.panel`, `ticket.type`, `wordlist.upsert`,
`wordlist.delete`, `moderation.defaults`.

**Explicitly not in the panel:** leaderboards, perms, LFG posts, member standing views.

---

## 5. HTTP/HTTPS toggle (Phase 1)

New env keys (all optional, HTTPS-safe defaults):

```
WEB_PANEL_SCHEME=https          # http | https — default https
WEB_PANEL_PUBLIC_URL=           # e.g. http://203.0.113.10:3000 — overrides derived origin
WEB_PANEL_TLS_CERT=             # optional: terminate TLS in-process
WEB_PANEL_TLS_KEY=
```

Code paths touched:

1. `packages/config` — `web.scheme`, `web.publicUrl`, `web.tls`, plus a derived
   `web.secureCookies` (`scheme === "https"`), and validation that an `https` scheme with a
   plaintext `DISCORD_OAUTH_REDIRECT_URI` is a hard error rather than a silent downgrade.
2. `apps/web-panel/src/server.ts` — cookie `Secure` flag now derives from `web.secureCookies`
   instead of sniffing the redirect URI; origin check derives from `web.publicUrl ?? redirectUri`;
   `createServer` becomes `https.createServer` when TLS material is present.
3. OAuth callback/authorize URL building uses the resolved public URL so an HTTP VPS
   round-trips correctly.
4. `.env.example` + `docs/WEB_PANEL.md` document the flag and its security tradeoff.

---

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| **Hypixel API keys are not persisting upstream** (known outage) — GEXP/scan cannot be verified live | Build against recorded fixtures + unit tests; gate the scan job behind a feature flag; flag the deferred live smoke test explicitly rather than claiming verification. |
| **XP double-crediting** on job retries | `XpEvent.dedupeKey` unique index; aggregation is idempotent per (source, subject, day). |
| **XP farming** (message spam) | Daily caps, per-user cooldowns, min message length, bot/command filtering, all panel-configurable; ledger makes abuse auditable and reversible. |
| **Channel binding migration** silently breaking the bridge | Dual-read (binding → legacy column → env) and dual-write for the five legacy slots; legacy removal only in Phase 11. |
| **HTTP mode leaking sessions** | HTTPS remains the default; HTTP mode logs a loud startup warning and refuses `NODE_ENV=production` unless `WEB_PANEL_ALLOW_INSECURE=true`. |
| **Renaming `/slayer`** breaks muscle memory + registered commands | Ship `/slayers` alongside a deprecated `/slayer` alias for one release. |
| **Prisma migration size** across 11 phases | One migration per phase, additive only; no destructive change before Phase 11. |
| **Panel scope creep** into member features | Route allowlist is reviewed per phase against §4's "not in the panel" list. |
| **Perm roster drift** from real guild membership | Roster autofill reads the 6h cache; `/perm info` marks members no longer in the guild rather than deleting them. |

---

## 7. Definition of done per phase

- Prisma migration committed and `db:validate` clean.
- Domain logic in a `packages/*` service with unit tests (no Discord/Prisma in tests).
- Transport wiring updated in the relevant `apps/*`.
- `npm run build` (tsc project references) green.
- Docs updated: `COMMANDS.md`, `WEB_PANEL.md`, `DOMAIN_MODEL.md`, `WORKERS.md` as touched.
