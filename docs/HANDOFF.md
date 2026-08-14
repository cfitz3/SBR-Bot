# Handoff — 14 August 2026

Where the build stands, what is safe to run in production right now, and what
the next session picks up. Written at a deliberate stopping point: the tree
builds, the suite is green, and nothing half-wired is reachable without saying
so out loud.

## State

- **Build**: `npx tsc -b` and `npm run build -w @sbr/app-web-panel` both exit 0.
- **Tests**: `npm test` — 1374 pass, 0 fail.
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

**Not landed, and visibly so.** The Discord half:

- `apps/bridge-bot/src/tickets.ts` — panel publishing, the
  `tkt:new|claim|close|closereq|feedback` component namespaces, channel creation
  with permission overwrites, question modals, message capture, log-channel
  notices.
- Admin `/tickets list|view|close|transcript`.
- The `ticket-sweep` worker job (stale warning, pending-closure auto-close).
- `docs/TICKETS.md`.

Because `ticketEffects` is not wired into the panel's composition, **Publish**
and **Re-send transcript** answer *"No bot is connected to post the panel"*
rather than appearing to work. That is the intended state for this commit: the
configuration surface is usable, and the two actions that need a gateway say why
they cannot run. Nothing silently no-ops.

## Deploying this commit

`npx prisma migrate deploy` before starting anything — the ticket rebuild drops
the `TicketCategory` *enum* and seeds its five values as rows. Then the usual
order: Postgres and Redis, admin bot, workers, bridge bot, panel.

A fresh install still needs `/set-channel` before the relay speaks.

## Next session, in order

1. **Finish Phase 14** — the four items above. The bridge side copies the LFG
   publish-then-edit pattern at `apps/bridge-bot/src/transport.ts:149-190`.
2. **Phase 15** — Events configurable, deployable, trackable. Start with the
   dead reminder path: `apps/workers/src/jobs.ts` publishes `event-reminder`
   onto a channel nothing subscribes to.
3. **Phase 16** — Milestones become achievements. `backfillMilestones` is the
   load-bearing piece; without it every existing member has zero on day one.
4. **Phase 17** — the `enabled` flag on command specs, retiring the run
   commands, and the `TICKET_MANAGE` capability.
5. **Part I Phase 11** — the XP page.
6. **Part II Phase C2** — bot reply and embed prose behind keys (waits on 17).
7. **Part IV** — the progression planner/tracker, plus the in-game prefix
   command visual overhaul.
8. **Part V** — the VPS→Discord health monitor and logger, then a security pass
   and a full stress test before the guild opens to the public.

The full plan lives at `~/.claude/plans/typed-dreaming-torvalds.md`.

## Open question

Everything since Part I Phase 1 has accumulated on `main`. Whether to move the
previous head (`59a874b`) onto a branch and rebase this work, or leave it linear
on `main`, is still undecided — it needs an answer before the next large commit,
not after.
