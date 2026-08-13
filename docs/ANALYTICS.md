# Analytics & Reporting — SBR Guild Platform

Design for `packages/analytics` + the panel's Analytics pages. The system captures events from all surfaces, rolls them into guild-scoped aggregates, and surfaces them in the web panel. Everything is **guild-partitioned**: no query, chart, or export ever crosses guild boundaries — `guildId` is a mandatory dimension on every metric.

**Principles**
- **Capture cheap, aggregate offline.** Hot paths emit lightweight events into Redis; `apps/workers` roll them into Postgres aggregates. Panels read pre-computed rollups, never raw event scans.
- **Facts are immutable.** Events are append-only; rollups are derived and rebuildable.
- **Honest metrics.** Rates state their numerator/denominator; partial/approximate figures are labeled. No silent zero-filling of "unknown."
- **Guild context is non-negotiable.** Every metric row is keyed by `(guildId, period)`.

---

## 1. Metrics Catalog

| Metric | Definition | Source event(s) | Grain | Dimensions | Aggregation |
|--------|-----------|-----------------|-------|-----------|-------------|
| **Bridge messages/day** | Count of messages relayed across the bridge | `bridge.relay` (delivered) | daily | guild, direction (d→ig / ig→d) | count |
| **Most-used commands** | Invocations per command | `command.used` | daily | guild, command, surface, success | count, rank |
| **Command success rate** | successful / total invocations | `command.used` | daily | guild, command, surface | ratio |
| **Command latency** | p50/p95/p99 handler latency | `command.used.latencyMs` | daily | guild, command | percentiles |
| **Linked vs unlinked members** | Members with a `VERIFIED` link vs without | snapshot of `GuildMember`⋈`LinkedAccount` | daily snapshot | guild, status | gauge |
| **Verification funnel** | applied → linked → verified → active | lifecycle events | daily | guild, stage | funnel counts |
| **Onboarding completion** | % of new members who complete link+verify within window (e.g. 7d) | `member.joined`, `link.verified` | cohort/weekly | guild | ratio (cohort) |
| **Event participation** | RSVPs and actual attendance per event | `event.rsvp`, `event.attendance` | per event + daily | guild, event, state | counts, attendance rate |
| **LFG success rate** | LFG posts that filled / reached activity vs expired empty | `lfg.created`, `lfg.joined`, `lfg.filled`, `lfg.expired` | daily | guild, activity | ratio |
| **Moderation action counts** | Actions by type | `mod.action` | daily | guild, type, actor | count |
| **Infractions** | Infractions filed by type/severity | `infraction.filed` | daily | guild, type, severity, source | count |
| **Filter hit counts** | Wordlist rule matches | `filter.hit` | daily | guild, rule, action | count |
| **Bridge suspensions** | Suspend/unsuspend events + downtime | `bridge.suspended/resumed`, `bridge.health` | per event + daily | guild, reason | count, duration |
| **Guild activity trend** | Composite activity index (messages + commands + events + active users) over time | derived from above | daily→weekly | guild | index, trend |
| **Active members** | Distinct members with ≥1 interaction | `command.used`, `bridge.relay` | daily/weekly/monthly | guild | distinct count (DAU/WAU/MAU) |
| **Worker/job failures** | Failed/stale job runs by type | `job.completed(status)` / `WorkerJobLog` | hourly/daily | (platform + guild-scoped jobs) job type, status | count, failure rate |
| **Data-layer health** | Hypixel error / `API_DISABLED` / cache-hit rates | `hypixel.result(state)` | hourly | (platform) state | count, ratio |

*Grain = the finest period a metric is stored at; the panel can roll daily→weekly→monthly on read.*

---

## 2. Event Capture Strategy

### 2.1 What emits events
Every surface emits a small, typed analytics event at the moment of action — never a heavy write on the hot path:

