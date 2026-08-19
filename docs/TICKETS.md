# Tickets

The support system: a panel a member presses, a private channel with the right
staff already in it, a transcript when it closes, and a queue staff can work
from Discord or the web panel without either one becoming the source of truth.

This document is the map. The rules themselves live in `packages/tickets`, and
every one of them is unit tested there — if this file and that package ever
disagree, the package is right.

## 1. The shape of it

```
                      ┌─────────────────────┐
  member presses ───► │  bridge bot         │  the only process with a gateway
  a panel button      │  tickets.ts         │  to the community server
                      │  tickets-discord.ts │
                      └──────────┬──────────┘
                                 │ CommunityService
                      ┌──────────▼──────────┐
                      │  Postgres           │  Ticket, TicketMessage,
                      │                     │  TicketSettings/Category/Panel/Tag
                      └──────────▲──────────┘
             reads directly      │       reads directly
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
  ┌─────┴──────┐          ┌──────┴──────┐          ┌──────┴──────┐
  │ web panel  │          │ admin bot   │          │ workers     │
  │ Tickets pg │          │ /tickets    │          │ ticket-sweep│
  └─────┬──────┘          └──────┬──────┘          └──────┬──────┘
        └──────── loopback ──────┴──── HTTP ──────────────┘
                 POST /internal/g/<guildId>/ticket-*  →  bridge bot
```

**Everything that reads goes to the database.** All four processes share the
tables, so the queue on the panel, `/tickets list` in the admin server, and the
bridge bot's own view are the same rows, never a cache of each other.

**Everything that touches Discord goes to the bridge bot**, over the loopback
API in `apps/bridge-bot/src/internal-api.ts`. Posting a panel, closing a ticket
(which disposes of its channel), re-sending a transcript and sweeping a quiet
ticket all need a gateway connection to the community server, and exactly one
process has one. The three clients are:

| Caller | File | Behaviour on failure |
| --- | --- | --- |
| Web panel | `apps/web-panel/src/ticket-effects.ts` | **Throws.** The message reaches the operator verbatim. |
| Admin bot | `apps/admin-bot/src/ticket-bridge.ts` | Returns words. A staffer is waiting on a slash command. |
| Workers | `apps/workers/src/ticket-bridge.ts` | Returns null and logs. Nobody is waiting; the next pass retries. |

They differ only in that column, and the difference is deliberate: a panel that
reports "published" with no message in the channel is the exact bug this rebuild
exists to remove, so the panel's client is the one that fails loudly.

## 2. Configuration

Four tables, all edited from the panel's **Tickets** page (`Queues → Tickets`),
which is five cards: **Queue**, **Categories**, **Panels**, **Tags**,
**Settings**.

### `TicketSettings` — one row per guild

Colours (primary / success / error), the footer, `archiveEnabled`,
`logChannelId`, `blocklistRoleIds`, working hours, and the two clocks:

- **`staleAfterMinutes`** — silence after which a ticket counts as pending
  closure. Null disables the stale path entirely; a standing close request still
  counts as pending regardless.
- **`autoCloseAfterMinutes`** — how long a pending ticket has before the sweep
  closes it. Defaults to 720 (12 h).

`closeButton` and `claimButton` decide which controls appear on the ticket's
opening message.

### `TicketCategory` — the menu

Five are seeded on install (`SUPPORT`, `REPORT`, `APPEAL`, `APPLICATION`,
`OTHER`) and a guild may add, rename, reorder or disable any of them. Per
category: the Discord parent channel, `channelNameTemplate`, staff roles pulled
into the channel, required roles, ping roles, the opening message, claiming on
or off, a cooldown, a member limit and a total limit, slow mode, whether a topic
is required, and up to five questions asked in a modal before the channel is
made.

The caps in `CATEGORY_LIMITS` are Discord's, not ours: 100 characters of
description (select-menu truncation), 5 questions (a modal takes five inputs),
5 buttons per row, 25 select options, 50 channels under one parent.

### `TicketPanel` — the thing members press

A channel, a title and description, an optional image, a style (`BUTTONS` or a
select menu — `suggestedStyle` picks by category count), and the category keys
it offers. Publishing edits the existing message if there is one and posts a new
one otherwise, then records the new message id. A panel whose category list
names something that no longer exists refuses to render rather than posting a
menu with a dead option.

### `TicketTag` — canned replies, matched by name or pattern.

## 3. Opening a ticket

A press on a panel control carries everything it needs. `tkt:new:<categoryKey>`
is a button; `tkt:pick:<panelId>` is the menu, with the category arriving in
`interaction.values`. Both are built rather than stored, so **a panel posted
last month still works** — there is no per-message state to expire.

Order of operations, which is asserted in `apps/bridge-bot/src/tickets.test.ts`
rather than left to chance:

