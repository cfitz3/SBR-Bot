# Overhaul plan

The slice order for the comprehensive overhaul of the member bot, the staff bot
and the web panel. This is a **planning** document: it states what each slice
changes, what it depends on, and why it sits where it does. Each slice lands as
its own branch off `main` with its reasoning in the commit message; this file is
the map, not the record.

Two items were flagged as decision points before implementation. Both are
addressed in §0 below; the slices that depend on them (`M-07`, `E-01`) do not
start until the answer is recorded here.

---

## 0. Decision points

### DP-1 — event poll interval vs. the per-player hourly cap

`docs/HYPIXEL_COMPLIANCE.md` §2 is the constraint: this platform runs on the
**guild-activity exception** against a personal key, which Hypixel caps at
roughly one request per player per hour. The doc's own reading is one *refresh*
per player per hour across three endpoint families, enforced by
`RedisPlayerRateLimiter` over `rl:player:{uuid}:{endpoint}` — a limiter that
deliberately does **not** yield to upstream's headers, because a cap that
upstream can lift is not a cap.

A 30-minute event leaderboard poll doubles that rate for every signed-up
participant for the duration of an event. It is exactly the class of scheduled
per-player polling that caused the prior compliance problems, so it is not
something to switch on by inference.

**Decided: the 30-minute interval waits for the production key.** Events ship
with a 60-minute poll that goes through `PlayerRateLimiter` like every other
player read, so an active event costs no more per participant than a member
running `/me` does. The 30-minute cadence exists in code behind a single setting
that is gated on the production key being approved — one flag to flip, and until
it is flipped the exception's arithmetic in §2 of the compliance doc stays true
as written. No participant carve-out, no limiter bypass. See `E-01`.

### DP-2 — `skycofl.net` as the price-history source

**Resolved: the source exists, but under a different name.** `skycofl.net` does
not resolve to an API; the service is **Coflnet SkyApi** at `sky.coflnet.com`
(`skycofl.com` is a mirror of the same front end). It publishes a real OpenAPI 3
document at `https://sky.coflnet.com/api/swagger/v1/swagger.json` — 135 paths,
verified live, with the history endpoints this backlog needs:

| Need | Endpoint |
|---|---|
| Auction price history | `/api/item/price/{itemTag}/history/{day,week,month,year,full}` |
| Current / BIN price | `/api/item/price/{itemTag}/current`, `/api/item/price/{itemTag}/bin` |
| Bazaar history | `/api/bazaar/{itemTag}/history/{hour,day,week}` |
| Bazaar snapshot | `/api/bazaar/{itemTag}/snapshot` |
| Market movement | `/api/prices/change` |

`GET /api/item/price/HYPERION/history/week` returns hourly `{min,max,avg,volume,time}`
buckets unauthenticated. The two declared security schemes (`Bearer`,
`GoogleToken`) gate premium endpoints only; none of the above are behind them.

**Decided: Coflnet is a history and context source layered on top of
`@sbr/pricing`, not the primary market source.** Coflnet is a *history and context* source layered on top
of `@sbr/pricing`, not a replacement for it. Live orderbook, lowest BIN and
networth valuation stay on the existing Hypixel-backed path — that data is
already cached and rate-gated, and swapping it for a third party would put
networth accuracy behind someone else's uptime. Coflnet fills the one gap we
cannot fill ourselves: the past. It gets its own port with its own cache and
breaker, and every card degrades to the current text answer when it is down.

---

## 1. Slice order

Slices are grouped into phases. Within a phase, slices are independent unless a
dependency is named. Across phases, later depends on earlier.

### Phase F — foundations (blocks nearly everything)

| Slice | What | Depends on |
|---|---|---|
| `F-01` | **Shared card layer.** A `card()` builder in `@sbr/discord-kit` that structurally enforces the Core Embed Principles: identity into `author` + `thumbnail`, headline into `description`, tone-token colour, native `timestamp`, one `progressBar()` glyph set, one `markerFor()` flag function, `facts()` for consolidating small values into one multi-line field, and a 4–6 field readability budget as a new `field.budget` warning in `style.ts`. Gallery fixtures for every card it produces. | — |
| `F-02` | **Tone pass + `/health`.** New member-facing `/health` showing a curated bridge / bot / API status subset. General error handler rewritten to point at `/health` instead of narrating the failure, with a button opening a permanent bug-report ticket category — appearance-configurable, not disableable. Retroactive audit of existing error strings, command descriptions and panel copy against the tone standard. | `F-01` |
| `F-03` | **Free retirements.** Deregister commands whose function is already covered and which block nothing: `/guildquote`, `/stats`, `/tag`, `/slayer`. Follows the existing `enabled: false` pattern so they leave Discord's registry, not just the dispatcher. | — |

