# Event findings

Which ChatTriggers trigger actually fires for each dungeon state change, the
exact patterns needed to recognise it, and what to fall back on when it does not
fire.

> **Status: no live captures yet.** Every pattern below is marked `UNVERIFIED`.
> They are candidates to test against a real client, not observations — the
> whole point of Phase 1 is to replace them with strings copied out of a fixture.
> Nothing in this file should be treated as known until its row says `VERIFIED`
> and names the fixture it came from.
>
> Follow `../CAPTURE_CHECKLIST.md` to produce the captures, then rewrite the
> rows here. **Do not promote a row to `VERIFIED` from memory or from a wiki** —
> only from a `.jsonl` line in `fixtures/`.

## How to read this file

Each row of the state table has:

- **Signal** — the trigger the module receives it on.
- **Pattern** — the string or regex that recognises it. Match against the `raw`
  field (formatting codes intact), not `text`, unless the row says otherwise.
- **Status** — `UNVERIFIED`, `VERIFIED (fixture-name)`, or `MISSING` when the
  capture showed no reliable signal exists.
- **Fallback** — what to do when the primary signal does not arrive. Every row
  needs one, because every string here is Hypixel content that can change in any
  update.

---

## 1. Am I in SkyBlock at all?

This gates the socket, so it matters more than anything below: a wrong answer
here streams the wrong world, or streams nothing.

| Check | Signal | Pattern | Status |
|---|---|---|---|
| On Hypixel | `Server.getIP()` | `/hypixel\.net/i` | UNVERIFIED |
| In SkyBlock | scoreboard title | `/SKYBLOCK/i` | UNVERIFIED |

Implemented in `skyblock.js`. Both must agree — the IP alone is true in every
lobby and minigame.

**Known open question:** the scoreboard title is rendered with formatting codes
and, on some versions, decorative characters between letters. Check whether the
title needs `ChatLib.removeFormatting` *and* a strip of non-alphanumerics before
the regex will match. If it does, that is a correction to make in `skyblock.js`,
not a looser regex here.

**Fallback:** if the scoreboard title proves unreliable, the tab list header or a
`/locraw`-style area line may serve — but note that `/locraw` would mean sending
a command, which this module does not do. Prefer any passive signal over that.

---

## 2. Dungeon state changes

| State change | Expected signal | Candidate pattern | Status | Fallback |
|---|---|---|---|---|
| Entered a dungeon | scoreboard lines | `/The Catacombs|Catacombs/i` appearing in the board | UNVERIFIED | Tab list gains the party/class section; `worldLoad` followed by a Catacombs scoreboard within a few seconds. |
| Run started (timer running) | chat | a starting message on entering the boss room floor — exact wording unknown | UNVERIFIED | The scoreboard time line beginning to advance. Poll-diffing the time line is a reliable "the run is live" signal even with no message. |
| Floor identity (F1–F7 / M1–M7) | scoreboard lines | a line naming the floor, e.g. `/\(F(\d)\)|\(M(\d)\)/` | UNVERIFIED | The dungeon entrance portal name, captured at entry; or the tab list header. |
| Boss phase change | **probably none** | — | UNVERIFIED, expected to be the hardest | Suspected to have no chat message. Candidates, in order: a boss-dialogue chat line (Necron speaks), a scoreboard line change, then — only if those fail — `soundPlay` under `verboseTriggers`. Record which one worked. |
| Secret found | action bar or scoreboard | a secrets counter like `/Secrets? Found: (\d+)/i` | UNVERIFIED | Diff the counter rather than matching a message: a count that went from 3 to 4 is a secret, whatever the wording. `guiOpened` with a chest title is a weaker signal (not every chest is a secret). |
| Death (own) | chat | a death message naming the local player | UNVERIFIED | The scoreboard/tab list showing ghost state; the deaths counter incrementing. Prefer the counter — it survives a wording change. |
| Run completed | chat | the score summary block (multiple lines: score, time, secrets) | UNVERIFIED | The score screen GUI opening; the scoreboard clearing back to a hub board. |
| Run failed / left early | chat | a failure or "you left" message | UNVERIFIED | **Critical to get right.** If completion and failure are not distinguishable, treat *absence* of a completion summary before the board clears as a failure, and say so in the record. |
| Class level up | chat | a class experience/level message | UNVERIFIED | Not required for Phase 1; capture opportunistically. |

---

## 3. Trigger availability

Filled in from the `harness.registered` record at the top of each capture file —
that record is the module reporting which triggers this ChatTriggers build
actually accepted.

| Trigger | Registered | Fires reliably | Notes |
|---|---|---|---|
| `chat` | UNVERIFIED | UNVERIFIED | Needs `setCriteria("${*}")` on some builds; without it it matches nothing. Confirm which. |
| `actionBar` | UNVERIFIED | UNVERIFIED | Deduplicated in the harness — the raw feed repeats the same string many times a second. |
| `worldLoad` / `worldUnload` | UNVERIFIED | UNVERIFIED | Known caveat: the scoreboard is often empty at the instant `worldLoad` fires. The socket gate re-checks rather than trusting the one shot; see `index.js`. |
| `serverConnect` / `serverDisconnect` | UNVERIFIED | UNVERIFIED | May not exist on all builds. |
| `guiOpened` | UNVERIFIED | UNVERIFIED | Check whether the container title is readable at the moment the trigger fires or only a tick later. |
| `step` (poller) | UNVERIFIED | UNVERIFIED | `setDelay(1)` vs `setFps(1)` differ across releases; the harness tries both. |
| `soundPlay` / `spawnParticle` | UNVERIFIED | UNVERIFIED | Verbose set, off by default. Only relevant if boss phases have no other signal. |
| Scoreboard change | **does not exist** | — | There is no scoreboard-change trigger. This is why the harness polls and diffs. Not a gap to fill; a fact to design around. |

---

## 4. Findings log

Append a dated entry per capture session. Keep the raw strings — a paraphrase is
not evidence.

_(empty — first entry goes here after session 1 of the checklist)_