1. **Eligibility** (`evaluateEligibility`) — `BLOCKED`, `CATEGORY_DISABLED`,
   `MISSING_ROLE`, `MEMBER_LIMIT`, `TOTAL_LIMIT`, `COOLDOWN` (with the seconds
   left), `CLOSED_HOURS` (with when staff are next open, in the guild's zone).
   A refusal is a sentence, not a code.
2. **Questions**, if the category has any — a modal, which must be the *first*
   response to the interaction because Discord will not accept one after a
   defer.
3. **The row**, then **the channel**, then **the binding**. In that order: a
   channel created before its row is a channel with no ticket behind it, and a
   row whose `channelId` never lands is a ticket nobody can find. If channel
   creation fails, the member is told so and the row is not left pretending.
4. **The opening message**, with the category's staff roles pinged and the
   controls from `ticketControls`.

## 4. Working a ticket

| Control | Who | What it does |
| --- | --- | --- |
| `tkt:claim` / `tkt:release` | staff | Takes or gives up the ticket. The note is **public** — a claim nobody else can see is how two staff answer the same ticket. |
| `tkt:close` | staff | Opens a modal. The confirmation step and the only place a close reason is typed. |
| `tkt:closereq` | the opener | Asks. Marks the ticket pending closure rather than closing it. |

Every mutating operation takes a `TicketActor` and passes `canAct`, which
permits the opener or staff and nobody else. `isStaff` fails **closed**: if the
member's roles cannot be read, the answer is "not staff".

Messages in a ticket channel are captured into `TicketMessage` as they arrive,
including edits and deletions. The cheap check comes first — one indexed lookup
by channel id — so nothing happens for the 99.9% of messages that are not in a
ticket. A message counts as a staff reply only if it is not from a bot and not
from the opener, which is what stops the bot's own greeting from recording a
response time of zero.

## 5. Closing, transcripts and archiving

Closing writes the row, renders the transcript, DMs it to the opener, posts a
notice in the log channel, and only then disposes of the channel. That order
matters: a channel deleted before the row is written is a conversation with no
record of why it ended.

A DM that bounces (closed DMs are the ordinary case, not an error) becomes a log
line and a note for staff — the transcript is still on the panel, and
**Re-send transcript** will try again. The re-send reads the recipient from the
ticket and never from the caller: a caller naming the recipient is a way to mail
somebody else's conversation to themselves.

`archiveEnabled` decides what happens to the channel. Off, it is deleted. On, it
is renamed `closed-…` and locked — staff can still find it, nobody can add to a
conversation whose transcript has already gone out.

## 6. The sweep

`ticket-sweep`, every six minutes (`5-59/6 * * * *`, timely lane). See
`WORKERS.md §2.9c`.

The decision is `sweep()` in `packages/tickets/src/lifecycle.ts`:

- Not pending closure → `NONE`.
- Pending, and quiet for longer than `autoCloseAfterMinutes` → `AUTO_CLOSE`.
- Pending, not yet that long, not yet warned → `WARN_STALE`.

"Pending" means a standing close request with fewer than
`RESUME_MESSAGE_COUNT` (5) messages since — five messages means the conversation
resumed and the request lapsed — or silence past `staleAfterMinutes`. The clock
runs from whichever event made it pending, never from creation, or long healthy
conversations would close.

The worker walks the guilds and holds the "already warned" flag in Redis with a
24-hour TTL; the bridge bot decides and acts, one call per ticket. The flag is
not a database column because it describes a notification rather than a ticket,
and its worst failure — a warning repeated after a restart — is milder than a
migration for a boolean that expires on its own.

## 7. Command surface

**Members**, in the community server (`/ticket`, `packages/commands-bridge`):

| Action | Notes |
| --- | --- |
| `open` | `type` is autocompleted, not a fixed choice list — categories are per-guild and editable, and slash-command choices are frozen at registration. |
| `list` | Their own tickets only. |
| `close` | **Their own only.** This is the member surface and it takes an arbitrary id, which is precisely how any member could close anyone's ticket before the rebuild. |

**Staff**, in the admin server (`/tickets`, `MODERATOR`):

| Action | Where it runs |
| --- | --- |
| `list` | Database. The open queue, newest first. |
| `view` | Database. Accepts `#12`, `12`, or an opaque id — and refuses an id belonging to another server. |
| `close` | Bridge. Needs to dispose of a channel this bot cannot see. |
| `transcript` | Bridge. Rendered from the archive with the opener's tag resolved, returned as a file attachment. |

**Panel**: the Queue card claims, transfers, closes and re-sends; Categories,
Panels, Tags and Settings are `ADMIN`, the queue actions `MODERATOR`.

## 8. Statistics

`statsFrom` feeds the `{avgRating}`, `{avgResponseTimeMs}` and
`{avgResolutionTimeMs}` placeholders from a window of recent tickets — all
statuses, because resolution time and rating only exist on a closed one.

Two deliberate nulls, both rendering as `—` rather than zero: a ticket with no
staff reply is *excluded* from the response-time average rather than counted as
instant (including them would make an ignored queue look fast), and an unrated
ticket is excluded from the rating.

> **Known gap.** `feedbackRating` is read by `averageRating` and surfaced
> through `{avgRating}`, but **nothing writes it** — there is no rating prompt
> yet. Closing that loop needs a repository write, a `CommunityService` method,
> a DM prompt on close, and `tkt:rate:<ticketId>:<n>` buttons. Until then
> `{avgRating}` renders `—` on every guild.

## 9. Where things are

| Concern | File |
| --- | --- |
| Rules (eligibility, lifecycle, naming, panel, tags, transcript) | `packages/tickets/src/` |
| Persistence | `packages/db/src/repositories/tickets.ts`, `ticket-config.ts` |
| Gateway (no discord.js in it) | `apps/bridge-bot/src/tickets.ts` |
| Discord adapter, `tkt:` routing | `apps/bridge-bot/src/tickets-discord.ts` |
| Loopback API | `apps/bridge-bot/src/internal-api.ts` |
| Member command | `packages/commands-bridge/src/handlers-community.ts` |
| Staff command | `packages/commands-admin/src/handlers.ts` |
| Panel page | `apps/web-panel/client/pages/tickets.ts` |
| Panel mutations | `packages/panel-core/src/mutations.ts` |
| Sweep job | `packages/jobs/src/tickets.ts`, `apps/workers/src/jobs.ts` |
