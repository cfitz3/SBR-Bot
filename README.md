# SBR Guild Platform

Full-stack platform for a Hypixel Skyblock guild community: a member-facing
Bridge/Skyblock Discord bot, a staff-facing Admin bot, background workers, and a
Discord-OAuth web control panel — all sharing one typed domain core.

**Design docs** live in [`docs/`](./docs):
[Charter](./docs/PROJECT_CHARTER.md) ·
[Architecture](./docs/ARCHITECTURE.md) ·
[Domain model](./docs/DOMAIN_MODEL.md) ·
[Hypixel data layer](./docs/HYPIXEL_DATA_LAYER.md) ·
[Commands](./docs/COMMANDS.md) ·
[Command inventory (as built)](./docs/COMMAND_INVENTORY.md) ·
[Bridge bot](./docs/BRIDGE_BOT.md) ·
[Admin bot](./docs/ADMIN_BOT.md) ·
[Web panel](./docs/WEB_PANEL.md) ·
[Workers](./docs/WORKERS.md) ·
[Analytics](./docs/ANALYTICS.md) ·
[Redis keyspace](./docs/REDIS_KEYSPACE.md) ·
[Integrations](./docs/INTEGRATIONS.md)

## Monorepo layout

```
apps/
  bridge-bot/     member Discord + Mineflayer bridge   (@sbr/app-bridge-bot)
  admin-bot/      staff moderation/governance bot       (@sbr/app-admin-bot)
  workers/        BullMQ scheduled jobs                 (@sbr/app-workers)
  web-panel/      Discord-OAuth HTTP API + sessions     (@sbr/app-web-panel)

packages/
  # infrastructure
  env             single-root .env loader (workspace-anchored)
  config          validated, fail-fast app config
  db              Prisma schema + client + repositories (only Prisma consumer)
  redis           node-redis client + sbr: keyspace + adapters
  observability   structured logger + health registry
  shared-types    DTOs, enums, Result/HypixelResult, service ports

  # domain services
  identity        account linking (Hypixel social match) + permissions
  hypixel         centralized Hypixel/Mojang client (cache/rate-limit/retry)
  pricing         item pricing + networth (partial-vs-exact honesty)
  progression     stats & networth composition
  bridge          transport-agnostic relay pipeline
  moderation      rank-checked actions + audit + enforcement mirror
  community       events, membership, applications, RSVP
  analytics       event capture + daily rollup
  jobs            scheduler-agnostic job runner (lock/retry/log)

  # app-facing
  commands-bridge member command dispatcher
  commands-admin  staff command dispatcher
  panel-core      two-gate access control + page view-models
```

Workspaces use **npm** with **TypeScript project references**. The layout is
pnpm/Turborepo-compatible — see `pnpm-workspace.yaml`. Every external system
(Hypixel, Discord, Redis, Postgres, BullMQ) sits behind an injectable port, so
the domain packages are unit-tested offline with fakes.

## Prerequisites

- Node.js ≥ 20
- Docker Desktop (for local Postgres + Redis — optional if you host your own)

## Quickstart

```bash
npm run setup     # scaffold .env, start postgres+redis, install, build, migrate
npm start         # run every app that's configured, in one terminal
```

That's it. `npm run setup` is idempotent — re-run it any time (after a `git
pull`, say) and it will reconcile whatever drifted.

On the first run it creates `.env` from `.env.example` and generates a random
`SESSION_SECRET`. Everything else — Discord tokens, the Hypixel key — is
optional: apps whose credentials are missing are simply skipped, and `setup`
prints exactly which variable unlocks each one. Fill in what you need in `.env`
and run `npm start` again.

If anything looks wrong, `npm run doctor` checks your toolchain, `.env`,
datastore reachability, build output and migration state, then names the command
that fixes each problem.

## Running the apps

```bash
npm start                 # everything that's configured
npm run dev               # same, plus rebuild-and-restart on save
npm start -- workers      # just one app (or several: `npm start -- workers web-panel`)
```

`npm start` starts the Docker datastores itself if they aren't already
listening, builds if `dist/` is missing, then runs the apps in a single terminal
with colour-coded log prefixes. Ctrl+C stops all of them.

| App | Needs | Does |
|-----|-------|------|
| `workers` | Redis + DB | BullMQ scheduled jobs |
| `web-panel` | Redis + DB | Discord-OAuth HTTP API on `:3000` |
| `admin-bot` | `DISCORD_ADMIN_TOKEN` | staff moderation/governance |
| `bridge-bot` | `DISCORD_BRIDGE_TOKEN` (+ MC account) | member Discord ↔ in-game bridge |

Each app validates its config at boot and fails fast. The centralised
environment (one root `.env`) is resolved by `@sbr/env` regardless of the
directory a process starts from.

### Long-running hosts (tmux, systemd, a VPS)

The apps and the datastores have separate lifecycles: the apps run on the host,
Postgres and Redis run in compose. Both compose services therefore declare
`restart: unless-stopped` so they come back with the Docker daemon. Without it a
daemon or host restart leaves the datastores down while the apps keep running,
and the freed `5432`/`6379` can be claimed by any *other* Postgres or Redis on
the box — at which point correct credentials start being rejected
(`password authentication failed for user "postgres"`) and the database looks
like it was deleted. Recreating the database does not help, because the server
answering is not ours.

Each app now asserts at boot that `DATABASE_URL` points at a Postgres holding
our schema, and refuses to start otherwise with the cause named. If you see that
refusal, run `docker compose ps` first.

## Common scripts (root)

| Script | Does |
|--------|------|
| `npm run setup` | full bootstrap — env, infra, install, build, migrate |
| `npm start` | run the configured apps (add `-- <app>` to pick) |
| `npm run dev` | same, with `tsc --watch` + auto-restart |
| `npm run doctor` | diagnose config, infra, build and schema state |
| `npm run build` | `prisma generate` then `tsc -b` (whole workspace) |
| `npm run typecheck` | type-check all projects |
| `npm test` | run every package's test suite (offline, no infra needed) |
| `npm run infra:up` / `infra:down` | start / stop Postgres + Redis |
| `npm run infra:reset` | destroy the containers **and their volumes**, then recreate |
| `npm run db:migrate` | apply migrations to your database |
| `npm run db:studio` | open Prisma Studio |
| `npm run db:reset` | **drop and rebuild** the database from migrations |
| `npm run clean` | clear TS build outputs |

## Status

Domain services and app transports are implemented and green
(`tsc -b` clean, full test suite passing). Workers (BullMQ) and the web panel
run against live Postgres/Redis; the Discord bots and Mineflayer bridge are
boot-ready and start once real tokens/credentials are provided.

The web panel serves a working operations UI — guild selector, overview,
analytics with CSV export, health, recruitment/tickets, events and attendance,
moderation, members, settings and mapping — with writes going through the same
domain services the bots use. See `docs/WEB_PANEL.md` §0 for what is
deliberately partial within those pages.
