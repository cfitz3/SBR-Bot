/**
 * Screening adapters: the ports `@sbr/screening` declares, implemented over the
 * clients this process already has.
 *
 * The stat reader is the interesting one. It gathers from two independent
 * sources and is explicit about which answered:
 *
 * - **Hypixel** is authoritative and current, but goes dark whenever the
 *   applicant turns their API settings off — which, for someone being screened,
 *   is a meaningful signal in itself rather than an error.
 * - **SkyKings' tracker** holds figures for players it has seen before. Older,
 *   and only useful for the subset it knows, but it answers for exactly the
 *   accounts Hypixel will not.
 *
 * So Hypixel is asked first, SkyKings fills the gaps, and every field that came
 * from the fallback is marked in `extra` — a screening that says "weight 9200"
 * should be answerable as "from where, and how old".
 */
import type { HypixelClient } from "@sbr/hypixel";
import type { ProgressionService } from "@sbr/shared-types";
import type { SkykingsClient } from "@sbr/skykings";
import type { ApplicantStatsSource, ScammerFinding, ScammerLookup } from "@sbr/screening";
import { UNREADABLE_STATS, type ApplicantStats } from "@sbr/screening";
import type { Logger } from "@sbr/observability";

/**
 * The scammer list, checked by uuid and — when we know one — by Discord id.
 *
 * Both are checked because they answer different questions. The uuid asks "is
 * this account listed"; the Discord id asks "is the person behind it listed",
 * which still matches after they buy a fresh account. A hit on either is a hit.
 *
 * A single UNKNOWN does not spoil a definite answer: if the uuid check comes
 * back FLAGGED, that stands regardless of what the Discord check managed. But
 * two CLEARs are required for a CLEAR, because a check that failed is not a
 * check that passed.
 */
export function skykingsScammerLookup(client: SkykingsClient): ScammerLookup {
  return {
    async check(uuid, discordId) {
      const [byUuid, byDiscord] = await Promise.all([
        client.checkUuid(uuid),
        discordId ? client.checkDiscordId(discordId) : Promise.resolve(null),
      ]);

      if (byUuid.status === "FLAGGED") {
        return { status: "FLAGGED", reason: byUuid.reason, source: "UUID" };
      }
      if (byDiscord?.status === "FLAGGED") {
        return { status: "FLAGGED", reason: byDiscord.reason, source: "DISCORD" };
      }
      if (byUuid.status === "UNKNOWN") {
        return { status: "UNKNOWN", detail: byUuid.detail ?? byUuid.cause };
      }
      if (byDiscord?.status === "UNKNOWN") {
        return { status: "UNKNOWN", detail: byDiscord.detail ?? byDiscord.cause };
      }
      return { status: "CLEAR" };
    },
  };
}

export interface StatsSourceDeps {
  readonly hypixel: HypixelClient;
  readonly progression: ProgressionService;
  readonly logger: Logger;
  /** Optional: without it, an unreadable account simply stays unreadable. */
  readonly skykings?: SkykingsClient;
}

export function applicantStatsSource(deps: StatsSourceDeps): ApplicantStatsSource {
  const log = deps.logger.child({ component: "screening-stats" });

  return {
    async read(uuid: string): Promise<ApplicantStats> {
      // Four calls, not five: SkyBlock Level used to cost a dedicated
      // `getSkyblockProfiles` fetch here purely to reach `leveling.experience`.
      // It is on the summary now, parsed from the blob that call already had.
      const [player, summary, networth, tracked] = await Promise.all([
        deps.hypixel.getPlayer(uuid),
        deps.progression.getProfileSummary(uuid),
        deps.progression.getNetworth(uuid),
        deps.skykings ? deps.skykings.getPlayer(uuid) : Promise.resolve(null),
      ]);

      const extra: Record<string, unknown> = {};

      // Hypixel first.
      const profile = summary.ok ? summary.value.data : null;

      let skillAverage = profile?.skillAverage ?? null;
      let catacombsLevel = profile?.catacombsLevel ?? null;
      let senitherWeight = profile?.senitherWeight ?? null;
      let coins = networth.ok && networth.value.data.total !== null ? BigInt(Math.round(networth.value.data.total)) : null;
      const level = profile?.skyblockLevel ?? null;

      // A section Hypixel refused is recorded as such: it is the difference
      // between "they have no dungeon progress" and "we cannot see it".
      const apiDisabled =
        (!summary.ok && summary.error.state === "API_DISABLED") ||
        (!networth.ok && networth.error.state === "API_DISABLED") ||
        (profile !== null && (profile.skillAverage === null || profile.catacombsLevel === null));

      if (!summary.ok) extra["summaryError"] = summary.error.state;
      if (!networth.ok) extra["networthError"] = networth.error.state;

      // Then the tracker, for whatever Hypixel would not say.
      if (tracked?.status === "OK" && tracked.data) {
        const t = tracked.data;
        extra["skykingsLastChecked"] = t.lastChecked;
        extra["skykingsGuild"] = t.guild;
        const filled: string[] = [];
        if (senitherWeight === null && t.senitherWeight !== null) {
          senitherWeight = t.senitherWeight;
          filled.push("senitherWeight");
        }
        if (coins === null && t.networth !== null) {
          coins = BigInt(Math.round(t.networth));
          filled.push("networth");
        }
        if (t.lilyWeight !== null) extra["lilyWeight"] = t.lilyWeight;
        if (filled.length > 0) extra["filledFromSkykings"] = filled;
      } else if (tracked?.status === "UNKNOWN") {
        extra["skykingsError"] = tracked.cause;
      }

      const nothing =
        skillAverage === null && catacombsLevel === null && senitherWeight === null && coins === null && level === null;

      if (nothing) {
        log.debug("applicant stats unreadable", { uuid });
        return { ...UNREADABLE_STATS, extra, currentGuild: currentGuild(extra) };
      }

      return {
        profileName: profile?.cuteName ?? null,
        skyblockLevel: level,
        skillAverage,
        catacombsLevel,
        senitherWeight,
        networth: coins,
        firstLoginAt: player.ok && player.value.data.firstLoginMs !== null ? new Date(player.value.data.firstLoginMs) : null,
        lastLoginAt: player.ok && player.value.data.lastLoginMs !== null ? new Date(player.value.data.lastLoginMs) : null,
        currentGuild: currentGuild(extra),
        apiDisabled,
        unreadable: false,
        extra,
      };
    },
  };
}

function currentGuild(extra: Record<string, unknown>): string | null {
  const g = extra["skykingsGuild"];
  return typeof g === "string" && g.length > 0 ? g : null;
}
