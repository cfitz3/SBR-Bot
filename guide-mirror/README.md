# SBR-Guide

A Discord bot that answers one question for one player at a time: **given where
you actually are, what are the most cost- and time-effective things you could do
next in Hypixel SkyBlock?**

It reads your profile, matches it against a curated body of human-verified
guidance, prices the options against the live bazaar and auction house, weighs
them by the current mayor and any running event, and returns a short ranked list
with the reasoning shown and every claim attributed.

---

## Two rules the whole project is built around

**No AI-generated advice, ever.** Every recommendation this bot emits traces to
a curated content record carrying a list of sources and the game patch it was
last verified against. There is no language model in the request path and no
generated prose anywhere in the output. If a claim cannot be sourced, it does
not ship; where a mechanic is uncertain, the record is marked unverified and the
loader excludes it. A recommendation that cannot say where it came from is a
guess wearing a confident tone, and this bot exists precisely because there is
already plenty of that.

**Read, advise, discard.** A profile is read, advice is computed, the answer is
rendered, and nothing about that player is written down beyond a cache entry
that expires. No history, no time series, no snapshots, no rollups. The database
schema is three tables and you can read it in a minute:
[`prisma/schema.prisma`](prisma/schema.prisma).

---

## What it does with the Hypixel API

Stated plainly, because it is the part that matters most:

- **One profile read per advice request**, cached for six hours behind a
  per-player, per-endpoint hourly claim. A refresh happens only when the player
  presses refresh.
- **Market and world state are public and shared.** The bazaar, the auction
  house pages, the mayor election, fire sales and bingo are fetched once for
  everybody by a background job, not once per user.
- **Names resolve through Mojang, and only Mojang.** There is no roster scan, no
  auction search, and no chat walking used to turn a partial name into a player.
  A lookup that cannot be resolved stays unresolved.
- **Endpoints this bot cannot call at all**, because the client does not
  implement them: guild, museum, per-player auctions, ended auctions, status,
  recent games.

The full clause-by-clause account is in [COMPLIANCE.md](COMPLIANCE.md), and the
request path is drawn out in [docs/DATA_FLOW.md](docs/DATA_FLOW.md).

---

## Running it

```bash
cp .env.example .env      # then fill in DISCORD_GUIDE_TOKEN and HYPIXEL_API_KEY
docker compose up -d      # Postgres + Redis, both bound to loopback
npm install
npm run db:migrate
npm run build
npm start
```

Without a Discord token the process composes its wiring, reports that it has
nothing to serve, and exits cleanly — which is a quick way to check the
configuration without credentials.

`npm test` builds and runs the suite. `npm run scan` runs the persistence
denylist check that CI also runs.

---

## Attribution and licensing

Guidance is compiled from community sources, each cited in the content record it
came from and shown with the advice it supports. The upstream projects and the
terms they carry are listed in [LICENSES.md](LICENSES.md) — several are
share-alike or non-commercial, and those terms bind this repository.

**Not affiliated with, endorsed by, or connected to Hypixel Inc. or Mojang AB.**
Minecraft is a trademark of Mojang AB. Hypixel and Hypixel SkyBlock are
trademarks of Hypixel Inc. This is an unofficial community tool.