| Surface | Emits |
|---------|-------|
| Bridge bot | `bridge.relay`, `bridge.health`, `command.used`, `lfg.*`, `event.rsvp`, `milestone.earned`, `filter.hit` |
| Admin bot | `mod.action`, `infraction.filed`, `bridge.suspended/resumed`, `filter.hit`, `application.decided`, `command.used(WEB? no→ADMIN)` |
| Web panel | `command.used(surface=WEB_PANEL)`, config-change audit (governance events) |
| Workers | `job.completed`, `hypixel.result`, `member.joined/left` reconciliation, `event.attendance` |

**How the domain packages emit.** `@sbr/bridge` and `@sbr/moderation` do not depend on `@sbr/analytics`; they declare narrow ports (`RelayMetrics`, `ModerationMetrics`) whose every method is **synchronous and returns `void`**. That signature is the design: these calls sit inside a message pipeline and a punishment path, and `void` makes awaiting one impossible rather than merely discouraged, so a full buffer or a dead Redis can never delay a chat line or fail a mute. `createDomainMetrics` in `@sbr/analytics` adapts them onto the stream, swallowing its own failures — a lost count is the cheaper loss by a wide margin. Each composition root supplies the adapter with its own `surface`.

Live emitters, as of Phase 8:

| Event | Emitted from | Dimensions |
| --- | --- | --- |
| `bridge.relay` | `BridgeService.processInbound`, on delivery | `direction` |
| `mod.action` | `ModerationServiceImpl.applyAction`, where it means "a punishment took effect" | `type` |
| `filter.hit` | `AutomodRunner.run` and the relay's `WordlistFilterImpl.check` | `rule`, `action` |

`filter.hit` is recorded **once per matched rule**, not once per message: the question the chart answers is "which rule is doing the work", and collapsing three matches into one would answer it wrongly.

### 2.2 Event envelope
A uniform shape so anything can be rolled up generically:
```
{ type, guildId, actorId?, targetId?, surface, ts, props{…}, correlationId }
```
- `guildId` **required** (platform-scoped events use a sentinel/`null` guild bucket).
- `props` holds metric-specific fields (command name, direction, latencyMs, rule id, mod type, job status…).
- `correlationId` links related events (e.g. an infraction → its mod action).

### 2.3 Ingest path (capture cheap)
```
hot path → emit event → Redis Stream  buf:analytics  (append-only, cheap)
                          │
      apps/workers  analytics-ingest  (consumer group, batched)
                          │
              validate + route → append to  AnalyticsEvent  (raw, partitioned by day)
                          │
              increment live counters (optional) for near-real-time tiles
```
- **Primary buffer:** a Redis Stream (`buf:analytics`) decouples producers from the DB; a worker consumer group drains it in batches → `AnalyticsEvent` (raw fact table, partitioned by `(guildId, day)`).
- **Optional real-time tiles:** a few high-value counters (today's bridge messages, today's commands) also `INCR` Redis keys (`stat:{guildId}:{metric}:{day}`) so the Overview shows live-ish numbers without waiting for a rollup; these are reconciled against the authoritative rollup nightly.
- **Backpressure:** if the DB is slow, events accumulate in the stream (bounded by `MAXLEN`), not on the hot path. Loss policy: prefer dropping oldest low-value events over blocking a command.
- **Idempotency:** each event carries an id; the ingest consumer dedups so restarts don't double-count.

---

## 3. Rollup Schedule

Workers turn raw events into query-ready aggregates. Rollups are **idempotent and rebuildable** — re-running a day recomputes from raw facts.

| Rollup | Cadence | Reads | Writes | Notes |
|--------|---------|-------|--------|-------|
| **Near-real-time counters** | continuous (on ingest) | stream | Redis `stat:*` | For live Overview tiles only |
| **Hourly rollup** | every hour | `AnalyticsEvent` (current hour) | `MetricHourly(guildId,metric,dims,hour)` | Job health, data-layer health, intraday |
| **Daily rollup** | ~00:15 guild-local (staggered minute) | `AnalyticsEvent` (prev day) | `MetricDaily(guildId,metric,dims,day)` | The workhorse; most panel charts read this |
| **Member-state snapshot** | daily | `GuildMember`⋈`LinkedAccount` | `MemberStateDaily` | Linked/unlinked gauge, verification funnel |
| **Weekly/monthly rollup** | weekly (Mon), monthly (1st) | `MetricDaily` | `MetricWeekly`/`MetricMonthly` | Trends; cheap re-aggregation of daily |
| **Cohort/onboarding** | daily (evaluates matured cohorts) | join + verify events | `OnboardingCohort` | 7-day completion window per join cohort |
| **Activity index** | daily | multiple daily metrics | `MetricDaily(activity_index)` | Weighted composite |
| **Reconciliation** | nightly | raw vs Redis counters | corrects `stat:*` | Keeps live tiles honest |

