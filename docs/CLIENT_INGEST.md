# Client ingest

A second source of Skyblock data, coming from the opposite direction to the
first. Everything else in this platform learns about members by asking Hypixel's
HTTP API. This route learns by having a member's own Minecraft client tell us
what it sees — chat lines, the scoreboard, the action bar — over a WebSocket to
the web panel.

This is **Phase 1**. It exists to find out what is actually observable
client-side and to prove the pipe works end to end. Nothing is persisted, no
dashboard reads it, and the schema a real feature would need has deliberately not
been designed yet, because designing it before seeing real captures is how you
get the wrong one.

- The client half is [`ctjs-module/sbr-dungeon-tracker`](../ctjs-module/sbr-dungeon-tracker/README.md).
- The server half is `packages/client-ingest`, mounted by `apps/web-panel`.

---

## Consent posture

Worth stating plainly, because this is the one part of the platform where data
leaves a member's own machine because they chose to send it.

**Opt-in by installation.** Nothing here happens to a member who does not
install the module. There is no server-side switch that turns it on for someone,
no auto-installer, and no bot command that starts a capture on another person's
client. Installing it is the consent.

**Off until asked, twice.** A freshly installed module captures nothing and
connects to nothing. Capture starts on `/sbrtrack start`. Streaming to the
backend is a *separate* switch, `/sbrtrack stream on`. Local capture with
streaming off is a supported way to use it — the JSONL stays on their disk and
they can read it before deciding whether to send anything.

**Self only.** The module reads the local client's own state. It does not read,
infer, or forward anything about other players, including party members in the
same dungeon.

**Revocable, and revocation is complete.** `/sbrtrack stream off` stops the
stream; deleting the module folder ends it entirely. Because Phase 1 writes
nothing to Postgres, there is no stored history to request deletion of — the
in-memory ring is bounded and gone on the next panel restart.

**Visible to staff.** The events go to a server SBR staff can read, via the debug
route below. That is the point of the phase and it is said out loud in the
module's own README, so nobody flips the switch without knowing it.

**Not a Hypixel API client.** No code path in the module or in
`packages/client-ingest` makes a Hypixel HTTP request. This route is entirely
separate from `packages/hypixel` and is not governed by the constraints in
[`HYPIXEL_COMPLIANCE.md`](./HYPIXEL_COMPLIANCE.md) — but it is also not a way
around them, because it observes only what the player themselves can see on
their own screen.

---

## The route

```
ws://<panel-host>:<WEB_PANEL_PORT>/ws/ingest
```

Mounted on the panel's existing HTTP server via `server.on("upgrade")`, not on a
port of its own — the panel already has TLS, timeouts and a shutdown path
working, and a second listener would mean a second set of all of that to get
right and a second thing to firewall.

There is no dependency behind it. The panel is a zero-dependency `node:http`
server and one WebSocket route was not a good enough reason to make that untrue,
so RFC 6455 framing is hand-rolled in `packages/client-ingest/src/frames.ts`. The
decoder is a pure bytes-in/frames-out function, which is what makes the ugly
cases — a frame split across three TCP chunks, an unmasked client frame, a
declared length of four gigabytes — testable offline with a Buffer.

## Handshake

A standard WebSocket upgrade. `Sec-WebSocket-Version: 13` is required; anything
else is refused with `426 Upgrade Required` before a socket is taken over.

Then the client must identify itself, **first message, no exceptions**:

```json
{ "type": "hello", "mcUsername": "Steve", "moduleVersion": "0.1.0" }
```

The server resolves `mcUsername` through the identity package. A username that
does not resolve to a linked guild member is closed with `4401` and nothing it
sent is recorded. There is no anonymous or unlinked mode.

On success:

```json
{ "type": "hello_ok", "memberId": "1234...", "ign": "Steve", "serverTime": 1730000000000 }
```

Note that `ign` in the reply is the **linked** IGN from our records, not the
string the client sent. If a member has changed their name, the reply is how they
find out which identity their events are being filed under.

A second `hello` on the same connection is a protocol error (`1002`). Allowing
one would let a connection change whose data it is halfway through.

## Events

