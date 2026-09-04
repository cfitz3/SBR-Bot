# SBR-Guide — progression advisor

A fourth leg on the platform, and the only one that ships as its own public
repository.

SBR-Guide answers one question: *for this player, on this profile, right now,
what are the most cost- and time-effective things they could do next?* It
answers it by joining curated, human-verified, source-attributed guidance
against the player's real parsed profile and the live state of the market, the
mayor and the calendar. It does not answer it by asking a model.

---

## 1. The two rules

Everything below follows from these, and neither is negotiable by a later
slice.

### No AI-generated advice, ever

Every recommendation the bot emits traces to a curated content record carrying a
`sources[]` array and a `lastVerifiedPatch` stamp. There is no LLM in the
request path and no generated prose anywhere in the output. A claim that cannot
be sourced does not ship.

Uncertainty has a designated home: a content record whose mechanic we are not
sure about is written `status: "unverified"`, and the loader excludes it from
output. We do not guess and mark it verified, and we do not guess and leave it
unmarked. `packages/guide/src/rules.ts` is that rule as code — `isPublishable`
and `withholdReason` — rather than as a paragraph somebody remembers.

The reason is not squeamishness about models. It is that a progression
recommendation is a claim about how many hours and how many million coins
somebody should spend, and a plausible-sounding wrong answer costs them both.
Advice that cites its source can be checked; advice that was generated cannot.

### Read-advise-discard

SBR-Guide reads a profile, computes advice, renders it, and persists nothing
player-scoped beyond a cache TTL. No history, no series, no snapshots, no
rollups of Hypixel data.

This is the whole of the compliance argument, so it is worth being exact about
what it forbids in the mirror repository:

- No table whose rows are keyed by `(uuid, capturedAt)`, or by any other pairing
  of a player with a time of observation.
- No table storing any Hypixel-derived player value at all.
- No aggregate, rollup or series derived from such values.
- No leaderboards, rankings, or cross-player comparison of any kind.

The only player-scoped rows are an identity and a preference: the
Discord-to-Minecraft link, and which profile the player wants advice about. Both
are facts the player supplied, not observations we made.

**This posture is load-bearing.** Any feature request that implies storing a
player's Hypixel values over time is refused in the mirror and argued for
separately here, in the platform, where the guild-activity exception applies and
where such storage already exists under review. Say so out loud when it comes
up. Do not quietly add a column.

---

## 2. Why two repositories

| | Repo A | Repo B |
|---|---|---|
| Location | `cfitz3/SBR-Bot` (this one) | `cfitz3/SBR-Guide` (public) |
| Purpose | how it actually runs for SBR | what gets submitted for API review |
| Shape | `packages/guide*`, `packages/skyblock-parse`, `apps/guide-bot`, wired into the existing composition roots | one self-contained bot: vendored Hypixel client, own Prisma schema, own compose stack, no `@sbr/*` dependency at all |
| Truth | **source of truth** | **generated** |

The previous production-key application for SBR-Bot was denied. The most
defensible reading is that stored progression and networth history, plus daily
analytics rollups, read as session tracking, and that the scope exceeded the
narrow guild-activity exception. SBR-Guide's answer is that it is
*transformative* rather than a mirror of the API: it produces a ranked,
cost-aware, prerequisite-gated action list that exists nowhere in any API
response, and it stores no player state to produce it.

That argument only works if a reviewer can verify it by reading. A bot that
imported `@sbr/progression` would show a package named for progression tracking
sitting beside a stored-reading repository — the exact impression to avoid, and
one that no amount of "but it is never called" would undo. So the mirror is
genuinely standalone, and the *reduction* is the artefact: the vendored client
can reach a profile, the public market and world-state endpoints, and Mojang,
and the guild endpoint, the museum read, per-player auction listings and
ended-auction history are absent rather than merely unused.

**A is the source of truth. B is generated. Never hand-edit B.** Every change to
B originates here and arrives through `scripts/sync-guide.mjs`.

---

## 3. The sync mechanism

`node scripts/sync-guide.mjs` writes the whole mirror. `--out <dir>` chooses
where (default `../SBR-Guide`); `--check` regenerates to a temporary directory,
diffs against the mirror, and exits non-zero on any drift.