- **Staggering:** daily jobs fire on an off-minute per guild timezone to avoid a thundering herd (aligns with the "avoid :00" rate-limit hygiene).
- **Locking:** each rollup takes a Redis lock (`lock:rollup:{name}:{period}`) so overlapping runs can't double-write.
- **Rebuild path:** deleting a `MetricDaily` partition and re-running the job fully reconstructs it from `AnalyticsEvent`.

---

## 4. Suggested Charts / Tables (Panel)

All panel widgets read **rollup tables** (`MetricDaily`/`Weekly`/`Monthly`) filtered by `guildId` + date range + optional surface. Read-only; no live Hypixel calls.

| Widget | Type | Backing metric |
|--------|------|----------------|
| Bridge messages over time | Stacked area (by direction) | Bridge messages/day |
| Top commands | Horizontal bar + table (rank, count, success %, p95) | Most-used commands / success / latency |
| Command mix by surface | Donut | command.used by surface |
| Linked vs unlinked | Donut + trend line | Member-state snapshot |
| Verification funnel | Funnel | Verification funnel |
| Onboarding completion | Cohort line + % tile | Onboarding completion |
| Event participation | Grouped bar (RSVP vs attended) per event + table | Event participation |
| LFG success rate | Line + % tile, breakdown by activity | LFG success rate |
| Moderation actions | Stacked bar by type + table | Mod action counts / infractions |
| Filter hits | Bar by rule + table (rule, hits, action) | Filter hit counts |
| Guild activity trend | Line (activity index) + DAU/WAU/MAU tiles | Activity index / active members |
| Bridge uptime & suspensions | Timeline/heatmap + downtime tile | Bridge suspensions / health |
| Worker/job health | Table (job, last run, failures, stale flag) + failure-rate sparkline | Worker/job failures |
| Data-layer health | Tiles (API error %, cache hit %, rate budget) | Data-layer health |

