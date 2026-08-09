/**
 * Job definitions for the workers process, bound to the live adapters. Each is a
 * plain JobDefinition the JobRunner executes (lock + retry + WorkerJobLog); the
 * BullMQ scheduler decides *when*.
 *
 * The pattern throughout: the pure job logic lives in `@sbr/jobs` behind injected
 * ports, and this file is the only place those ports meet Hypixel, Redis and
 * Postgres. That is what makes the logic testable without any of them running.
 */
import { bucketStart, rollupEvents } from "@sbr/analytics";
import {
  analyticsJobRepository,
  eventJobRepository,
  maintenanceJobRepository,
  snapshotJobRepository,
  guildRepository,
  guildScanRepository,
} from "@sbr/db";
import {
  defineAnalyticsIngestJob,
  defineAnalyticsRollupJob,
  defineAuctionSweepJob,
  defineBazaarRefreshJob,
  defineConfigInvalidationJob,
  defineEndedAuctionJob,
  defineEventTransitionJob,
  defineGuildScanJob,
  defineInactivityScanJob,
  defineMilestoneDetectJob,
  defineProfileSnapshotJob,
  defineReminderDispatchJob,
  defineResourcesRefreshJob,
  defineRosterSyncJob,
  detectAndRecord,
  dispatchReminders,
  ingestAnalytics,
  ingestEndedAuctions,
  invalidateConfigCaches,
  refreshBazaar,
  refreshResources,
  scanGuild,
  scanInactivity,
  snapshotProfiles,
  sweepAuctions,
  syncRoster,
  transitionEvents,
  type JobDefinition,
} from "@sbr/jobs";
import type { WorkerContext } from "./composition.js";

/** How long a swept BIN reading stays readable before the key expires. */
const BIN_TTL_MS = 30 * 60_000;
/** Cached prices outlive the refresh cadence so an outage degrades to stale. */
const PRICE_TTL_SECONDS = 30 * 60;
/** Realised-sale stats and reference data both outlive their refresh interval. */
const SALES_TTL_SECONDS = 2 * 60 * 60;
const RESOURCE_TTL_SECONDS = 12 * 60 * 60;
/** Reference endpoints worth keeping warm; each is independent of the others. */
const RESOURCE_NAMES = ["skills", "collections", "items"] as const;
/** Cap on accounts examined for milestones per run, to bound a cold start. */
const MILESTONE_BATCH = 200;

