# SBR Guild Platform

Full-stack platform for a Hypixel Skyblock guild community: a member-facing
Bridge/Skyblock Discord bot, a staff-facing Admin bot, background workers, and a
Discord-OAuth web control panel all sharing one typed domain core.

**Design docs** live in [`docs/`](./docs):
[Charter](./docs/PROJECT_CHARTER.md) ·
[Architecture](./docs/ARCHITECTURE.md) ·
[Domain model](./docs/DOMAIN_MODEL.md) ·
[Hypixel data layer](./docs/HYPIXEL_DATA_LAYER.md) ·
[Commands](./docs/COMMANDS.md) ·
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
- Docker (local Postgres + Redis via `docker-compose.yml`)

## Quickstart

```bash
cp .env.example .env          # fill in secrets — DATABASE_URL + REDIS_URL required
docker compose up -d          # start postgres + redis
npm install                   # install + link workspaces
npm run build                 # prisma generate + tsc -b across the graph
npm run migrate:deploy -w @sbr/db   # apply the schema to your db
npm test                      # run the full suite (offline, no infra needed)
```

## Running the apps

```bash
npm run start -w @sbr/app-workers     # BullMQ scheduler        (needs Redis)
npm run start -w @sbr/app-web-panel    # OAuth + API on :3000    (needs Redis+DB)
npm run start -w @sbr/app-admin-bot    # needs DISCORD_ADMIN_TOKEN
npm run start -w @sbr/app-bridge-bot   # needs DISCORD_BRIDGE_TOKEN (+ MC account)
```

Each app boots its composition and validates config; the bots start their
gateways only when their token is present, otherwise they log and exit
(boot-ready). The centralised environment (one root `.env`) is resolved by
`@sbr/env` regardless of the directory a process starts from.

## Common scripts (root)

| Script | Does |
|--------|------|
| `npm run build` | `prisma generate` then `tsc -b` (whole workspace) |
| `npm run typecheck` | type-check all projects |
| `npm test` | run every package's test suite |
| `npm run db:generate` | regenerate the Prisma client |
| `npm run db:validate` | validate the Prisma schema |
| `npm run clean` | clear TS build outputs |

## Status

Domain services and app transports are implemented and green
(`tsc -b` clean, full test suite passing). Workers (BullMQ) and the web panel
run against live Postgres/Redis; the Discord bots and Mineflayer bridge are
boot-ready and start once real tokens/credentials are provided.