- **Every chart:** guild-scoped, date-range picker, CSV export, and an "as of" freshness stamp (last rollup time).
- **Overview page** shows the live-ish tiles (today's messages/commands, open items, worker freshness); **Analytics page** shows the full historical set.
- **Empty/insufficient-data states** are explicit ("no events in range"), never a misleading zero line.

---

## 5. Data Retention Policy

Retention is tiered by grain — raw facts are pruned aggressively, aggregates kept long.

| Tier | Data | Retention | Rationale |
|------|------|-----------|-----------|
| **Live counters** | Redis `stat:*` | 48h (TTL) | Only for real-time tiles; authoritative copy is in rollups |
| **Ingest buffer** | Redis Stream `buf:analytics` | Trimmed (`MAXLEN`) once consumed | Transient transport |
| **Raw events** | `AnalyticsEvent` | **30–90 days** (partitioned, dropped by partition) | Enables rebuilds & drill-down; largest volume |
| **Hourly rollups** | `MetricHourly` | 30 days | Intraday/ops detail |
| **Daily rollups** | `MetricDaily` | 13 months | Year-over-year comparison |
| **Weekly/Monthly** | `MetricWeekly/Monthly` | 24+ months / indefinite | Long-term trends, cheap to keep |
| **Audit/moderation facts** | `ModerationAction`, `Infraction` (in `packages/db`) | Governed separately (see below) | Compliance/accountability, not "analytics" retention |
| **Cohort tables** | `OnboardingCohort` | 13 months | Onboarding trend |

**Rules**
- **Aggregates outlive raw.** Once a day is rolled up and reconciled, the raw partition can expire without losing chart data (drill-down is lost, not trends).
- **Moderation/audit data is NOT subject to analytics pruning** — it lives in the durable domain tables with its own (longer) retention and is only *read* by analytics; deleting an old raw analytics event never removes an infraction record.
- **PII minimization:** events store ids, not message content; `filter.hit` stores the rule + action, not the offending text. `/purge` analytics record scope+count, not messages.
- **Deletion requests:** a member-removal/GDPR-style request purges their raw events and re-derives affected rollups from remaining facts (aggregates are non-identifying counts, so they survive).
- **Retention is configurable per tier** but defaults above; partition-drop makes pruning O(1) rather than row-by-row deletes.

---

## 6. Known Limitations

- **Not real-time by default.** Most numbers are as-of the last rollup (hourly/daily). Only a few Overview tiles are near-real-time via Redis counters; the Analytics page is intentionally batch. Charts carry an "as of" stamp so this is visible, not surprising.
- **Approximate live tiles.** Redis `INCR` counters can drift on crashes/restarts; they're reconciled nightly against the authoritative rollup, so intraday tiles are indicative, not audit-grade.
- **Distinct-count cost.** DAU/WAU/MAU need distinct-user tracking; exact counts are stored per day, but rolling distinct across weeks/months is approximate unless we keep per-user sets (cost tradeoff — may use HyperLogLog for large guilds, which is ~±2% error).
- **Attendance depends on staff input.** `event.attendance` is only as accurate as staff marking it; RSVP↔attendance gaps reflect behavior *and* data-entry, and the panel labels attendance as staff-reported.
- **LFG "success" is heuristic.** "Filled/reached activity" is inferred from joins/slots, not a guaranteed real party outcome — a post can fill and still not run. Metric is labeled as an approximation.
- **Bridge counts exclude blocked/unrelayed.** By default `bridge.relay` counts *delivered* messages; blocked/filtered ones are a separate metric (`filter.hit`), so "messages" ≠ "all attempts." Documented on the chart.
- **Cross-guild benchmarking is out of scope.** Guild partitioning is strict; there's no "compare to other guilds" view by design (privacy + scope).
- **Raw drill-down is time-bounded.** After the raw retention window, you can see trends but can't drill into individual historical events.
- **Backfill limits.** Metrics only exist from when capture was deployed; historical Hypixel/Discord data isn't retroactively reconstructable beyond what workers snapshotted.
- **Discord playtime is not sampled yet.** The presence-based estimate needs `XpService.recordPresence`, which exists but has no caller — so `ActivityDaily.presenceSamples` is always zero and the panel's Playtime card reads "Not sampled" rather than showing a fabricated hour count. The in-game half (days with GEXP > 0) works today.
- **Playtime is an estimate on both sides.** Presence is sampled at the `guild-scan` cadence, not measured; a day with GEXP says somebody played, not for how long. Both are labelled on the card.
- **GEXP and per-member activity require a verified link.** An unlinked Discord member has no uuid, so their GEXP and active-day figures are `null` — rendered as an em dash, never as zero. Link coverage is therefore the ceiling on how much of the roster these metrics can describe.
- **Timezone edges.** Daily rollups use guild-local day boundaries; guilds spanning many timezones will see "days" defined by the configured guild timezone, not each member's local day.

---

## 7. Summary

- **Guild-partitioned metrics catalog** covering all ten required metrics plus supporting ones (latency, funnels, activity index, data-layer health).
- **Capture cheap → aggregate offline:** typed events → Redis Stream → worker ingest → raw `AnalyticsEvent` → idempotent hourly/daily/weekly rollups.
- **Panel reads rollups only**, guild-scoped, date-ranged, exportable, with honest "as of" freshness and explicit empty states.
- **Tiered retention:** raw pruned in 30–90d, daily kept 13 months, weekly/monthly long-term; moderation/audit data governed separately and never analytics-pruned.
- **Limitations are stated up front:** batch-not-live, approximate distinct counts and live tiles, staff-dependent attendance, heuristic LFG success — all labeled in-product.
