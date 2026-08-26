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
  moderationRepository,
  snapshotJobRepository,
  milestoneDefinitionRepository,
  guildConfigRepository,
  guildRepository,
  guildScanRepository,
  discordSyncRepository,
  xpRepository,
  activitySink,
  ticketRepository,
  roleGrantRepository,
  roleSyncRepository,
} from "@sbr/db";
import {
  defineAnalyticsIngestJob,
  defineAnalyticsRollupJob,
  defineAuctionSweepJob,
  defineBazaarRefreshJob,
  defineConfigInvalidationJob,
  defineDiscordMemberSyncJob,
  defineEndedAuctionJob,
  defineEventTransitionJob,
  defineGuildScanJob,
  defineInactivityScanJob,
  defineMilestoneBackfillJob,
  defineMilestoneDetectJob,
  defineEventBoardJob,
  defineLeaderboardPostJob,
  defineEventTrackingJob,
  defineProfileRefreshJob,
  definePunishmentExpiryJob,
  defineReminderDispatchJob,
  defineResourcesRefreshJob,
  defineRoleSyncJob,
  defineRosterSyncJob,
  defineTicketSweepJob,
  defineXpAggregateJob,
  backfillMilestones,
  detectAndRecord,
  dispatchReminders,
  ingestAnalytics,
  ingestEndedAuctions,
  invalidateConfigCaches,
  refreshBazaar,
  refreshResources,
  scanGuild,
  scanInactivity,
  refreshProfiles,
  trackEvents,
  type TrackedAccount,
  sweepAuctions,
  sweepTickets,
  syncDiscordMembers,
  syncRoles,
  MAX_MEMBERS_PER_PASS,
  syncRoster,
  postLeaderboardDigests,
  publishEventBoards,
  transitionEvents,
  type JobDefinition,
  type DiscordMemberRow,
  type MilestoneDefinition,
} from "@sbr/jobs";
import { AUTO_ROLES_SETTING_KEY, parseAutoRoles } from "@sbr/roles";
import { XpService } from "@sbr/xp";
import { createWorkerTicketBridge } from "./ticket-bridge.js";
import { createWorkerEventBoard } from "./event-board-bridge.js";
import { createWorkerLeaderboardDigest } from "./leaderboard-digest-bridge.js";
import { createWorkerRoleEffector } from "./role-bridge.js";
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
/**
 * How long a claimed auto-role full sweep stays claimed.
 *
 * A day. The sweep exists so that a rule written this afternoon reaches members
 * who qualified last year, and so that a dirty mark lost to a Redis flush costs
 * at most a day of staleness. Any shorter and every guild pays a full-roster
 * pass for work the dirty set already handles.
 */
const ROLE_SWEEP_TTL_SECONDS = 24 * 60 * 60;
/**
 * How long a "this ticket has been warned" flag lives.
 *
 * A day, which is longer than any sensible auto-close window and shorter than
 * forever. The flag exists to stop a warning repeating every few minutes; once
 * a ticket has been quiet, resumed, and gone quiet again a day later, warning
 * it a second time is the right thing rather than a duplicate.
 */
const TICKET_WARNED_TTL_SECONDS = 24 * 60 * 60;
/** Cap on accounts examined for milestones per run, to bound a cold start. */
const MILESTONE_BATCH = 200;

/**
 * `YYYY-MM-DD`, `offsetDays` from today, in UTC. XP's day grain is UTC
 * everywhere — counters, awards and this job all have to agree on where the
 * boundary is, and UTC is the only clock all three can read without a guild
 * timezone.
 */
