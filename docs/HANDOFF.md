# Handoff — 19 August 2026

Where the build stands, what is safe to run in production right now, and what
the next session picks up. Written at a deliberate stopping point: the tree
builds, the suite is green, and nothing half-wired is reachable without saying
so out loud.

## State

- **Build**: `npx tsc -b` and `npm run build -w @sbr/app-web-panel` both exit 0.
- **Tests**: `npm test` — 1497 pass, 0 fail, 1 skipped (a POSIX file-mode
  assertion that cannot hold on Windows).
- **Brand checker**: `npm run brand check` clean; 70 command descriptions within
  Discord's cap, 43 theme tokens all with fallbacks, 60 gallery cards with no
  error-severity issues.
- **CSP**: no `innerHTML`, no inline `style=`, no off-origin host anywhere in
  `apps/web-panel/client/`. Every class literal in the client resolves to a rule
  in `public/app.css` except three deliberate modifier classes (`state-empty`,
  `state-loading`, `field-toggle`) whose base class carries the styling.

## Shipped and running

Part I phases 1–8, 12; Part II phases A–F; Part III phase 13, and the bulk of
phase 14. In plain terms, since the last commit the platform gained:

- A loopback-only internal API on the admin bot, and searchable channel / role /
  member pickers across the panel — no snowflake is typed by hand any more.
- Directory scans on both sides and a unified member read, so Members shows
  everyone whether they are linked or not, searchable by name rather than id.
- An enforcement bus, so a panel action reaches Discord *and* the in-game guild,
  with a configurable mapping table.
- A rule-based automod spanning Discord and the guild-chat relay, testable from
  the panel against sample text without writing anything.
- Overview membership, activity log and join-attempt cards; manual worker
  triggers on Health; broadened Analytics.
- `@sbr/brand`: every user-visible string and every visual token behind a typed
  key, with `brand/copy.ts` and `brand/theme.ts` as the operator-owned overrides.
- SkyBlock Level as the headline metric; Senither weight demoted to a displayed
  stat rather than a gate.

## Phase 14 — Tickets: what landed, what has not

**Landed.** The domain package `packages/tickets` (categories, naming,
eligibility, lifecycle, transcript, panel composition, tags — every file unit
tested), the schema rebuild and migration `20260814100000_tickets_rebuild`, the
persistence layer, the panel's five-section tickets page, the bridge command
surface, and the ticket copy block.

Two security fixes are in this set and are the reason the rebuild was worth
finishing rather than reverting:

- Every mutating ticket operation now takes a `TicketActor` and passes through
  `canAct`, which permits the opener or staff and nobody else.
- `/ticket action:close` is never staff. It is the member surface and it takes
  an arbitrary id — which is exactly how any member could close anyone's ticket
  before. A member can now close only their own; staff close from the ticket
  channel or the panel, both capability-gated.

**Also landed, since.** The Discord half is now in as well:

- `apps/bridge-bot/src/tickets.ts` and `tickets-discord.ts` — panel publishing,
  the `tkt:new|pick|claim|release|close|closereq` component namespaces, channel
  creation with permission overwrites, question modals, message capture,
  log-channel notices, archiving-or-deleting on close.
- A loopback control API on the bridge bot (`internal-api.ts`) and its three
  clients — panel, admin bot, workers. `ticketEffects` **is** wired into the
  panel composition now, so **Publish** and **Re-send transcript** do what they
  say, and report the bridge's own words when they cannot.
- Admin `/tickets list|view|close|transcript`, moderator-gated, with a
  cross-guild id check on `view`.
- The `ticket-sweep` worker job — stale warning and pending-closure auto-close,
  every six minutes, with the warned flag in Redis rather than a column.
- `docs/TICKETS.md`, and rows in `COMMANDS.md`, `COMMAND_INVENTORY.md`,
  `ADMIN_BOT.md`, `WORKERS.md`.

**Still open in tickets.** `feedbackRating` is read by `averageRating` and shown
through the `{avgRating}` placeholder, but nothing writes it — there is no
rating prompt. It needs a repository write, a `CommunityService` method, a DM
prompt on close and `tkt:rate:<ticketId>:<n>` buttons. Until then `{avgRating}`
renders `—` everywhere, which is at least honest.

## Phase 15 — Events: what landed

**15a, reminders (`e29d473`).** The reminder path was dead: workers published
`event-reminder` onto `chan:bridge:{guildId}` and nothing subscribed. There is
now a third Redis bus in the family (`RedisBridgeBus`), a subscriber in the
bridge's composition, and `apps/bridge-bot/src/events.ts`, which posts the
notice into the guild's `events` channel pinging only the members who RSVP'd —
and nobody at all past fifty of them.

**15b, tracking (`43a5a0b`).** `EventScore` plus five columns on `Event`, the
`event-tracking` job, and `packages/jobs/src/event-tracking.ts`. Baselines are
written by the first poll after an event goes LIVE and never moved again; the
board scores *gains*, not readings.

**15c, the board.** One message per event in the `events` channel, posted once
and edited in place every thirty minutes, and edited one last time into a result
card when the event finishes rather than deleted. The work is split the way
`ticket-sweep` is: the `event-board` job knows which boards are stale, and
`apps/bridge-bot/src/event-board.ts` — the only process with a gateway — renders
and edits, reached over `POST /internal/g/<guildId>/event-board`. `boardFinal`
is the new column that makes the result card happen once. See `WORKERS.md
§2.7c`.

**Still to do in 15:** the panel events page (create/edit form, live leaderboard,
RSVP roster with an unlinked warning, result view) and attendance aggregation —
`EventRSVP` is still aggregated into nothing.

## Deploying this commit

The bridge bot now serves a loopback API of its own, so `.env` needs
`BRIDGE_API_PORT` (default 3012) — and `BRIDGE_API_URL` too if the bridge bot
does not share a host with the panel and the admin bot. Without
`INTERNAL_API_TOKEN` the bridge logs that panel publishing and `/tickets close`
are unavailable and starts anyway.

`npx prisma migrate deploy` before starting anything — the ticket rebuild drops
the `TicketCategory` *enum* and seeds its five values as rows, and Phase 15 adds
`EventScore` plus six columns on `Event`. Then the usual
order: Postgres and Redis, admin bot, workers, bridge bot, panel.

A fresh install still needs `/set-channel` before the relay speaks.

## Next session, in order

1. **Phase 15d** — the panel events page: the create/edit form (metrics, poll
   interval, channel target, Discord scheduled-event mirror), a live leaderboard
   per metric, the RSVP roster with its unlinked warnings, and the per-event
   result view. Then attendance aggregation, which feeds the profile card and a
   Phase 16 achievement family.
2. **Phase 16** — Milestones become achievements. `backfillMilestones` is the
   load-bearing piece; without it every existing member has zero on day one.
3. **Phase 17** — the `enabled` flag on command specs, retiring the run
   commands, and the `TICKET_MANAGE` capability.
4. **Part I Phase 11** — the XP page.
5. **Part II Phase C2** — bot reply and embed prose behind keys (waits on 17).
6. **Part IV** — the progression planner/tracker, plus the in-game prefix
   command visual overhaul.
7. **Part V** — the VPS→Discord health monitor and logger, then a security pass
   and a full stress test before the guild opens to the public.

The full plan lives at `~/.claude/plans/typed-dreaming-torvalds.md`.

## Open question

Everything since Part I Phase 1 has accumulated on `main`. Whether to move the
previous head (`59a874b`) onto a branch and rebase this work, or leave it linear
on `main`, is still undecided — it needs an answer before the next large commit,
not after.
