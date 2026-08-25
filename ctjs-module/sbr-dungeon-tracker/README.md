# sbrDungeonTracker

A ChatTriggers module that watches your own Minecraft client during SkyBlock
dungeon runs and writes what it sees to a log file — and, if you turn it on,
streams it to an SBR ingest server.

This is a **Phase 1 exploration harness**. Its job is to find out what data is
actually available client-side. It has no dashboard, stores nothing permanently,
and its output is a raw event log for a human to read.

## What it does and does not do

- **No Hypixel API calls.** Everything here is read from your own client: chat,
  scoreboard, action bar, tab list, world events. The module has no API key.
- **No automation.** It sends no commands, clicks nothing, warps nowhere. It
  reads, and it writes a log.
- **Only you.** Nothing about any other player is requested. What is captured is
  your client's own view.
- **Off until you say otherwise.** A fresh install captures nothing and connects
  nowhere until you run `/sbrtrack start`. Streaming is a second, separate
  switch in `config.json`.

If you turn streaming on, the events go to a server SBR staff can read. That is
the point of it, and it is worth knowing before you flip the switch. The URL is
in `config.json` and is yours to change or blank out; uninstalling the module
ends it completely.

## Install

1. Install [ChatTriggers](https://www.chattriggers.com/) for your Minecraft
   version.
2. Copy this folder into `.minecraft/config/ChatTriggers/modules/`. From the repo
   root, `npm run ctjs:dev` does that for you (see the root `README.md`).
3. In Minecraft, run `/ct load`.
4. Run `/sbrtrack` — you should get a list of commands.

> **First-load check:** the folder must be named `sbr-dungeon-tracker`. The
> module *identifies* itself as `sbrDungeonTracker` in `metadata.json`, but the
> log files are written to the folder name. If they disagree, captures land
> somewhere unexpected — `/sbrtrack status` prints the path it is writing to.

## Commands

| Command | Effect |
|---|---|
| `/sbrtrack start [label]` | Begin a capture session. One file per session under `logs/`. |
| `/sbrtrack stop` | Flush to disk and close the file. |
| `/sbrtrack dump` | Snapshot the scoreboard and tab list into the log right now. |
| `/sbrtrack status` | What is running, what has been captured, where it is streaming. |
| `/sbrtrack stream on\|off` | Toggle forwarding for this session only. |

## Configuration

`config.json`, in this folder:

| Key | Default | Meaning |
|---|---|---|
| `ingestUrl` | `ws://localhost:8080/ingest` | Where streaming sends events. Change it or leave it local. |
| `streaming` | `false` | Forward events over the socket. Disk-only when false. |
| `captureOnLoad` | `false` | Start capturing the moment the module loads. |
| `verboseTriggers` | `false` | Also register tick/sound/particle. Very noisy; see the checklist. |
| `debugChat` | `false` | Print a chat line per captured event. A last resort. |

## Files

| File | Role |
|---|---|
| `index.js` | Wiring, the `/sbrtrack` command, the socket gate. |
| `triggers.js` | The exploration harness: what is registered and what is recorded. |
| `capture.js` | Buffered JSON-lines writer. One file per session. |
| `socket.js` | The WebSocket client, over the JDK client via Java interop. |
| `queue.js` | Bounded outbound queue; drops oldest on overflow. |
| `skyblock.js` | The "are we in SkyBlock" gate the socket depends on. |
| `settings.js` | Reads `config.json` over defaults. |
| `safe.js` | Turns arbitrary Java/JS values into something safe to serialise. |
| `CAPTURE_CHECKLIST.md` | The manual capture sessions to run. |
| `docs/EVENT_FINDINGS.md` | What each trigger actually fires for. Currently all unverified. |
| `fixtures/` | Labelled captures worth keeping. |
| `logs/` | Raw session output. Not committed. |

## Backend

The server side lives in `packages/client-ingest` and mounts at `/ws/ingest` on
the web panel. See `docs/CLIENT_INGEST.md` at the repo root for the handshake,
the message shapes, and how to run one locally.