export function buildJobDefinitions(ctx: WorkerContext): Map<string, JobDefinition<number>> {
  const { keys, client } = ctx.redis;

  const heartbeat: JobDefinition<number> = {
    name: "heartbeat",
    queue: "ops",
    lockKey: keys.lockJob("heartbeat"),
    maxRetries: 0,
    handler: async () => {
      await client.set(keys.cacheGlobal("worker-heartbeat"), new Date().toISOString(), { EX: 120 });
      return 1;
    },
  };

  const bazaar: JobDefinition<number> = {
    ...defineBazaarRefreshJob(async () =>
      refreshBazaar({
        async fetchBazaar() {
          const result = await ctx.hypixel.getBazaar();
          return result.ok ? result.value.data.products : null;
        },
        // Blending in the AH side keeps `/price` honest for items that trade on
        // both; a cold sweep simply leaves that half unknown.
        async knownLowestBin(itemId) {
          const entry = await ctx.adapters.bins.get(itemId);
          return entry?.price ?? null;
        },
        async writePrice(itemId, price) {
          await client.set(keys.cachePriceItem(itemId), JSON.stringify(price), {
            EX: PRICE_TTL_SECONDS,
          });
        },
      }),
    ),
    lockKey: keys.lockJob("bazaar"),
  };

  const ahSweep: JobDefinition<number> = {
    ...defineAuctionSweepJob(async () =>
      sweepAuctions({
        async fetchPage(page) {
          const result = await ctx.hypixel.getAuctions(page);
          return result.ok ? result.value.data : null;
        },
        async writeBin(itemId, entry) {
          await ctx.adapters.bins.put(itemId, entry, BIN_TTL_MS);
        },
      }),
    ),
    lockKey: keys.lockJob("ah-sweep"),
  };

  const ahEnded: JobDefinition<number> = {
    ...defineEndedAuctionJob(async () =>
      ingestEndedAuctions({
        async fetchEnded() {
          const result = await ctx.hypixel.getEndedAuctions();
          if (!result.ok) return null;
          // The item identity comes out of the NBT blob the client decodes; a
          // sale whose blob was unreadable is dropped by the job itself.
          return result.value.data.auctions.map((a) => ({
            auctionId: a.auctionId,
            itemId: a.itemId,
            itemName: a.itemName,
            // Per-unit, so a stack of 64 doesn't report as a 64× price.
            price: a.price === null ? null : a.price / Math.max(1, a.count),
            bin: a.bin,
          }));
        },
        async writeSales(stats) {
          await client.set(keys.cacheGlobal(`sales:${stats.itemId}`), JSON.stringify(stats), {
            EX: SALES_TTL_SECONDS,
          });
        },
      }),
    ),
    lockKey: keys.lockJob("ah-ended"),
  };

  const resources: JobDefinition<number> = {
    ...defineResourcesRefreshJob(async () =>
      refreshResources({
        resources: Object.fromEntries(
          RESOURCE_NAMES.map((name) => [
            name,
            async () => {
              const result = await ctx.hypixel.getResources(name);
              return result.ok ? result.value.data.data : null;
            },
          ]),
        ),
        async writeResource(name, payload) {
          await client.set(keys.cacheResource(name), JSON.stringify(payload), {
            EX: RESOURCE_TTL_SECONDS,
          });
        },
      }),
    ),
    lockKey: keys.lockJob("resources"),
  };

  // ─────────────────────────── progression ───────────────────────────

  const snapshot: JobDefinition<number> = {
    ...defineProfileSnapshotJob(async () =>
      snapshotProfiles({
        listTracked: () => snapshotJobRepository.listTracked(),
        async capture(account) {
          const profileId = account.profileId ?? undefined;
          // The profile summary already carries skill average, catacombs level
          // and Senither weight — the same three numbers `/stats` prints. Only
          // networth needs a second call, because it requires a priced pass.
          // Both reads hit one cached profile fetch, not two upstream calls.
          const [summary, networth] = await Promise.all([
            ctx.progression.getProfileSummary(account.uuid, profileId),
            ctx.progression.getNetworth(account.uuid, profileId),
          ]);
          // No readable profile at all means there is nothing to snapshot;
          // individual metrics that failed simply record as unknown.
          if (!summary.ok) return null;

          return {
            profileId: summary.value.data.profileId,
            metrics: {
              networth: networth.ok ? networth.value.data.total : null,
              skillAverage: summary.value.data.skillAverage,
              catacombsLevel: summary.value.data.catacombsLevel,
              senitherWeight: summary.value.data.senitherWeight,
            },
          };
        },
        write: (row) => snapshotJobRepository.write(row),
      }),
    ),
    lockKey: keys.lockJob("snapshot"),
  };

  const milestones: JobDefinition<number> = {
    ...defineMilestoneDetectJob(async () => {
      const accounts = await snapshotJobRepository.listAccountsWithHistory(MILESTONE_BATCH);
      let recorded = 0;
      for (const accountId of accounts) {
        recorded += await detectAndRecord(accountId, {
          recentSnapshots: (id) => snapshotJobRepository.recentSnapshots(id),
          // guildId stays null: a milestone belongs to the account, and the
          // account can be in more than one guild.
          record: (candidate) => snapshotJobRepository.record(candidate, null),
        });
      }
      return recorded;
    }),
    lockKey: keys.lockJob("milestones"),
  };

  // ───────────────────────────── community ─────────────────────────────

  const eventTransition: JobDefinition<number> = {
    ...defineEventTransitionJob(async () =>
      transitionEvents({
        listOpenEvents: () => eventJobRepository.listOpenEvents(),
        setStatus: (id, status) => eventJobRepository.setStatus(id, status),
      }),
    ),
    lockKey: keys.lockJob("event-transition"),
  };

  const reminders: JobDefinition<number> = {
    ...defineReminderDispatchJob(async () =>
      dispatchReminders({
        listOpenEvents: () => eventJobRepository.listOpenEvents(),
        listAttendees: (eventId) => eventJobRepository.listAttendees(eventId),
        async notify(event, discordIds, offsetMinutes) {
          // Workers hold no gateway connection, so the ping is published to the
          // bridge channel and the bot that owns the guild delivers it. That
          // also means a restarting bot doesn't cost the reminder its send —
          // the offset is only marked after this resolves.
          await client.publish(
            keys.chanBridge(event.guildId),
            JSON.stringify({
              kind: "event-reminder",
              eventId: event.id,
              title: event.title,
              startsAt: event.startsAt,
              offsetMinutes,
              discordIds,
            }),
          );
        },
        markSent: (eventId, offset) => eventJobRepository.markReminderSent(eventId, offset),
      }),
    ),
    lockKey: keys.lockJob("reminders"),
  };

  // ──────────────────────────── maintenance ────────────────────────────

  const rosterSync: JobDefinition<number> = {
    ...defineRosterSyncJob(async () => {
      const guilds = await guildRepository.listActive();
      let changed = 0;
      for (const guild of guilds) {
        if (!guild.hypixelGuildId) continue;
        const result = await syncRoster(guild.id, {
          async fetchRemoteRoster(_guildId) {
            const remote = await ctx.hypixel.getGuild(guild.hypixelGuildId!, "id");
            return remote.ok ? remote.value.data.members : null;
          },
          listStoredRoster: (id) => maintenanceJobRepository.listStoredRoster(id),
          applyJoined: (id, members) => maintenanceJobRepository.applyJoined(id, members),
          applyLeft: (id, rows) => maintenanceJobRepository.applyLeft(id, rows),
          applyRankChanges: (id, changes) => maintenanceJobRepository.applyRankChanges(id, changes),
        });
        if (result.skipped) {
          ctx.log.warn("roster sync skipped", { guildId: guild.id, reason: result.skipped });
          continue;
        }
        changed += result.joined + result.left + result.rankChanged;
      }
      return changed;
    }),
    lockKey: keys.lockJob("roster"),
  };

  const guildScan: JobDefinition<number> = {
    ...defineGuildScanJob(async () => {
      const guilds = await guildRepository.listActive();
      let members = 0;
      for (const guild of guilds) {
        const hypixelGuildId = guild.hypixelGuildId;
        if (!hypixelGuildId) {
          // Nothing to scan, and nothing worth an audit row every six hours.
          ctx.log.debug("guild scan skipped: no hypixel guild linked", { guildId: guild.id });
          continue;
        }
        const result = await scanGuild(guild.id, {
          async fetchRoster() {
            const remote = await ctx.hypixel.getGuild(hypixelGuildId, "id");
            return remote.ok ? remote.value.data.members : null;
          },
          listCached: (id) => guildScanRepository.listCache(id),
          async resolveNames(uuids) {
            const names: Record<string, string> = {};
            // Sequential on purpose: Mojang rate-limits hard and this batch is
            // small and never on a user's critical path.
            for (const uuid of uuids) {
              const name = await ctx.hypixel.resolveIgn(uuid).catch(() => null);
              if (name !== null) names[uuid] = name;
            }
            return names;
          },
          upsertMembers: (id, rows) => guildScanRepository.upsertMembers(id, rows),
          removeMembers: (id, uuids) => guildScanRepository.removeMembers(id, uuids),
          writeGexp: (id, rows) => guildScanRepository.writeGexp(id, rows),
          recordScan: (id, result, error) => guildScanRepository.recordScan(id, result, error),
        });
        if (result.skipped) {
          ctx.log.warn("guild scan incomplete", { guildId: guild.id, reason: result.skipped });
          continue;
        }
        ctx.log.info("guild scanned", {
          guildId: guild.id,
          members: result.memberCount,
          joined: result.joined.length,
          left: result.left.length,
          gexpRows: result.gexpRows,
        });
        members += result.memberCount;
      }
      return members;
    }),
    lockKey: keys.lockJob("guild-scan"),
  };

  const inactivity: JobDefinition<number> = {
    ...defineInactivityScanJob(async () => {
      const guilds = await guildRepository.listActive();
      let flagged = 0;
      for (const guild of guilds) {
        flagged += await scanInactivity(guild.id, {
          listActivity: (id) => maintenanceJobRepository.listActivity(id),
          async flag(id, flags) {
            // Advisory only — the scan never kicks. It publishes to the guild's
            // channel so staff decide, which is the documented behaviour.
            await client.publish(
              keys.chanMod(id),
              JSON.stringify({ kind: "inactivity-flags", guildId: id, flags }),
            );
          },
        });
      }
      return flagged;
    }),
    lockKey: keys.lockJob("inactivity"),
  };

  // ───────────────────────────── analytics ─────────────────────────────

  const analyticsIngest: JobDefinition<number> = {
    ...defineAnalyticsIngestJob(async () =>
      ingestAnalytics({
        drain: (n) => ctx.adapters.analyticsDrain.read(n),
        async persist(events) {
          await analyticsJobRepository.persistEvents(
            events.map((e) => {
              const event = e as { guildId: string | null; discordId: string | null; surface: string; type: string; props: Readonly<Record<string, unknown>>; ts: string };
              return {
                guildId: event.guildId,
                discordId: event.discordId,
                surface: event.surface,
                type: event.type,
                props: event.props,
                ts: event.ts,
              };
            }),
          );
        },
        async ack(events) {
          await ctx.adapters.analyticsDrain.ack(events.map((e) => (e as { id: string }).id));
        },
      }),
    ),
    lockKey: keys.lockJob("analytics-ingest"),
  };

  const analyticsRollup: JobDefinition<number> = {
    ...defineAnalyticsRollupJob(async () => {
      const now = new Date();
      // Recompute yesterday *and* today. Today is still filling, and yesterday
      // may have gained late-ingested events after its first pass — replacing
      // the whole partition each time is what makes that correct rather than
      // additive.
      const todayStart = new Date(bucketStart(now.toISOString(), "DAILY"));
      const from = new Date(todayStart.getTime() - 24 * 60 * 60_000);
      const to = new Date(todayStart.getTime() + 24 * 60 * 60_000);

      const events = await analyticsJobRepository.listEvents(from, to);
      let rows = 0;
      for (const period of ["HOURLY", "DAILY"] as const) {
        const computed = rollupEvents(
          events.map((e) => ({
            guildId: e.guildId,
            discordId: e.discordId,
            surface: e.surface as never,
            type: e.type,
            props: e.props,
            ts: e.ts,
          })),
          period,
        );
        rows += await analyticsJobRepository.replaceRollups(period, from, to, computed);
      }
      return rows;
    }),
    lockKey: keys.lockJob("rollup", "daily"),
  };

  const configInvalidation: JobDefinition<number> = {
    ...defineConfigInvalidationJob(async () => {
      const watermarkKey = keys.cacheGlobal("config-invalidation-watermark");
      return invalidateConfigCaches({
        listChangedGuilds: (since) => maintenanceJobRepository.listChangedGuilds(since),
        async invalidate(guildId) {
          // Publishing rather than deleting a key: config is cached in each
          // bot's process, so eviction has to reach them, not just Redis.
          await client.publish(keys.chanConfig(guildId), JSON.stringify({ kind: "config-invalidate", guildId }));
        },
        async watermark() {
          const raw = await client.get(watermarkKey);
          if (!raw) return null;
          const at = new Date(raw);
          return Number.isNaN(at.getTime()) ? null : at;
        },
        async setWatermark(at) {
          await client.set(watermarkKey, at.toISOString());
        },
      });
    }),
    lockKey: keys.lockJob("config-invalidate"),
  };

  const definitions = [
    heartbeat,
    bazaar,
    ahSweep,
    ahEnded,
    resources,
    snapshot,
    milestones,
    eventTransition,
    reminders,
    rosterSync,
    guildScan,
    inactivity,
    analyticsIngest,
    analyticsRollup,
    configInvalidation,
  ];
  return new Map(definitions.map((d) => [d.name, d]));
}