### Emitted versus template

Two kinds of file cross over, and the distinction is the design:

**Emitted** — pure domain modules with no I/O, no platform coupling, and no idea
a guild exists. They are copied byte-for-byte with their `@sbr/*` imports
rewritten to relative paths, so the two repositories genuinely run the same code
instead of two copies that drift apart.

| Source | Lands at | Note |
|---|---|---|
| `packages/shared-types/src/common.ts` | `src/types/common.ts` | only this file — the rest of the contract layer describes rosters and stored readings |
| `packages/skyblock-parse/src/**` | `src/parse/` | all of it, tests included |
| `packages/guide/src/**` | `src/guide/` | all of it |
| `packages/guide-content/src/**` | `src/content/` | all of it |
| `packages/observability/src/{logger,meter,health,lifecycle}.ts` + tests | `src/log/` | no shipper, no status card |

**Template** — everything at the edge, which cannot be copied because the
platform's version of it describes rosters, moderation and stored progression:
the composition root, config, the Prisma layer, the Redis adapters, the vendored
Hypixel client, and the reduced type surface. These are hand-authored *here*,
under `guide-mirror/`, and copied to the mirror root verbatim.

That is how "never hand-edit B" survives contact with the parts that could not
be copied: the hand-editing happens in this repository, under review, in the
same commit as whatever prompted it.

`guide-mirror/src/types/dtos.ts` deserves a specific mention. It is a
hand-written *reduction* of `packages/shared-types/src/dtos.ts`, not a copy,
because the upstream file also carries the stored-reading shapes. It is kept
honest by the build rather than by care: the parsers are emitted unchanged, so a
field added to one of these shapes here and not there fails `tsc` in the mirror.

### The denylist

A manifest that says what crosses is only half the guarantee. `DENY` lists the
path fragments that must never appear — `packages/xp`, `leaderboards`,
`analytics`, `moderation`, `tickets`, `bridge`, `client-ingest`, `screening`,
`skykings`, `playtime`, `community`, `perms`, `progression`, the three other
apps, and `ctjs-module`. A denylisted file entering the manifest is a **hard
error**, not a warning: the entire argument for the mirror is that its contents
can be trusted, and a check that prints a warning and carries on is a check that
gets scrolled past.

### Import rewriting

Driven by `IMPORT_MAP`, a table, not a regex that infers a path from a package
name. A rewrite that guesses will eventually guess wrong, and it will do so
silently — producing a mirror that compiles against the wrong module. An
unmapped `@sbr/*` import is a hard error naming the file and the specifier.

The same table rewrites package names where they appear in *prose*, so a doc
comment saying "the loader in `@sbr/guide-content`" reads as `src/content` in
the mirror rather than naming a package no reader there can find.

### Determinism

Emitted output is always LF, whatever the source file happens to have, and the
mirror carries a `.gitattributes` pinning `eol=lf` on checkout. Without both,
`--check` would report every file as drifted on a Windows clone that had done
nothing wrong, which is how a check stops being read.

Every generated file that has a comment syntax carries a banner naming its
source path and the source commit SHA. On a file starting with `#!`, the banner
goes below the shebang, which otherwise stops being one.

`node_modules`, `dist`, `.git` and a real `.env` survive a regeneration and are
ignored by the drift check; everything else in the mirror is replaced, so a file
dropped from the manifest actually disappears.

---

## 4. The forbidden-string scan

Both repositories scan for the same eight strings — `ProfileSnapshot`,
`ProfileCurrent`, `MetricRollup`, `XpEvent`, `AnalyticsEvent`, `snapshot`,
`rollup`, `leaderboard` — case-insensitively. `scripts/sync-guide.mjs` runs it
over what it generated; `scripts/denylist-scan.mjs` in the mirror runs it in CI
as the first step, ahead of the build, because a persistence surface that should
not exist makes nothing else about the build interesting.

The specific names catch a model or type carried across by accident. The last
three generic words catch a new one invented under a different name, which is
the likelier failure.

### The Markdown exemption, and why it is not a loophole

The scan reads code only: `.ts`, `.tsx`, `.mjs`, `.cjs`, `.js`, `.prisma`,
`.sql`. Markdown is exempt because `COMPLIANCE.md` has to be able to name the
things it rules out, and a scan that forbade those words would forbid the
document that explains them.

