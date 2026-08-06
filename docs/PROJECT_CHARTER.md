# Project Charter — SBR Guild Platform

*A full-stack platform for a Hypixel Skyblock guild community.*

---

## Product Goal

Build a unified platform that connects a guild's in-game Hypixel Skyblock presence, its Discord community, and its staff operations into one coherent system. The platform bridges guild chat to Discord, answers in-game commands, surfaces Skyblock stats and progression, and gives staff centralized tools for moderation, administration, and analytics — all configurable from a single web control panel.

## Target Users & Roles

| Role | Surface(s) | What they do |
|------|-----------|--------------|
| **Guild Member** | Bridge/Skyblock Bot (Discord + in-game) | Chat across the bridge, run stat/progression commands, check their own and others' Skyblock data. |
| **Staff / Moderator** | Admin Bot, Web Panel | Moderate chat, manage guild membership, action rule-breakers, respond to escalations. |
| **Guild Officer / Admin** | Admin Bot, Web Panel | Configure the platform, manage roles and permissions, run server administration, review reports. |
| **Owner / Operator** | Web Panel | Own top-level configuration, integrations, billing/hosting concerns, and platform-wide settings. |

## Core Value Proposition

- **One bridge, both directions** — guild chat and Discord stay in sync in real time, so members never have to be in-game to stay connected.
- **Stats where the community already is** — Skyblock progression, networth, and skill data are available on demand in Discord and in-game, without third-party lookups.
- **Operations without spreadsheets** — moderation, membership, and configuration live in one auditable control panel instead of scattered manual processes.
- **Centralized truth** — analytics and configuration are shared across all three surfaces, so bots and panel never disagree.

## Non-Goals (v1)

- Not a general-purpose Discord bot framework or a public multi-tenant SaaS — it targets a single guild community first.
- Not a replacement for Hypixel's own game systems or a game-modifying mod/client.
- No automated trading, botting, or any behavior that violates Hypixel's rules or TOS.
- No mobile-native apps — the web panel is responsive but browser-based.
- No machine-learning/predictive analytics beyond straightforward reporting.
- No support for non-Skyblock game modes.

## Success Criteria for v1

1. **Reliable bridge** — messages relay between guild chat and Discord in both directions with sub-few-second latency and automatic reconnection after drops.
2. **Working command surface** — core in-game and Discord commands (stats, progression lookups, help) respond accurately for any tracked player.
3. **Functional moderation** — staff can mute/kick/warn/ban-equivalent actions and manage membership from the Admin bot, with an audit trail.
4. **Authenticated panel** — Discord OAuth login works; roles gate access; configuration changes made in the panel take effect on the bots without a redeploy.
5. **Centralized config & analytics** — a single source of truth drives all three surfaces, and basic usage/activity analytics are visible in the panel.
6. **Operable** — the system can be deployed, monitored, and recovered by an operator using documented procedures.

## Major Subsystems & How They Relate

### 1. Bridge / Skyblock Bot (member-facing)
Connects to in-game guild chat and to Discord. Relays messages both ways and handles member-facing commands (stats, progression, help). Consumes Skyblock data from the Stats subsystem and reads its behavior from Centralized Config.

### 2. Admin Bot (staff-facing)
Discord bot exposing moderation and server-administration actions to staff. Writes moderation events and membership changes to the shared Data layer, and honors role/permission rules defined in the panel.

### 3. Web Control Panel
Browser app authenticated via Discord OAuth. Provides configuration, analytics dashboards, and operational control. Reads and writes the Centralized Config and Data layer that the bots consume.

### 4. Skyblock Stats & Progression Service
Fetches, caches, and normalizes player/Skyblock data (skills, networth, progression). Serves both bots and the panel so all surfaces show consistent numbers.

### 5. Centralized Config & Data Layer
The shared source of truth: guild/member records, moderation logs, settings, permissions, and analytics events. Every other subsystem reads and writes here; this is what keeps the three surfaces in agreement.

### 6. Analytics & Reporting
Aggregates activity, command usage, moderation actions, and bridge health from the Data layer into the panel's dashboards.

### Relationship Overview

```
 In-game Guild Chat <──> Bridge/Skyblock Bot ──┐
                                               │
 Discord (members)  <──> Bridge/Skyblock Bot ──┤
                                               ├──> Centralized Config & Data Layer <──> Web Panel (OAuth)
 Discord (staff)    <──> Admin Bot ────────────┤            ▲                                  │
                                               │            │                                  │
                          Skyblock Stats Service┘   Analytics & Reporting <────────────────────┘
```

All surfaces (both bots + panel) depend on the **Centralized Config & Data Layer** as the single point of coordination. The **Stats Service** is a shared read dependency, and **Analytics** is a read/aggregate consumer feeding the panel.