### Phase M — member bot

| Slice | What | Depends on |
|---|---|---|
| `M-01` | **Playtime tracker + `/online` fix.** Session start on bridge-observed join, end on leave, with a reconnect debounce so a flap is one session. Fixes the rank-grouping bug that lists one member per rank while counting all of them. `/online` gains live "Playing for 42m". | `F-01` |
| `M-02` | **`/skills` + `/slayers`.** Hunting cap 25 (not 50), Foraging cap 60 (not 57), gold star for maxed, per-tier kill counts on slayers, both rebuilt on `F-01`. | `F-01` |
| `M-03` | **`/me` merge.** `/me` + `/standing` into one card; `/rank` and `/standing` deregistered. | `F-01` |
| `M-04` | **`/whois`.** `/avatar` + `/userinfo` merged, plus link status and a read-only punishment summary. | `F-01` |
| `M-05` | **`/networth` drill-down.** Full vertical overview plus a category dropdown showing the itemised breakdown. | `F-01` |
| `M-06` | **`/progression`.** `/goal`, `/progress`, `/snapshot` merged into one ephemeral card with "Begin tracking" and metric-configuration buttons. Widens trackable metrics (fairy souls, per-skill levels, museum %, pet score, bestiary, minions, essence) and makes the set panel-configurable. | `F-01`, `P-01` |
| `M-07` | **Market history.** `/price`, `/bazaar`, `/lowestbin`, `/auctions` onto one price-lookup experience with a Coflnet-backed history graph and market context. New `@sbr/pricing` history port + cache + breaker. | `F-01`, DP-2 |
| `M-08` | **`/help` rebuild.** Points new members at `/link`, "Link help" button with a panel-configurable GIF and copy, commands grouped by category. `/verify` folded into the `/link` flow and deregistered. | `F-01`, `P-01` |
| `M-09` | **`/serverinfo` fix.** Diagnose why it returns nothing, then extend it with member totals, Discord + in-game message counts and top member of the week. | `F-01` |
| `M-10` | **Trigger framework + starboard.** General reaction/message trigger system with pluggable trigger and action types; starboard is the first concrete pair. `/cringe` deregistered. | `F-01`, `P-01` |
| `M-11` | **Guild join notices.** Plaintext to embeds; approve/deny buttons and an explicit staff-role ping on anything needing manual review; auto-decided notices upgrade to embeds without a ping. | `F-01` |

### Phase E — events (member bot + panel + jobs)

| Slice | What | Depends on |
|---|---|---|
| `E-01` | **Competition events.** Activity dropdown determines both name and tracked metric (one metric per event), free-text description, button signup, only signed-up members tracked. One message per event that starts as the signup roster and becomes the live leaderboard in place. Native Discord Guild Scheduled Events mirrored by a maintained embed in the events channel. Retires `/attendance`, `/create-event`, `/events`, `/rsvp`; creation moves to the panel. | `F-01`, `P-01`, DP-1 |

### Phase G — groups

| Slice | What | Depends on |
|---|---|---|
| `G-01` | **`/perm` rework.** Creation and editing entirely through embeds, dropdowns and pagination — no text-argument creation. Party breakdown by role showing each player's role, Catacombs level and the role's expected level; unlinked players say so plainly. Dungeon perms only for now, with a seam for the ctjs WebSocket stats (splits, secrets, deaths) when that lands. | `F-01` |
| `G-02` | **`/lfg` rework.** Menu flow: type → floor → optional classes, posting to the configured LFG channel with the configured role ping and the requester's Catacombs level. Mirrored in-game as `!lfg <floor>`. | `F-01`, `G-01` |

### Phase S — staff bot