This is a recorded decision, not an oversight. If you are ever tempted to move
something past this check by putting it in a `.md` file, that is the loophole,
and using it would be a lie told to a reviewer.

The scan earned its keep on its first run, which is the argument for having it:
it found `CallMeter.snapshot()` and a local `rollup()` in the health registry —
both entirely innocent, both words a reviewer would have had to stop and check.
They were renamed to `current()` and `worst()` rather than exempted, per the
scanner's own instruction to rename rather than widen.

---

## 5. What the bot may ask upstream

One profile read per advice request, cached six hours, behind a per-player
per-endpoint hourly claim in Redis. `PlayerReadOptions.maxAgeMs` is the only
route past the cache and is reachable only from an explicit, user-pressed
refresh — never from anything scheduled.

Market and world-state reads (bazaar, auction pages, election, fire sales,
bingo, resources) are public and worker-owned: one request serves everybody, and
the cost does not scale with the number of people using the bot.

Name resolution goes through Mojang and only Mojang. There is no fallback that
walks a roster, searches the auction house, or reads chat to turn a partial name
into a player. An inconclusive lookup stays inconclusive — the client returns
one of the four typed failure states (`NOT_LINKED`, `MISSING_PROFILE`,
`API_DISABLED`, `RATE_LIMITED`) and the command renders it honestly.

The key is read once, in the mirror's `src/config.ts`, reaches exactly one
construction site in `src/composition.ts`, and is sent as an `API-Key` header,
never in a URL.

---

## 6. Licensing, which constrains the product

Curated content is compiled from community work, and some of those terms bind
the mirror as a whole rather than only the fragments quoted. The mirror's
`LICENSES.md` is the authoritative record; the short version:

- **Hypixel SkyBlock Wiki** is CC BY-NC-SA 3.0. Non-commercial and share-alike
  travel with the content, which is why the mirror is GPL-3.0-or-later and
  explicitly non-commercial. Prefer paraphrase-with-citation over transclusion;
  fetch at ≤1 req/s with a descriptive User-Agent, cached, never in a request
  path.
- **NEU-REPO** is community-maintained reference data, pinned to a commit SHA in
  `neu.pin.json`. Do not track `master` live: an upstream mistake shipped
  straight through is exactly the poorly-informed suggestion this project exists
  to avoid.
- **EliteFarmers** is GPL-3.0 with a permission-gated production instance. Not
  used. Jacob's contest features are omitted from v1 rather than depended on
  silently.
- **Skyblock-Item-Emojis** declares no licence. Treated as data with
  attribution; no images ship without confirmed permission.
- **SkyCrypt** is AGPL-3.0 and 403s scripted requests. Not used as a backend.
  Only the `SkyCryptWebsite` / `skycryptsite` organisations are the real
  project — other similarly-named forks are known phishing clones.

Not used at all: `wiki.hypixel.net` (Cloudflare-blocked), the Fandom copy
(abandoned, wrong often enough to be worse than nothing), `slothpixel/*`
(stale), `moulberry.codes/lowestbin.json` (dead).

---

## 7. Definition of done, per slice

A slice is not finished until all of it holds:

1. `npx tsc -b` exits 0 at the repository root.
2. `npm test` is green.
3. `npm run brand check` is clean, and every new card has an embed-gallery entry
   with no error-severity `checkEmbed` issues.
4. Docs are updated.
5. `node scripts/sync-guide.mjs --check` passes, and the regenerated mirror
   builds and tests standalone — no `@sbr/*` resolution — and is committed.
6. `docs/GUIDE_HANDOFF.md` has an entry recording the state, what landed, what
   did not and why, and what the next slice picks up.

## 8. Standing risks

- CC BY-NC-SA 3.0 keeps the mirror non-commercial and share-alike for as long as
  any wiki-derived content is embedded in it.
- EliteFarmers is GPL-3.0 and permission-gated.
- NEU-REPO is community-maintained: pin a SHA, and move it deliberately with a
  diff to read.
- Coflnet and the wiki are third parties with standing permission to answer
  `null`. An outage costs a citation or a chart, never a recommendation.
- The compliance posture is load-bearing.