```json
{
  "type": "raw_event",
  "eventName": "chat",
  "timestamp": 1730000000000,
  "seq": 41,
  "session": "2026-08-22T18-04-11",
  "payload": { "raw": "§r§6★ ...", "clean": "★ ..." }
}
```

`eventName` and `payload` are whatever the client captured. Phase 1 does not
interpret them — that is the entire point, and constraining the shape now would
constrain what we can discover.

**Batching.** The module sends events wrapped in an envelope:

```json
{ "type": "raw_batch", "count": 2, "events": [ /* raw_event objects */ ] }
```

This is a deviation from the original single-message shape, forced by the client
side: `java.net.http.WebSocket.sendText` throws if a previous send has not
completed, so the module keeps exactly one send in flight and drains its queue
into one message per pump. Each element keeps the exact `raw_event` shape, and
the server accepts a lone `raw_event` too — a hand-written test client can send
one message at a time and it will work.

One malformed event does not discard the batch. The rest are recorded and the
bad one is logged, because a batch is a transport detail and losing 99 good
events to one is the wrong trade.

## Close codes

| Code | Meaning |
|---|---|
| `1000` | Normal. |
| `1001` | The panel is shutting down. |
| `1002` | Protocol error — reserved bits, an unmasked client frame, a second hello. |
| `1003` | A binary or fragmented frame. The protocol is JSON text. |
| `1009` | A frame past the 1 MiB limit. |
| `1011` | The identity lookup failed on our side. Retrying later is reasonable. |
| `4400` | No valid `hello`, or something else was sent first, or the handshake timed out (15s). |
| `4401` | `mcUsername` is not linked to a guild member. **Retrying will not help.** |
| `4429` | Too many messages — more than 240 in 10 seconds. |

`4401` is the one worth handling specially in a client: it means *link your
account in Discord*, not *back off and try again*.

## What the server does with an event

Two things, both temporary:

1. **A structured log line per event**, tagged with the resolved `memberId` and
   `ign` — `client ingest raw_event`. This is Phase 1's actual record.
2. **A bounded in-memory ring**, the last 200 events per member and at most 200
   members, LRU-evicted. Not storage: it exists so there is somewhere to look
   while confirming events arrive, and it is lost on restart by design.

Nothing is written to Postgres or Redis. `packages/client-ingest` imports neither.

## Debug endpoint

```
GET /debug/ingest              → { sessions, members }
GET /debug/ingest/:memberId    → { memberId, ign, events, received, dropped, lastSeenAt }
```

Both require a panel session whose Discord account holds the `ADMIN` capability
in a guild it manages. `?limit=` clamps to 1–200, default 50. Events come back
newest first, because whoever is reading is checking whether the thing they just
did in game showed up.

A member with no events returns `null` rather than a 404 — "nothing has arrived
from this member" is an answer, and it is a different answer from "that route
does not exist".

## Testing it locally

```bash
npm run build
npm run dev                    # starts every app, panel included
npm run doctor                 # the "Client ingest" section probes /ws/ingest
```

The doctor probe only runs when `WEB_PANEL_SCHEME=http`, since it speaks
plaintext; over TLS it reports a skip rather than a red mark it cannot justify.

Then install the module and point it at the panel:

```bash
npm run ctjs:dev               # set CTJS_MODULES_DIR in .env first if needed
```

Set `ingestUrl` in the installed copy's `config.json` to
`ws://127.0.0.1:3000/ws/ingest` (matching `WEB_PANEL_PORT`), then in game:

```
/sbrtrack start
/sbrtrack stream on
/sbrtrack status
```

`status` reports the socket phase and the queue depth, which is the fastest way
to tell a wrong URL from an unlinked account: a wrong URL never leaves
`connecting`, an unlinked account reaches `open` and then closes with `4401`.

Without Minecraft, the framing and session behaviour are covered offline:

```bash
node --test "packages/client-ingest/dist/**/*.test.js"
```

## What is not here yet

Persistence, any schema for dungeon runs, aggregation, dashboards, export, and
any reading of other players' data. Those are later phases and each one is a
decision to make with real captures in hand — see
[`EVENT_FINDINGS.md`](../ctjs-module/sbr-dungeon-tracker/docs/EVENT_FINDINGS.md),
which is the document that has to stop saying `UNVERIFIED` before any of it is
worth building.