function dayString(offsetDays: number): string {
  const at = new Date(Date.now() + offsetDays * 24 * 60 * 60_000);
  return at.toISOString().slice(0, 10);
}

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

  /**
   * One profile capture, shared by the bulk snapshot cadence and the event
   * tracker. Two copies of this would be two definitions of what a snapshot
   * contains, and the event leaderboard would eventually be measuring something
   * subtly different from the progression charts.
   */
  const captureProfile = async (account: TrackedAccount) => {
    const profileId = account.profileId ?? undefined;
    // The profile summary already carries SkyBlock Level, skill average,
    // catacombs level, Senither weight and the bestiary milestone — the numbers
    // `/stats` prints. Networth needs a second call because it requires a priced
    // pass; dungeons and slayers need one because the per-class and per-boss
    // breakdowns are not on the summary. All four reads hit the same cached
    // profile fetch, so this is one upstream call, not four.
    const [summary, networth, dungeons, slayers] = await Promise.all([
      ctx.progression.getProfileSummary(account.uuid, profileId),
      ctx.progression.getNetworth(account.uuid, profileId),
      ctx.progression.getDungeons(account.uuid, profileId),
      ctx.progression.getSlayers(account.uuid, profileId),
    ]);
    // No readable profile at all means there is nothing to snapshot;
    // individual metrics that failed simply record as unknown.
    if (!summary.ok) return null;

    // Absent rather than zero, always: a member whose dungeon read failed has
    // not been demoted to Healer 0, and a threshold must never fire off a gap.
    const classLevel = (name: string): number | null =>
      dungeons.ok ? (dungeons.value.data.classes.find((c) => c.name === name)?.level ?? null) : null;
    const slayerXpOf = (boss: string): number | null =>
      slayers.ok ? (slayers.value.data.bosses.find((b) => b.boss === boss)?.experience ?? null) : null;

    return {
      profileId: summary.value.data.profileId,
      metrics: {
        skyblockLevel: summary.value.data.skyblockLevel,
        networth: networth.ok ? networth.value.data.total : null,
        skillAverage: summary.value.data.skillAverage,
        catacombsLevel: summary.value.data.catacombsLevel,
        slayerXp: summary.value.data.slayerXp,
        senitherWeight: summary.value.data.senitherWeight,
        bestiaryMilestone: summary.value.data.bestiaryMilestone,
        classHealer: classLevel("healer"),
        classMage: classLevel("mage"),
        classBerserk: classLevel("berserk"),
        classArcher: classLevel("archer"),
        classTank: classLevel("tank"),
        slayerZombie: slayerXpOf("zombie"),
        slayerSpider: slayerXpOf("spider"),
        slayerWolf: slayerXpOf("wolf"),
        slayerEnderman: slayerXpOf("enderman"),
        slayerBlaze: slayerXpOf("blaze"),
        slayerVampire: slayerXpOf("vampire"),
      },
    };
  };

  const snapshot: JobDefinition<number> = {
    ...defineProfileRefreshJob(async () =>
      refreshProfiles({
        listTracked: () => snapshotJobRepository.listTracked(),
        capture: captureProfile,
        write: (row) => snapshotJobRepository.write(row),
      }),
    ),
    lockKey: keys.lockJob("snapshot"),
  };

  const eventTracking: JobDefinition<number> = {
    ...defineEventTrackingJob(async () =>
      trackEvents({
        listLiveTracked: () => eventJobRepository.listLiveTracked(),
        listParticipants: (eventId) => eventJobRepository.listParticipants(eventId),
        capture: captureProfile,
        write: (row) => snapshotJobRepository.write(row),
        writeBaseline: (row) => snapshotJobRepository.writeBaseline(row),
        writeFinal: (row) => snapshotJobRepository.writeFinal(row),
        upsertScore: (write) => eventJobRepository.upsertScore(write),
        async claimPoll(eventId, ttlSeconds) {
          // The job runner's own lock, reused at event granularity — same
          // SET NX and same owner-checked release, so a pass can never free a
          // claim that a later pass took over after its TTL ran out.
          const key = keys.eventPoll(eventId);
          const token = await ctx.adapters.lock.acquire(key, ttlSeconds * 1_000);
          if (token === null) return null;
          return () => ctx.adapters.lock.release(key, token);
        },
        onError(scope, error) {
          ctx.log.warn("event tracking failed", { scope, error: String(error) });
        },
      }),
    ),
    lockKey: keys.lockJob("event-tracking"),
  };

  const milestones: JobDefinition<number> = {
    ...defineMilestoneDetectJob(async () => {
      const xp = new XpService({
        repo: xpRepository,
        activity: activitySink,
        cooldowns: ctx.adapters.cooldowns,
        logger: ctx.log,
      });
      const targets = await snapshotJobRepository.listAccountsForDetection(MILESTONE_BATCH);
      // One read per guild rather than one per account: a batch is mostly the
      // same handful of guilds, and the definitions do not change mid-run.
      const definitionsByGuild = new Map<string, readonly MilestoneDefinition[]>();

      let recorded = 0;
      for (const target of targets) {
        if (target.guildId !== null && !definitionsByGuild.has(target.guildId)) {
          definitionsByGuild.set(
            target.guildId,
            await milestoneDefinitionRepository.listForDetection(target.guildId),
          );
        }
        const definitions = target.guildId === null ? [] : definitionsByGuild.get(target.guildId) ?? [];

        recorded += await detectAndRecord(target.minecraftAccountId, {
          recentReadings: (id) => snapshotJobRepository.recentReadings(id),
          definitions,
          record: async (candidate) => {
            const isNew = await snapshotJobRepository.record(candidate, target.guildId, target.discordId);
            if (!isNew) return false;

            // Covers both achievement rules and the level rules the reward
            // below may push somebody over. One mark, either way.
            if (target.guildId !== null && target.discordId !== null) {
              await ctx.adapters.rolesDirty.mark(target.guildId, [target.discordId]);
            }

            // Paid at detection, not at announcement: `announce` governs
            // whether the guild sees it, and a milestone a guild chose to
            // recognise quietly is still one it meant to reward. The dedupe key
            // is the milestone's own id, so a replay credits nothing twice.
            if (candidate.xpReward > 0 && target.guildId !== null && target.discordId !== null) {
              try {
                await xp.awardMilestone(
                  target.guildId,
                  target.discordId,
                  candidate.xpReward,
                  `${target.minecraftAccountId}:${candidate.key}`,
                  candidate.label,
                );
              } catch (error) {
                // The milestone row is already committed and the announcer will
                // still post it. Losing the reward is worth reporting; losing
                // the rest of the batch to it is not.
                ctx.log.error("milestone reward failed", {
                  key: candidate.key,
                  discordId: target.discordId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
            return true;
          },
        });
      }
      return recorded;
    }),
    lockKey: keys.lockJob("milestones"),
  };

  /**
   * The catch-up pass. Everything it writes is born announced, so a guild that
   * turns achievements on today sees its history in the panel and hears nothing
   * in its channel. No XP either: paying retroactively for thresholds crossed
   * before the guild had a ledger would hand out months of rewards overnight.
   */
  const milestoneBackfill: JobDefinition<number> = {
    ...defineMilestoneBackfillJob(async () => {
      const written = await backfillMilestones({
        listTargets: (limit, offset) => snapshotJobRepository.listAccountsForBackfill(limit, offset),
        latestSnapshot: (id) => snapshotJobRepository.latestSnapshot(id),
        definitionsFor: async (guildId) =>
          guildId === null ? [] : milestoneDefinitionRepository.listForDetection(guildId),
        record: (target, candidate) =>
          snapshotJobRepository.record(candidate, target.guildId, target.discordId, true),
      });
      if (written > 0) ctx.log.info("milestones back-filled", { written });
      return written;
    }),
    lockKey: keys.lockJob("milestone-backfill"),
  };

  const xpAggregate: JobDefinition<number> = {
    ...defineXpAggregateJob(async () => {
      // Built per run rather than per registry, because every job body here is
      // a closure that touches the context only when the queue invokes it — the
      // service is cheap and stateless, and constructing it eagerly would make
      // this the one definition that needs live adapters just to be listed.
      // The cooldown gate is passed because the service takes one, not because
      // aggregation consults it; nothing on this path is rate-limited.
      const xp = new XpService({
        repo: xpRepository,
        activity: activitySink,
        cooldowns: ctx.adapters.cooldowns,
        logger: ctx.log,
      });
      const guilds = await guildRepository.listActive();
      // Yesterday as well as today, for the same reason the analytics rollup
      // recomputes its previous partition: today's counters are still climbing,
      // and yesterday can still gain a late GEXP row from a guild scan that
      // straddled midnight. Both passes overwrite by dedupe key, so re-deriving
      // a day converges rather than double-crediting it.
      const days = [dayString(-1), dayString(0)];
      let written = 0;
      for (const guild of guilds) {
        for (const day of days) {
          try {
            const summary = await xp.aggregate(guild.id, day);
            written += summary.awardsWritten;
            ctx.log.debug("xp aggregated", { guildId: guild.id, ...summary });
          } catch (error) {
            // One guild's bad day must not cost every other guild its run —
            // the next pass re-derives this day from counters that are still
            // sitting in the database untouched.
            ctx.log.warn("xp aggregate failed", { guildId: guild.id, day, error: String(error) });
          }
        }
      }
      return written;
    }),
    lockKey: keys.lockJob("xp-aggregate"),
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
          await ctx.adapters.bridgeBus.publish({
            kind: "event-reminder",
            guildId: event.guildId,
            eventId: event.id,
            title: event.title,
            startsAt: event.startsAt,
            offsetMinutes,
            discordIds,
          });
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

  /**
   * The Discord roster mirror.
   *
   * The workers process holds no gateway connection either, so it dials the same
   * loopback API the panel's pickers use — with `all=1`, because a truncated
   * roster here would be recorded as a mass departure.
   */
  const discordMemberSync: JobDefinition<number> = {
    ...defineDiscordMemberSyncJob(async () => {
      const token = ctx.config.internalApi.token;
      if (token === undefined) {
        // Not a failure: a deployment without the internal API is a deployment
        // whose member page shows the in-game side only, which is the documented
        // degraded shape rather than something to retry against.
        ctx.log.debug("discord member sync skipped: no INTERNAL_API_TOKEN");
        return 0;
      }
      const base = ctx.config.internalApi.baseUrl.replace(/\/+$/, "");
      const guilds = await guildRepository.listActive();
      let seen = 0;
      for (const guild of guilds) {
        const result = await syncDiscordMembers(guild.id, {
          async fetchMembers(guildId) {
            try {
              const res = await fetch(
                `${base}/internal/g/${encodeURIComponent(guildId)}/members?all=1`,
                { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) },
              );
              if (!res.ok) {
                ctx.log.warn("discord member sync refused", {
                  guildId,
                  status: res.status,
                  hint:
                    res.status === 401
                      ? "INTERNAL_API_TOKEN differs between the workers and the bot"
                      : undefined,
                });
                return null;
              }
              const body = (await res.json()) as { members?: unknown };
              return Array.isArray(body.members) ? (body.members as readonly DiscordMemberRow[]) : null;
            } catch (error: unknown) {
              ctx.log.warn("discord member sync unreachable", {
                guildId,
                error: error instanceof Error ? error.message : "unknown",
              });
              return null;
            }
          },
          listActiveIds: (id) => discordSyncRepository.listActiveIds(id),
          upsertMembers: (id, rows) => discordSyncRepository.upsertMembers(id, rows),
          markLeft: (id, ids) => discordSyncRepository.markLeft(id, ids),
        });
        if (result.skipped) {
          ctx.log.warn("discord member sync incomplete", { guildId: guild.id, reason: result.skipped });
          continue;
        }
        ctx.log.info("discord roster synced", {
          guildId: guild.id,
          members: result.seen,
          joined: result.joined,
          left: result.left,
        });
        seen += result.seen;
      }
      return seen;
    }),
    lockKey: keys.lockJob("discord-member-sync"),
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
            if (remote.ok) return remote.value.data.members;
            // Named rather than collapsed to null: these three failures are
            // three different jobs — reissue the key, fix the configured guild
            // id, wait — and recording them all as "roster fetch failed" is why
            // a scan can fail every six hours without anyone learning anything.
            switch (remote.error.state) {
              case "API_DISABLED":
                return {
                  failed:
                    "Hypixel rejected the API key (403) — issue a new one at developer.hypixel.net and set HYPIXEL_API_KEY",
                };
              case "MISSING_PROFILE":
                return {
                  failed: `Hypixel has no guild with id "${hypixelGuildId}" — check the guild's hypixelGuildId`,
                };
              case "RATE_LIMITED":
                return { failed: "rate limited by Hypixel — the next scan will retry" };
              default:
                return { failed: `roster fetch failed (${remote.error.state})` };
            }
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
          ctx.log.warn("guild scan incomplete", {
            guildId: guild.id,
            skipped: result.skipped,
            reason: result.reason ?? null,
          });
          continue;
        }
        // Membership and rank are two of the auto-role triggers, and this scan
        // is the only thing that ever learns they changed. Marking is best
        // effort by design: the daily sweep is the floor under it.
        const touched = [...result.joined, ...result.left, ...result.rankChanged];
        if (touched.length > 0) {
          const discordIds = await roleSyncRepository.discordIdsForUuids(touched);
          await ctx.adapters.rolesDirty.mark(guild.id, discordIds);
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

  // `punishment-expiry` used to live here, clearing the `active` flag and
  // nothing else. It has moved to the admin bot, because lifting an expired ban
  // takes a Discord gateway this process does not have — and because a sweep
  // here would race the one there, clearing the flags that tell the admin bot
  // which bans are still owed a reversal. See `apps/admin-bot/punishment-sweep`.

  /**
   * Quiet tickets: warned once, then closed if nobody comes back.
   *
   * The decision and the doing both live in the bridge bot — it holds the
   * gateway to the community server, and carrying out either answer means
   * posting in a channel or deleting one. What this process contributes is the
   * schedule, the lock, and the memory of which tickets have already been
   * warned, which is a Redis key with a TTL rather than a database column
   * because it describes a notification and not a ticket.
   */
  const ticketSweep: JobDefinition<number> = {
    ...defineTicketSweepJob(async () => {
      const bridge = createWorkerTicketBridge({
        baseUrl: ctx.config.internalApi.bridgeBaseUrl,
        token: ctx.config.internalApi.token,
        logger: ctx.log,
      });
      const warnedKey = (ticketId: string) => keys.cacheGlobal(`ticket-warned:${ticketId}`);

      return sweepTickets({
        async listGuilds() {
          const guilds = await guildRepository.listActive();
          return guilds.map((g) => g.id);
        },
        listSweepable: (guildId) => ticketRepository.listSweepable(guildId),
        async wasWarned(ticketId) {
          return (await client.get(warnedKey(ticketId))) !== null;
        },
        async rememberWarned(ticketId) {
          await client.set(warnedKey(ticketId), "1", { EX: TICKET_WARNED_TTL_SECONDS });
        },
        async forgetWarned(ticketId) {
          await client.del(warnedKey(ticketId));
        },
        sweepOne: (ticket, staleWarned) => bridge.sweep(ticket, staleWarned),
        onError(scope, error) {
          ctx.log.warn("ticket sweep failed", { scope, error: String(error) });
        },
      });
    }),
    lockKey: keys.lockJob("ticket-sweep"),
  };

  /**
   * The tracker board. Same division of labour as the ticket sweep: this
   * process knows which boards are stale, and the one with a gateway to the
   * community server is the only one that can edit a message.
   */
  const eventBoard: JobDefinition<number> = {
    ...defineEventBoardJob(async () => {
      const bridge = createWorkerEventBoard({
        baseUrl: ctx.config.internalApi.bridgeBaseUrl,
        token: ctx.config.internalApi.token,
        logger: ctx.log,
      });
      return publishEventBoards({
        listDue: (staleBefore) => eventJobRepository.listBoardDue(staleBefore),
        publish: (event) => bridge.publish(event),
        onError(scope, error) {
          ctx.log.warn("event board failed", { scope, error: String(error) });
        },
      });
    }),
    lockKey: keys.lockJob("event-board"),
  };

  /**
   * The weekly standings digest. Same division of labour as the board: this
   * process knows which guilds exist, and the one with a gateway to the
   * community server is the only one that can post.
   *
   * Every active guild is offered one; the bridge refuses the ones with no
   * `leaderboard` channel bound. Filtering here instead would mean this process
   * held a second opinion about what "configured" means.
   */
  const leaderboardPost: JobDefinition<number> = {
    ...defineLeaderboardPostJob(async () => {
      const bridge = createWorkerLeaderboardDigest({
        baseUrl: ctx.config.internalApi.bridgeBaseUrl,
        token: ctx.config.internalApi.token,
        logger: ctx.log,
      });
      return postLeaderboardDigests({
        listGuilds: async () => (await guildRepository.listActive()).map((g) => ({ id: g.id })),
        publish: (guild) => bridge.publish(guild),
        onError(scope, error) {
          ctx.log.warn("leaderboard digest failed", { scope, error: String(error) });
        },
      });
    }),
    lockKey: keys.lockJob("leaderboard-post"),
  };

  /**
   * Auto-roles. The reconcile decides, the admin bot acts: this process has the
   * database and Redis, and the one holding a gateway to the member server is
   * the only one that can touch a role.
   *
   * The dirty set lives in Redis and is drained, not read — `sPop` takes the
   * ids out, so two workers racing cannot both act on the same member, and a
   * member whose pass fails is put back explicitly rather than left behind.
   */
  const roleSync: JobDefinition<number> = {
    ...defineRoleSyncJob(async () => {
      const effector = createWorkerRoleEffector({
        baseUrl: ctx.config.internalApi.baseUrl,
        token: ctx.config.internalApi.token,
        logger: ctx.log,
      });
      return syncRoles({
        async listGuilds() {
          const guilds = await guildRepository.listActive();
          return guilds.map((g) => g.id);
        },
        async loadPolicy(guildId) {
          return parseAutoRoles(await guildConfigRepository.getSetting(guildId, AUTO_ROLES_SETTING_KEY));
        },
        async claimFullSweep(guildId) {
          // NX makes the claim the same operation as the check, so two workers
          // arriving together produce one sweep rather than two.
          const claimed = await client.set(keys.rolesSweep(guildId), "1", {
            NX: true,
            EX: ROLE_SWEEP_TTL_SECONDS,
          });
          return claimed !== null;
        },
        listMemberIds: (guildId) => roleSyncRepository.listMemberIds(guildId),
        async markDirty(guildId, discordIds) {
          if (discordIds.length === 0) return;
          await client.sAdd(keys.rolesDirty(guildId), [...discordIds]);
        },
        async drainDirty(guildId, limit) {
          // `sPopCount`, not `sPop`: the uncounted form returns a single member,
          // which would reconcile one member per pass and look like a hang.
          return await client.sPopCount(keys.rolesDirty(guildId), limit);
        },
        loadSnapshots: (guildId, ids) => roleSyncRepository.loadSnapshots(guildId, ids),
        openGrants: (guildId, discordId) => roleGrantRepository.openGrants(guildId, discordId),
        apply: (guildId, discordId, add, remove) =>
          effector.apply(guildId, discordId, add, remove, "Automatic role rule"),
        recordGrants: (guildId, discordId, rows, reason) =>
          roleGrantRepository.recordGrants(guildId, discordId, rows, reason),
        closeGrants: (guildId, discordId, rows) => roleGrantRepository.closeGrants(guildId, discordId, rows),
        onRefusal(guildId, roleId, detail) {
          // Warn, not error: a refusal is a configuration problem the guild's
          // staff fix in the panel, and the Health card is where they see it.
          ctx.log.warn("auto-role refused", { guildId, roleId, detail });
          // Fire and forget into the diagnostic hash. Staff do not read the
          // worker's logs, and a refusal nobody with the power to fix it can
          // see is the same as no refusal at all.
          void ctx.adapters.roleRefusals.record(guildId, roleId, detail).catch(() => undefined);
        },
        onError(scope, error) {
          ctx.log.warn("role sync failed", { scope, error: String(error) });
        },
      });
    }),
    lockKey: keys.lockJob("role-sync"),
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
    milestoneBackfill,
    leaderboardPost,
    eventTransition,
    reminders,
    rosterSync,
    guildScan,
    discordMemberSync,
    inactivity,
    ticketSweep,
    eventTracking,
    eventBoard,
    roleSync,
    xpAggregate,
    analyticsIngest,
    analyticsRollup,
    configInvalidation,
  ];
  return new Map(definitions.map((d) => [d.name, d]));
}
