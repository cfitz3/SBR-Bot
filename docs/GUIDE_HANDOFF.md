# SBR-Guide — slice handoff log

One entry per slice. Each records where things stand, what landed, what did not
land and why, and what the next slice picks up. The point is that somebody
resuming cold can do so without reading the diff.

Charter and contracts: [`GUIDE.md`](./GUIDE.md).

---

## Slice 1 — dual-repo skeleton and the sync mechanism

**Status: complete.** No game logic, no content, no commands — by design.

### What landed

**A new package boundary.** `packages/skyblock-parse` holds the six pure parsers
that used to sit in `packages/progression/src/skyblock/`: `parse.ts`,
`metrics.ts`, `accessories.ts`, `nbt.ts`, `xp.ts`, `weight.ts`. They were moved
with `git mv` rather than copied, so there is one implementation rather than two
that drift, and `@sbr/progression` re-exports them so its public surface is
byte-for-byte what it was. The advisor needs these; it must not need the package
that stores readings.

**Three new workspaces and an app.** `packages/guide` currently holds
`rules.ts`, which is the "no unsourced advice" rule as code — `Citable`,
`ContentStatus`, `isPublishable`, `withholdReason` — with five tests.
`packages/guide-content` holds the path constants the corpus and its compiled
artefact will live at. `apps/guide-bot` has a composition root and a boot-ready
`main.ts` that composes, warns that there is no command surface yet, and exits
cleanly. All four are registered in the root `tsconfig.json`, in `APPS` in
`scripts/lib.mjs` (gated on `DISCORD_GUIDE_TOKEN`), and as `start:guide-bot`.

**`guide-mirror/`** — the hand-authored half of the mirror, living here so that
"never hand-edit the mirror" stays true. Composition root, `config.ts`, a single
`redis/index.ts` holding exactly the three adapters the client needs, `db/`, the
vendored Hypixel client, the reduced `types/dtos.ts`, the reduced `log/index.ts`
surface, and the full scaffolding: `package.json`, `tsconfig.json`,
`prisma/schema.prisma`, `prisma.config.ts`, compose, `.env.example`, README,
`COMPLIANCE.md`, `LICENSES.md`, `denylist-scan.mjs`, CI.

**`scripts/sync-guide.mjs`** — the deterministic exporter. Manifest, hard-error
denylist, table-driven import rewriting, generated-file banners with the source
commit SHA, `--check` drift mode, and the forbidden-string scan. See
[`GUIDE.md` §3](./GUIDE.md#3-the-sync-mechanism).

**The mirror itself**, generated to `../SBR-Guide` and committed there:
51 files, `npm run scan` clean, `prisma generate` + `tsc -b` exit 0, 52 tests
pass, and `grep -rn "@sbr/"` over its source returns nothing.

### Decisions worth knowing about

**`packages/skyblock-parse` depends only on `@sbr/shared-types`.** Every other
domain package here also takes `@sbr/observability`. Nothing in the six moved
files logs, so the dependency would be unused, and an unused dependency on the
one package that must look minimal to a reviewer is a bad trade. This is a
deliberate deviation from the house pattern, recorded so nobody "fixes" it.

**The scan found real hits on its first run, and they were renamed rather than
exempted.** `CallMeter.snapshot()` became `current()` and a local `rollup()` in
the health registry became `worst()`, both in `packages/observability`, with no
callers outside that package. Two prose comments were reworded — one in
`packages/hypixel/src/client.ts` ("re-fetching a snapshot" → "a dataset"), one
in the mirror schema header. The scanner's own instruction is to rename rather
than widen the exemption, because the word is doing real work in a reviewer's
eye, and following it on the first opportunity sets the precedent.

**Emitted versus template** is the load-bearing distinction, and
`guide-mirror/src/types/dtos.ts` is why. Upstream `shared-types/src/dtos.ts`
carries the stored-reading shapes; the mirror's is a hand-written reduction
verified field-for-field against it. Drift is caught by the mirror's own `tsc`,
since the parsers are emitted unchanged.

**The endpoint drop list is shorter than the platform's client.** The mirror can
call: profile, the public market and world-state reads, and Mojang. It has no
guild endpoint, no museum read, no per-player auction listing, and no
ended-auction history. Dropping those is itself the compliance evidence.

**Line endings are normalised to LF by the generator**, and the mirror carries a
`.gitattributes` pinning `eol=lf`. Both are needed: without them `--check`
reports every file as drifted on a Windows clone, and a check that cries wolf
stops being read.

**`prisma.config.ts` in the mirror, and a CI step that provides `.env`.** Prisma
7 moved the datasource URL out of the schema, which suits a schema meant to be
read as a document. It also means `prisma generate` resolves `DATABASE_URL` at
config-load time, so CI copies `.env.example` to `.env` before building. The
example values point at nothing and are never dialled.

### Corrections to the standing spec

**There are four Hypixel failure states, not five.** `HypixelFailureState` in
`packages/shared-types/src/common.ts` is exactly `NOT_LINKED | MISSING_PROFILE |
API_DISABLED | RATE_LIMITED`. `STALE` is a `Freshness` on a *successful*
`DataEnvelope`, not a failure — a stale answer is an answer, and the renderer
says how old it is. The mirror's `COMPLIANCE.md` §3 was written with the correct
four; slice 5 should render freshness and failure as different things.

### What did not land, and why

- **No ranking logic, no content, no commands.** Out of scope for this slice.
- **`COMPLIANCE.md` statuses are all `pending`.** `satisfied` requires a named
  code path *and* a named test, both passing in the mirror. The code paths are
  named; the tests arrive with the mechanisms they cover, mostly in slices 2 and
  4, and the file is finished in slice 6.
- **Repo B is not published.** It exists locally at `../SBR-Guide` with one
  commit and no remote. Publishing and the API submission are slice 11.
- **`npm audit` reports 4 high advisories in the mirror**, all transitive
  dev-only dependencies of the Prisma CLI (`deepmerge-ts`, and `mysql2`, which
  is unreachable — this is Postgres only). The offered fix downgrades to Prisma
  6, a breaking change. Left as-is deliberately; revisit if Prisma 7 picks up
  the patched versions.

### Gates

`npx tsc -b` 0 · `npm test` 2826 tests, 0 fail (1 skipped) · `npm run brand
check` clean, 121 cards, no error-severity issues · `node scripts/sync-guide.mjs
--check` clean at 51 files · mirror standalone: scan clean, `tsc -b` 0, 52
tests pass.

### What slice 2 picks up

Reference-data ingestion and the truth-checking harness: NEU pinned to a SHA in
`neu.pin.json`, the cap-table cross-check test (the highest-leverage test in the
project — it is what stops a patch silently invalidating the corpus), Senither
coefficients cross-checked against NEU's `weight.json`, a `wiki.ts` MediaWiki
client at ≤1 req/s that is never in a request path, a `guide-refresh` bulk-lane
cron, and the `cache:guide:ref:{name}` / `cache:guide:version` keys.
