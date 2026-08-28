# External Integrations Map — SBR Guild Platform

Research on third-party repos/libraries to integrate so we build domain logic on top of proven engines instead of reinventing Skyblock math, API wrappers, and bridge plumbing. Mapped to the packages defined in [ARCHITECTURE.md](./ARCHITECTURE.md).

**Integration modes used below**
- **Direct** — install as a dependency and call it (optionally behind our service interface).
- **Wrap** — install, but hide it behind our own adapter/interface so we can swap it and keep DTOs stable.
- **Reference only** — do *not* depend on it; read the source for patterns/formulas/config and reimplement or port.
- **Data/asset** — consume its published data files/assets, not its runtime code.

---

## Summary Table

| Library / Repo | What it does | Consumed by | Replaces (build-it-yourself) | Mode | Primary caveat |
|----------------|--------------|-------------|------------------------------|------|----------------|
| **skyhelper-networth** | Calculates full Skyblock profile networth (gear + reforges, enchants, gems, stars, etc.) | `packages/pricing`, `packages/progression` | Our own networth engine | **Direct (wrapped)** | Museum priced only if you pass museum data; prices cached ~5min; must feed it correct Hypixel payloads |
| **@zikeji/hypixel** (node-hypixel) | Unopinionated, fully-typed async Hypixel API wrapper w/ rate-limit + pluggable cache | `packages/hypixel` | Hand-rolled fetch client, rate limiter, typings | **Direct (wrapped)** | Deep Skyblock data only partially typed; v4 breaking changes; treat raw types as loose |
| **hypixel-api-reborn** | Batteries-included, opinionated Hypixel wrapper (`getPlayer`, `getGuild` → rich objects) | `packages/hypixel` (alt) | Same as above | **Reference / alt** | Opinionated objects; JS-first (TS port WIP v12 beta); pick *one* wrapper, not both |
| **hypixel-skyblock-facade** (Senither) | Stateless HTTP facade returning highest-weight profile + Senither weight | `packages/progression` | Running our own weight service | **Reference only** | It's a separate Dockerized service (port 9281); we want in-process calc, so port formulas instead |
| **senitherweight** (tonydawhale) | TS package: Hypixel member data → Senither weight (skills+dungeons+slayer) | `packages/progression` | Our Senither weight math | **Direct (wrapped)** | You supply the API data; formula tracks a community standard that can drift |
| **farming-weight** (EliteFarmers) | TS calc for farming weight + fortune + crop/coin income | `packages/progression` | Our farming-weight math | **Direct (wrapped)** | Now lives in EliteFarmers/**Website** `packages/` (moved); expects pre-processed input; **license: check per-folder (Website is GPL-3.0)** |
| **skyblock-parser** (slothpixel) | Parses raw Skyblock profile JSON into readable member/stats objects | `packages/hypixel` / `progression` | A raw-profile normalizer | **Reference only** | Last publish ~3yr ago, very low usage, JS — stale; mine it for parsing logic, don't depend |
| **Altpapier/hypixel-discord-guild-bridge** | Mineflayer→Discord guild-chat bridge; formatting, slowmode, POST API to send msgs | `apps/bridge-bot`, `packages/bridge` | Designing bridge/limbo/formatting from scratch | **Reference only** | Requires MC account credentials in config; Mineflayer = ban risk; JS app not a lib |
| **DuckySoLucky/hypixel-discord-chat-bridge** | Two-way guild↔Discord bridge (discord.js v14 + mineflayer), command system, Docker | `apps/bridge-bot`, `packages/bridge` | Bridge event loop, command routing patterns | **Reference only** | Same Mineflayer ban risk; it's a full app to learn from, not import |
| **xMdb/hypixel-guild-chat-bot** | Guild chat bot (another bridge implementation) | `apps/bridge-bot` | Bridge patterns | **Reference only** | Could not verify repo status via search — **confirm it still exists** before relying on it |
| **Altpapier/Skyblock-Item-Emojis** | DB of every Skyblock item as a Discord emoji (v3: emojis.json + images.json, FurfSky textures) | `packages/shared-types` (asset map) → `bridge-bot`, `admin-bot`, `web-panel` | Sourcing/hosting our own item emojis | **Data/asset** | Discord changed rules: emojis no longer usable in some slash-command contexts; verify usage surface; give credit |
| **Coflnet SkyApi** (`sky.coflnet.com`) | Hourly/daily price history per item tag (min/max/avg/volume) for both auction and bazaar items | `packages/pricing` (history port) | Recording our own price time series | **Direct (HTTP, history only)** | **History and context only** — never the live price a trade is made on (DP-2). Third-party uptime we do not control, so the port answers `null` and the card degrades to prices without a chart; timestamps come back zoneless and must be read as UTC |
| **SkyCrypt** (SkyCryptWebsite: Frontend + Go Backend) | Full per-player Skyblock stats site (skills, gear, pets, dungeons, etc.) | `packages/progression`, `web-panel` | Building every stat parser/visualization ourselves | **Reference only** | AGPL-family / heavy; use for parsing patterns & item logic. **Only trust `SkyCryptWebsite`/`skycryptsite` orgs — others are known phishing forks** |

---

## Notes by Item

### API access layer — pick one wrapper
- **`@zikeji/hypixel`** is the recommended base for `packages/hypixel`: TypeScript-native, typed responses, built-in rate limiting, and pluggable cache (we plug in Redis). Wrap it so our DTOs don't leak its (partially loose) deep-Skyblock types. ([npm](https://www.npmjs.com/package/@zikeji/hypixel) · [repo](https://github.com/zikeji/node-hypixel))
- **`hypixel-api-reborn`** is the fuller, opinionated alternative (`getPlayer`, `getGuild`). Keep as a fallback/reference; its TS port is a v12 beta. **Do not run both** — one wrapper behind our interface. ([npm](https://www.npmjs.com/package/hypixel-api-reborn) · [repo](https://github.com/Hypixel-API-Reborn/hypixel-api-reborn))
- **`skyblock-parser`** (slothpixel) would normalize raw profiles, but it's stale (~3 yrs, JS, near-zero downloads). **Reference only** — port its parsing ideas into our own normalizer inside `packages/hypixel`. ([repo](https://github.com/slothpixel/skyblock-parser))

### Valuation & progression math — the biggest time-savers
- **`skyhelper-networth`** is effectively the community-standard networth engine and should be a **direct dependency wrapped by `packages/pricing`/`progression`**. It also exports a `getPrices` helper (bazaar/AH-derived, ~5 min cache) we can reuse. Remember to pass **museum data + bank balance** for accurate totals. ([npm](https://www.npmjs.com/package/skyhelper-networth) · [repo](https://github.com/Altpapier/SkyHelper-Networth))
- **`senitherweight`** (tonydawhale) gives Senither weight directly from API data — **direct, wrapped** in `packages/progression`. ([repo](https://github.com/tonydawhale/senitherweight))
- **`hypixel-skyblock-facade`** (Senither) is the canonical *source* of the weight strategy but ships as a **standalone HTTP service** (Docker, port 9281). We want in-process calc, so treat it as **reference** — port formulas / cross-check against `senitherweight`. ([repo](https://github.com/Senither/hypixel-skyblock-facade))
- **`farming-weight`** (EliteFarmers) — **direct, wrapped** for farming weight/fortune/income. ⚠️ It **moved** out of the old `EliteFarmers/FarmingWeight` repo into `EliteFarmers/Website` under `packages/`; the standalone package was MIT but the Website repo is **GPL-3.0**, so confirm the exact license of the folder we pull before shipping. Input must be pre-processed (not raw API). ([old repo](https://github.com/EliteFarmers/FarmingWeight) · [current](https://github.com/EliteFarmers/Website) · [docs](https://mintlify.wiki/EliteFarmers/Website/developers/farming-weight/overview))

### Price history — layered on top, never underneath
- **Coflnet SkyApi** answers `GET /api/item/price/{TAG}/history/{day|week|month}` with a bucketed series (`min`, `max`, `avg`, `volume`, `time`) covering auction *and* bazaar items — the one thing the Hypixel API does not give us, because it only ever reports *now*. It backs the chart and the "25% above the 7-day average" line on the `/price` card.
- **It is a history source, not a market source** (decision DP-2). Live order book, lowest BIN and networth valuation stay on the Hypixel-backed path in `packages/pricing`. Coflnet gets its own port, its own cache (15 min / 1 h / 6 h by range) and its own breaker, and every read may answer `null`: a Coflnet outage costs a card its chart and nothing else.
- **Three outcomes are kept distinct**, because collapsing them lies to the reader: no recorded past → empty series (cached); an item Coflnet has never seen (400 `item_not_found`) → empty series, *not* counted against the breaker; unreachable or misshapen → `null`, counted, never cached.
- Timestamps arrive **without a zone** and are UTC upstream; parsing them as local time shifts the whole series by the host offset — invisible on a chart and wrong on the axis. ([API](https://sky.coflnet.com/api))

### Bridge implementations — reference architecture, not dependencies
All three bridges rely on **Mineflayer** (a non-standard client) to sit in Hypixel guild chat, which carries a **real account-ban risk** and needs Minecraft account credentials. They are **applications, not libraries** — we study their event loop, formatting, limbo-handling, and command routing, then implement `packages/bridge` + `apps/bridge-bot` ourselves.
- **Altpapier/hypixel-discord-guild-bridge** — good reference for message formatting, slowmode, and a POST API to inject messages/commands. ([repo](https://github.com/Altpapier/hypixel-discord-guild-bridge))
- **DuckySoLucky/hypixel-discord-chat-bridge** — discord.js v14 + mineflayer, mature command system (`!skyblock`, `!calculate`, Soopy passthrough), Docker setup — the richest reference. ([repo](https://github.com/DuckySoLucky/hypixel-discord-chat-bridge))
- **xMdb/hypixel-guild-chat-bot** — another implementation; **I couldn't confirm its current state via search**, so verify the repo before investing time. ([search GitHub](https://github.com/xMdb))

### Assets & UI reference
- **Altpapier/Skyblock-Item-Emojis** — consume the published **v3 `emojis.json` / `images.json`** as a data map in `packages/shared-types`, surfaced by all three apps for pretty item rendering. Caveat: a Discord change removed emoji usability in some slash-command contexts, so confirm it works on our target surfaces; credit the author. ([repo](https://github.com/Altpapier/Skyblock-Item-Emojis))
- **SkyCrypt** (Frontend + Go Backend) — the gold-standard reference for parsing/derived stats and item presentation. **Reference only** (license + scope). ⚠️ Security: only the **`SkyCryptWebsite`** / **`skycryptsite`** orgs are legit — other "SkyCrypt" profiles are flagged **phishing vectors**. ([frontend](https://github.com/SkyCryptWebsite/SkyCrypt-Frontend) · [backend](https://github.com/SkyCryptWebsite/SkyCrypt-Backend))

---

## Cross-Cutting Risks & Decisions

1. **Mineflayer ban risk is the #1 operational risk.** Every guild-chat bridge depends on it. Plan for a dedicated alt Minecraft account, credential isolation, and graceful reconnection — and set community expectations. This lives entirely inside `apps/bridge-bot`, isolated from the rest of the system.
2. **Licensing must be audited before shipping**, especially `farming-weight` (GPL-3.0 in the Website repo) and SkyCrypt (copyleft). MIT libs (`skyhelper-networth`, `@zikeji/hypixel`, `senitherweight`, Senither facade) are safe to depend on with attribution.
3. **Skyblock data formats drift constantly.** `farming-weight` and `skyblock-parser` both warn that keeping up with Hypixel API changes is the *consumer's* job. Our `packages/hypixel` normalizer is the single choke point that absorbs this churn so downstream math packages stay stable.
4. **Pick one Hypixel wrapper and one weight source.** Don't carry `@zikeji/hypixel` *and* `hypixel-api-reborn`, or `senitherweight` *and* the facade, at runtime — choose, wrap, and keep the other as reference to avoid divergent behavior.
5. **Wrap everything behind our service interfaces.** Networth, weights, farming, and the API wrapper are all external engines whose APIs (and maintenance) we don't control — the adapter layer in each package is what lets us swap or fork later without touching the bots or panel.
6. **Coflnet is the only third-party runtime dependency in the request path.** It is confined to history, behind a port with its own cache and breaker, and allowed to answer nothing — the design rule is that no external service we do not run can take a price off a card.
7. **Verify two repos before committing:** `xMdb/hypixel-guild-chat-bot` (couldn't confirm status) and the exact upstream location/version of `farming-weight` (post-move).

---

## Sources
- [skyhelper-networth (npm)](https://www.npmjs.com/package/skyhelper-networth) · [GitHub](https://github.com/Altpapier/SkyHelper-Networth)
- [@zikeji/hypixel (npm)](https://www.npmjs.com/package/@zikeji/hypixel) · [node-hypixel GitHub](https://github.com/zikeji/node-hypixel)
- [hypixel-api-reborn (npm)](https://www.npmjs.com/package/hypixel-api-reborn) · [GitHub](https://github.com/Hypixel-API-Reborn/hypixel-api-reborn)
- [Senither/hypixel-skyblock-facade](https://github.com/Senither/hypixel-skyblock-facade)
- [tonydawhale/senitherweight](https://github.com/tonydawhale/senitherweight)
- [EliteFarmers/FarmingWeight (moved)](https://github.com/EliteFarmers/FarmingWeight) · [EliteFarmers/Website](https://github.com/EliteFarmers/Website) · [farming-weight docs](https://mintlify.wiki/EliteFarmers/Website/developers/farming-weight/overview)
- [Coflnet SkyApi](https://sky.coflnet.com/api) · [GitHub](https://github.com/Coflnet/HypixelSkyblock)
- [slothpixel/skyblock-parser](https://github.com/slothpixel/skyblock-parser)
- [Altpapier/hypixel-discord-guild-bridge](https://github.com/Altpapier/hypixel-discord-guild-bridge)
- [DuckySoLucky/hypixel-discord-chat-bridge](https://github.com/DuckySoLucky/hypixel-discord-chat-bridge)
- [Altpapier/Skyblock-Item-Emojis](https://github.com/Altpapier/Skyblock-Item-Emojis)
- [SkyCrypt-Frontend](https://github.com/SkyCryptWebsite/SkyCrypt-Frontend) · [SkyCrypt-Backend](https://github.com/SkyCryptWebsite/SkyCrypt-Backend)
