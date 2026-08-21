# Handoff — 20 August 2026

Where the build stands, what is safe to run in production right now, and what
the next session picks up. Written at a deliberate stopping point: the tree
builds, the suite is green, and nothing half-wired is reachable without saying
so out loud.

## State

- **Build**: `npx tsc -b` and `npm run build -w @sbr/app-web-panel` both exit 0.
- **Tests**: `npm test` — 1532 pass, 0 fail, 1 skipped (a POSIX file-mode
  assertion that cannot hold on Windows).
- **Brand checker**: `npm run brand check` clean; 80 command descriptions within
  Discord's cap, 43 theme tokens all with fallbacks, 63 gallery cards with no
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

**15d, the panel page.** `apps/web-panel/client/pages/events.ts` grew an edit
card (title, start, capacity, description, tracked metrics, poll interval,
progression flag) that submits as a unit through `event.update`, a scoreboard
card with one column per tracked metric and the list of people going who have no
verified account for the tracker to poll, "Update board now" (`event.board.publish`,
through the bridge's loopback API), and "Mark as run" (`event.complete`). Rows in
the history table open the same two cards, which is the result view. Behind it:
`CommunityService.updateEvent` / `completeEvent`, `CommunityRepository.updateEvent`,
`PanelReads.eventStandings`, and a widened `PanelEvent`. `WEB_PANEL.md §3.8`.

Two decisions worth keeping: editing and finishing pass `isStaff: true` because
reaching those mutations already required Officer, while `event.cancel` still
refuses anyone but the host — calling an event off is the host's call in a way
that fixing its start time is not. And un-ticking a metric hides its scores
rather than deleting them, so it is reversible.

**15e, attendance.** `EventAttendance` is a new table keyed by
`(eventId, discordId)` with a `source` of `TRACKED` or `MARKED`. Completing an
event seeds it from `EventScore` — everyone the poller saw — and the events page
grows a turnout card that shows those as fact and offers a tick box for everyone
else, saving through `event.attendance` (Officer). `CommunityService.markAttendance`
replaces the `MARKED` rows wholesale and never touches a `TRACKED` one: the
poller watched the event and the person ticking boxes is remembering it. The
attendance embed leads with "Turned up" once there is an answer.

The reason it is its own table rather than a flag on `EventRSVP`: attendance is
not a subset of the roster. A walk-in who never touched the buttons was still
there, and a "going" who never showed was not.

**Still to do in 15:** nothing. The attendance *report* and the aggregate that
counts it wait on Phase 16, which is what would count against them.

## Deploying this commit

The bridge bot now serves a loopback API of its own, so `.env` needs
`BRIDGE_API_PORT` (default 3012) — and `BRIDGE_API_URL` too if the bridge bot
does not share a host with the panel and the admin bot. Without
`INTERNAL_API_TOKEN` the bridge logs that panel publishing and `/tickets close`
are unavailable and starts anyway.

`npx prisma migrate deploy` before starting anything — the ticket rebuild drops
the `TicketCategory` *enum* and seeds its five values as rows, and Phase 15 adds
`EventScore` plus six columns on `Event`, and Phase 15e adds `EventAttendance`. Then the usual
order: Postgres and Redis, admin bot, workers, bridge bot, panel.

A fresh install still needs `/set-channel` before the relay speaks.

## Next session, in order

Phases 16, 17, Part I Phase 11, Part II Phase C2 and Part IV have all shipped.
What is left:

1. **Part V** — the VPS→Discord health monitor and logger, then a security pass
   and a full stress test before the guild opens to the public.
2. **The deep bug sweep** — every segment of the repo, fixes applied and the
   rest flagged.

### Part IV, as built

`/progress` gained a per-day pace line and came back off the retired list: it
had gone dark with the advice engine, but it never read the auction house the
advice engine relied on — it charts our own `ProfileSnapshot` rows.

`/goal` is new. One target per member per metric (`ProgressionGoal`, unique on
`(guild, account, metric)`), because a goal is a current intention rather than a
ledger; the record of *reaching* one belongs in `Milestone`. Projections are the
plainest defensible arithmetic — recent pace over a 14-day window, extended —
and the card's footer says exactly that.

`sweepGoalsOnce` (`apps/bridge-bot/src/goals.ts`, hourly) compares unachieved
goals against the freshest snapshot and posts to the `milestones` channel. It
stamps a reached goal whether or not the post lands: the fact lives on the row
and the member sees it on `/goal`, unlike a milestone whose only record is the
post.

In-game replies were rewritten around `copy.embed.ingame`: field names are
abbreviated (`SBL`, `Cata`, `NW`), emoji and zero-width padding are stripped,
and truncation breaks on a separator rather than mid-word. The zero-width
`padInlineRow` spacers had been leaking an invisible `​: ​` into guild chat and
spending characters from the 252-char budget.

The full plan lives at `~/.claude/plans/typed-dreaming-torvalds.md`.

## Open question

Everything since Part I Phase 1 has accumulated on `main`. Whether to move the
previous head (`59a874b`) onto a branch and rebase this work, or leave it linear
on `main`, is still undecided — it needs an answer before the next large commit,
not after.
