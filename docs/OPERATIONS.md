# Operations

How the platform tells you it is unwell, and what to do when it does.

The web panel's **Health** page already shows everything below. This document is
about the case the page cannot cover: nobody is looking at it, or the panel is
the thing that is down. Both of those are answered in Discord.

---

## 1. What runs

Four processes, each beating into Redis every 15 seconds under a 45-second TTL:

| Service | What it is | Dies quietly if… |
| --- | --- | --- |
| `bridge-bot` | The member-facing Discord app (SBR Bot / SBR Bridge) and the Hypixel relay | the Minecraft account is kicked or the gateway drops |
| `admin-bot` | Staff commands, automated writes, the internal API, this watchtower | its token is rotated |
| `workers` | Scheduled jobs — snapshots, event tracking, ticket sweeps | its Redis connection wedges |
| `web-panel` | The staff web UI and OAuth | its port is taken |

A beat is a Redis key with a TTL, so a dead process stops beating without having
to notice it is dying. That is the point: a crashed service cannot be relied on
to report its own crash.

---

## 2. Two channels

Both are raw Discord channel ids in `.env`, deliberately *not* configured
through the panel's channel slots:

```
OPS_ALERT_CHANNEL_ID=      # fleet up/down transitions
OPS_ERROR_CHANNEL_ID=      # batched error log lines (falls back to the alert channel)
```

The reason for raw ids is the failure they exist to report. Slot configuration
lives in Postgres; the alert that matters most is the one sent *while the
database is unreadable*, and a channel id that has to be looked up in the
database is no use then. These two are read from the environment at boot and
held in memory.

Neither is required. Unset, the watchtower still computes its passes and the
logger still writes to the process log — you simply get no Discord copy, and a
warning line at boot saying so.

---

## 3. The watchtower

`apps/admin-bot/src/watchtower.ts`, running every 60 seconds inside the admin bot.

Each pass reads every live heartbeat and runs the infrastructure probes
(Postgres, Redis) this process can run itself, and rolls them into one status:

- **ok** — everything beating, every probe healthy.
- **degraded** — one service silent, or a probe unhealthy but not down.
- **down** — a probe reports *down*, or two or more services are silent.

Infrastructure outranks silence on purpose: a bot that cannot reach Postgres is
usually the cause, and a silent worker the symptom.

Two rules keep the channel worth reading:

- **Edge-triggered.** It posts when the status *changes*. A channel that says
  "still down" every minute is a channel people mute, and a muted alarm is worse
  than no alarm. Recovery gets its own message (`✅ Fleet recovered`) so you know
  the incident closed without going to look.
- **A grace pass.** A bad reading has to happen twice in a row before anything is
  said. One missed beat is a restart, a GC pause, or a slow Redis — paging on it
  teaches people to ignore the channel.

It lives in the admin bot because it is automated, staff-facing work, and that
bot already holds a gateway connection to the staff server. Ops chatter has no
business on the member-facing application.

**What it cannot see:** the admin bot itself being dead. Nothing in-process can
report its own death. That case shows up as this bot going silent — visible on
the Health page, and to anyone whose staff commands stop answering.

### Reading an alert

```
🔴 Fleet down
Silent: workers, web-panel
postgres: down — ECONNREFUSED
```

`Silent:` means no beat inside 90 seconds (three missed beats). Named components
are the probes. Work top-down: infrastructure first, because a silent service
with a dead database underneath it will come back on its own once the database
does.

---

## 4. The error shipper

`packages/observability/src/shipper.ts`, wired into the admin bot's logger as a
second destination for records at `error` and above. The console log is
unchanged — this is a copy, not a redirect.

Three things make a naive "post every error to Discord" a bad idea, and the
shipper answers all three:

- **Volume.** One broken dependency emits the same line hundreds of times a
  minute. Identical messages inside a 30-second window collapse to one entry with
  a count, so a storm reads as `×412` rather than as 412 messages.
- **Rate limits.** Discord's are per-channel. A logger that trips them makes
  every *other* thing the bot wants to say late, so the shipper posts at most
  once per window, on its own timer, never on the logging call itself.
- **Recursion.** A failed post must not log an error that queues another post.
  Post failures are swallowed; the console line was already written.

A batch looks like:

```
admin-bot — 63 log records
[error] guild fetch failed ×61 — ECONNRESET
[error] ticket channel could not be created ×2
```

Only the `error` field rides along on the line. A whole serialised field bag per
line would bury the message it exists to explain, and the full record is in the
process log either way.

The last batch is flushed during shutdown, before the gateway closes — the
errors that explain a crash are the ones logged in the seconds before it.

**Scope, stated plainly:** only the admin bot ships. The bridge bot and workers
log to their own process logs and are visible in the watchtower only as beats.
Routing their errors here would mean either the member-facing application posting
into a staff channel — which the bot-ownership rule forbids — or a new internal
API hop. Neither is built. `journalctl -u sbr-bridge-bot` remains the way to read
bridge errors.

---

## 5. When something fires

1. **Check the Health page** if the panel is up. It has the detail the alert
   compresses away — per-check latency, last job runs, gateway ping.
2. **Silent service, everything else ok.** Almost always that process. Restart
   it; the beat comes back inside 15 seconds and the recovery message follows on
   the next pass.
3. **Postgres or Redis down.** Everything downstream is noise until it is back.
   Expect a run of silent services shortly after, and a single recovery message
   once they reconnect.
4. **`bridge-bot` silent but Discord commands still work.** The gateway and the
   Minecraft relay are separate connections; the beat covers the process. A
   process alive but relaying nothing shows on the Health page's `discordReady`
   and gateway-ping fields, not here.
5. **Nothing in the channel and something is clearly wrong.** Check
   `OPS_ALERT_CHANNEL_ID` is set and that the admin bot can post in it — the
   watchtower logs `watchtower alert did not land` when a post is refused, and
   then stays quiet rather than retrying into a rate limit.

---

## 6. Deliberate silences

Things that are *not* alerts, so they do not wake anyone:

- A single missed beat (the grace pass).
- A repeat of a status already reported.
- A recovery from a state that was never announced — a degraded first pass at
  boot resolves without a message.
- A service outside `WATCHED_SERVICES`. Absence from that list is not an alert.
- A failed alert post. It is logged, never retried and never escalated: the alert
  path is the thing that just failed.
