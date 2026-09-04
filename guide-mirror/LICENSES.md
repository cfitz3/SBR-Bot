# Licences and attribution

Guidance in this bot is compiled from community work. Several of those sources
carry terms that bind this repository, not merely the fragments quoted from
them, so they are recorded here rather than in a footnote.

## This repository

Licensed **GPL-3.0-or-later**.

Chosen rather than something permissive because of the share-alike obligations
below: content derived from the Hypixel SkyBlock Wiki is CC BY-NC-SA, and code
patterns learned from GPL projects are GPL. A permissive licence on a work built
from copyleft inputs would be a licence this project has no right to grant.

**Non-commercial.** Wiki-derived guidance is CC BY-NC-SA 3.0, whose
non-commercial clause travels with it. This bot is not to be operated
commercially — no paid tiers, no advertising, no sale of access — for as long as
any wiki-derived content is embedded in it.

## Sources

### Hypixel SkyBlock Wiki

- **Terms:** CC BY-NC-SA 3.0 — attribution, non-commercial, share-alike.
- **Consequence:** the non-commercial and share-alike terms bind this repository
  as a whole wherever wiki-derived prose is embedded, which is why this project
  is GPL and non-commercial.
- **How it is used:** paraphrase with citation, in preference to transclusion.
  Every content record that draws on the wiki names the page it came from, and
  the citation is shown with the advice.
- **How it is fetched:** read-only through the MediaWiki API, rate-limited to at
  most one request per second, with a descriptive User-Agent identifying this
  bot and a contact. Responses are cached on disk. This never happens inside a
  command request path — a wiki outage costs a citation link, never a
  recommendation.
- **Not used:** `wiki.hypixel.net` (Cloudflare-blocked to scripted access) and
  `hypixel-skyblock.fandom.com` (an abandoned copy, wrong often enough to be
  worse than nothing).

### NotEnoughUpdates repository (NEU-REPO)

- **Terms:** see the upstream repository; used as reference data.
- **How it is used:** item metadata and recipe data, **pinned to a specific
  commit** recorded in `neu.pin.json`. The pin is not tracked to `master`: this
  is community-maintained data, and an upstream mistake shipped straight through
  to users is exactly the poorly-informed suggestion this project exists to
  avoid. Moving the pin is a deliberate act with a diff to read.

### EliteFarmers

- **Terms:** GPL-3.0, with a permission-gated production instance.
- **Status:** not used. Jacob contest features are omitted rather than depended
  on silently. If they land later it will be with explicit permission for the
  hosted instance, or against a self-hosted one.

### SkyCrypt

- **Terms:** AGPL-3.0.
- **Status:** not used as a backend. The hosted instance returns 403 to scripted
  requests, and the licence would extend to a network-accessible derivative.
- **Note for anyone reading this repository:** only the `SkyCryptWebsite` /
  `skycryptsite` organisations are the real project. Other forks under similar
  names are known phishing clones.

### Skyblock-Item-Emojis

- **Terms:** none declared.
- **Status:** treated as data with attribution. No images are shipped without
  confirmed permission from the maintainer.

### Coflnet

- **Terms:** see upstream.
- **How it is used:** optional price history, behind its own cache and circuit
  breaker, with permission to answer nothing. An outage costs a chart, never a
  recommendation.

## Sources deliberately not used

| Source | Why not |
|---|---|
| `wiki.hypixel.net` | Cloudflare-blocked to scripted access |
| `hypixel-skyblock.fandom.com` | abandoned copy, frequently wrong |
| `slothpixel/*` | stale |
| `moulberry.codes/lowestbin.json` | dead |
| SkyCrypt backend | AGPL-3.0; 403s scripted requests |

## Trademarks

Not affiliated with, endorsed by, or connected to Hypixel Inc. or Mojang AB.
Minecraft is a trademark of Mojang AB. Hypixel and Hypixel SkyBlock are
trademarks of Hypixel Inc.