| Slice | What | Depends on |
|---|---|---|
| `S-01` | **Modlog pipeline fix.** Find why moderation actions never reach modlog, checked together with the ban/kick sync gap. Blocking for `S-02` because an audit view over a broken pipeline reports a false empty. | — |
| `S-02` | **`/audit` overhaul + `/case` search.** At-a-glance overview with detail on click; search by member, actor, action type and date range so a case ID is never a prerequisite. | `F-01`, `S-01` |
| `S-03` | **`/feature-toggle`.** Embed with a dropdown of every toggleable feature, updating in place. | `F-01` |
| `S-04` | **`/lockdown` merge.** One command: warning embed with "here" and "globally" buttons; a lift path when any lock is active; global folds in local locks with no orphans; lifting from the wrong channel offers both the correct lift and escalation. `/lockdown-lift` deregistered. | `F-01` |
| `S-05` | **Utility modernisation.** `/member-note` → `/note`; `/sticky` and peers moved off positional arguments onto buttons and embeds where it helps. | `F-01` |
| `S-06` | **`/antiraid` panel config.** Sane defaults kept, fine-tuning exposed on the panel, plus a dry-run harness to test rules against other moderation and automod features. | `P-02` |

### Phase P — panel

| Slice | What | Depends on |
|---|---|---|
| `P-01` | **Multi-user access + security review.** Privilege roles gating sections and actions, reusing the existing tiered page-access concept. Full review of session handling, CSRF on mutations and cookie flags, recorded in `docs/PANEL_SECURITY.md` with what was checked and the resulting configuration. Blocking for every later panel slice, because each adds surface that must land under the new model rather than be retrofitted. | — |
| `P-02` | **Ticket panel fixes + streamlining.** Root-cause the empty `categoryKeys` rejection on panel creation and the key-format rejection on category disable; broadly streamline panel and category management. Removes `/ticket` from the member bot once parity is confirmed. | `P-01` |
| `P-03` | **Wordlist panel.** JSON upload, packaged-list enable/disable, custom lists extending packaged ones. Removes `/wordlist` and peers. | `P-01` |
| `P-04` | **Automod testing panel.** Absorbs `/filter-test`, which is then deregistered. | `P-01`, `P-03` |
| `P-05` | **Role menus on the panel.** Confirms parity with `/rolemenu`, then deregisters it. | `P-01` |
| `P-06` | **Visual overhaul.** Toggleable colour schemes, Overview reordered to Discord Server → In-Game Guild → a renamed "Recent Actions" tab. Design direction cited from real open-source dashboard work, not invented attribution. | `P-01` |
| `P-07` | **Analytics overhaul.** Adjustable graph time range and a readable command-usage breakdown replacing the current unlabelled run-on string. | `P-01`, `P-06` |
| `P-08` | **Members page.** Linked / Unlinked tabs replacing Discord-only / in-game-only, and the double-count fix so a linked member counts once. | `P-01` |
| `P-09` | **Moderation page view-only.** History, punishment lifting and correction, and note editing stay; originating new punishments from the panel goes. | `P-01` |
| `P-10` | **XP sandbox.** Simulate a proposed weight or cap change against real data before committing, alongside the policy editor, following the existing policy-and-evidence side-by-side pattern. | `P-01` |
| `P-11` | **`/set-recruitment` removal.** Auto-accept-clean-users made the stat gate irrelevant. | — |

---

## 2. Standing rules

These apply to every slice above, not only the ones that name them.

- Existing conventions hold: injectable ports, offline-testable domain packages,
  the role-grant ledger and reconciliation model, the typed brand/copy keys
  (`embed.field.*`, `copy.*`, `theme.ts`), the Hypixel limiter and cache, and the
  ownership split between the member bot and the admin bot.
- Every embed touched anywhere goes through the `F-01` card layer. This is a
  standing rule, not a one-off redesign slice.
- Every removal deregisters from Discord's slash-command registry via the
  existing `enabled: false` path — not merely disabled at dispatch.
- No command is removed before its replacement surface demonstrably reaches
  parity. Where the replacement is on the panel, the removal ships in the same
  slice as the panel work, so a capability gap cannot exist between two merges.
- Errors are short, professional and point at `/health` rather than narrating the
  failure in prose.
