# Capture checklist

Phase 1 has one deliverable that cannot be written from a desk: a set of real
capture files showing which trigger actually fires for each dungeon state
change. This is the script for producing them.

Each run below produces one `logs/*.jsonl` file. Rename the ones worth keeping
into `fixtures/` with the suggested name and they become the evidence
`docs/EVENT_FINDINGS.md` is written from.

## Before you start

1. Install the module (see `README.md` in this folder) and restart ChatTriggers
   with `/ct load`.
2. Run `/sbrtrack status`. It should report the module version, `capture:
   stopped`, and — once you are in a SkyBlock lobby — `skyblock: true`. If it
   reports `skyblock: false` while you are demonstrably in SkyBlock, that is
   itself finding #1: record it and correct the patterns in `skyblock.js`.
3. Leave `streaming` off for the exploration sessions. Disk first, socket later;
   a capture you can reread beats a capture that went somewhere.

## Running a session

```
/sbrtrack start <label>     # begins capture, one file per session
/sbrtrack dump              # snapshot scoreboard + tab list at this instant
/sbrtrack stop              # flush and close the file
```

Use `/sbrtrack dump` liberally. The pollers only record *changes*, so a dump is
how you get a full picture at a moment you can describe afterwards. **Say what
you were doing in the label** — `f7-phase3-start` is a fixture, `test2` is not.

The single most valuable habit: **`/sbrtrack dump` immediately before and after
every transition you care about.** The diff between two dumps is the answer to
"which line changed when the floor changed".

## The sessions

Work down the list. Each row is one capture file.

| # | Label / fixture name | What to do | What we are trying to learn |
|---|---|---|---|
| 1 | `lobby-baseline` | Start capture in the SkyBlock hub. Stand still 60s. Open your inventory once. `/sbrtrack dump`. | The idle baseline. What fires when *nothing* is happening tells us what noise to expect in every other file. |
| 2 | `dungeon-entry` | Start capture in the hub. Dump. Enter the Catacombs entrance, join a party queue, and let the run start. Dump the moment you are in the dungeon. Stop. | Where does "a run started" appear — chat, scoreboard title, scoreboard line, tab list? Is there a distinct message for queue-joined vs run-started? |
| 3 | `f1-full-run` | A complete, cleared F1 from queue to score screen. Dump at: entry, first room cleared, boss entry, run end. | The whole lifecycle in one file at low difficulty. This is the skeleton every other fixture is compared against. |
| 4 | `f7-phase-transition` | An F7 (or M7) run. Dump immediately before and after **each** of the four Necron phases. | The hardest signal in the list. Phase changes may have no chat message at all — if so, note which scoreboard/tab line moves, and whether `verboseTriggers` sound or particle events are the only tell. |
| 5 | `secret-pickup` | Any floor. Dump, open one secret chest, dump. Repeat for a lever/wither-essence secret and a bat secret if you can. | Does the secret count live on the scoreboard, the tab list, or the action bar? Does opening a chest produce a `guiOpened` record with a usable title? Are the three secret *kinds* distinguishable? |
| 6 | `death` | Any floor. Die once. Dump before and after. | Chat message wording, and whether death is also visible as a state change (ghost mode) on the scoreboard or tab list. |
| 7 | `run-completion` | Clear a floor to the score screen. Do not leave until the score summary has fully printed. Dump on the score screen. Stop **after** leaving. | The full completion payload: score, time, secrets, deaths, per-player breakdown. This is the richest single moment in a run. |
| 8 | `run-failure` | Fail or leave a run early. If you can, capture both: a party wipe and a voluntary leave. | How a failure differs from a completion. A tracker that cannot tell them apart will silently record failures as runs. |
| 9 | `reconnect` | With a local backend running and `streaming on`, start a capture, kill the backend mid-run, bring it back 60s later. | That the queue holds, the backoff reconnects, and gameplay never stutters. Check `/sbrtrack status` for `dropped`. |

## Optional, if the above leaves gaps

- **`verbose-boss`** — set `"verboseTriggers": true` in `config.json`, reload, and
  run one boss fight. Expect a large file. Only worth doing if session 4 shows
  no reliable phase signal in the quiet triggers.
- **`class-milestone`** — a run where you level a dungeon class, if the level-up
  message turns out to be a distinct event.

## Turning a session into a finding

For each row of `docs/EVENT_FINDINGS.md`:

1. Open the `.jsonl` in an editor that can filter lines (or `grep '"ev":"chat"'`).
2. Find the record at the moment of the transition.
3. Copy the **exact raw string**, formatting codes included — `raw` in the record,
   not `text`. The formatting codes are frequently the only thing distinguishing
   two otherwise identical lines.
4. Write the pattern, then confirm it against a *second* fixture before marking
   it verified. One observation is an anecdote.

Anything you could not capture stays in the table marked `UNVERIFIED` with a note
saying why. An honest gap is useful; a guessed regex that silently never matches
is worse than nothing.
