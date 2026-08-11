/**
 * XpService — the one place that decides whether an action earns anything, and
 * the one place that rebuilds a standing from the ledger.
 *
 * The hot-path methods (`recordMessage`, `recordCommand`) never award XP and
 * never throw. They increment a counter behind a cooldown gate, absorbing their
 * own failures: a member's message is not allowed to fail because the XP
 * bookkeeping did, and a broken counter should cost XP, not conversation.
 */
import type { Logger } from "@sbr/observability";
import type { ActivitySink, BalanceRow, XpRepository } from "./ports.js";
import { toPolicyMap } from "./ports.js";
import { awardsFor, countsAsMessage, totalsBySource } from "./policy.js";
import { levelProgress } from "./levels.js";
import type { ActivityCounters, Standing, XpAward, XpPolicy, XpSource, XpSourcePolicy } from "./types.js";
import { NO_ACTIVITY, policyFor } from "./types.js";

/** Per-user, per-source spam gate. Wired to Redis; in-memory in tests. */
export interface XpCooldownGate {
  consume(key: string, ttlMs: number): Promise<{ allowed: boolean; retryAfterMs?: number }>;
}

export interface XpServiceDeps {
  readonly repo: XpRepository;
  readonly activity: ActivitySink;
  readonly cooldowns: XpCooldownGate;
  readonly logger: Logger;
  /** Injected for tests. Defaults to the wall clock. */
  readonly now?: () => Date;
}

/** What one aggregation run did, for the job log. */
export interface AggregateSummary {
  readonly day: string;
  readonly membersConsidered: number;
  readonly awardsWritten: number;
  readonly balancesRebuilt: number;
}

export class XpService {
  private readonly repo: XpRepository;
  private readonly activity: ActivitySink;
  private readonly cooldowns: XpCooldownGate;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(deps: XpServiceDeps) {
    this.repo = deps.repo;
    this.activity = deps.activity;
    this.cooldowns = deps.cooldowns;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => new Date());
  }

  // ─────────────────────────── hot path ───────────────────────────

  /**
   * Count a message, if it counts. Returns whether it did, which is only useful
   * for tests and diagnostics — no caller is expected to branch on it.
   */
  async recordMessage(
    guildId: string,
    discordId: string,
    source: Extract<XpSource, "DISCORD_MESSAGE" | "GUILD_CHAT_MESSAGE">,
    text: string,
  ): Promise<boolean> {
    try {
      const rule = policyFor(await this.policy(guildId), source);
      const { counts, cooldownSec } = countsAsMessage(text, rule);
      if (!counts) return false;
      if (!(await this.passesCooldown(guildId, discordId, source, cooldownSec))) return false;

      const field: keyof ActivityCounters = source === "DISCORD_MESSAGE" ? "discordMessages" : "guildChatMessages";
      await this.activity.bump(guildId, discordId, this.today(), field, 1);
      return true;
    } catch (error) {
      this.logger.warn("xp.recordMessage failed", { guildId, discordId, source, error: String(error) });
      return false;
    }
  }

  /** Count a command invocation. Same contract as `recordMessage`. */
  async recordCommand(guildId: string, discordId: string): Promise<boolean> {
    try {
      const rule = policyFor(await this.policy(guildId), "COMMAND_USAGE");
      if (!rule.enabled) return false;
      if (!(await this.passesCooldown(guildId, discordId, "COMMAND_USAGE", rule.cooldownSec))) return false;
      await this.activity.bump(guildId, discordId, this.today(), "commandsUsed", 1);
      return true;
    } catch (error) {
      this.logger.warn("xp.recordCommand failed", { guildId, discordId, error: String(error) });
      return false;
    }
  }

  /** Count a presence sample — the playtime proxy, from the guild scan. */
  async recordPresence(guildId: string, discordIds: readonly string[]): Promise<void> {
    const day = this.today();
    for (const discordId of discordIds) {
      try {
        await this.activity.bump(guildId, discordId, day, "presenceSamples", 1);
      } catch (error) {
        this.logger.warn("xp.recordPresence failed", { guildId, discordId, error: String(error) });
      }
    }
  }

  // ─────────────────────────── reads ───────────────────────────

  /** A member's standing, or null when they have never earned anything. */
  async standing(guildId: string, discordId: string): Promise<Standing | null> {
    const [balance, rank] = await Promise.all([
      this.repo.balance(guildId, discordId),
      this.repo.rank(guildId, discordId),
    ]);
    return balance === null ? null : toStanding(balance, rank);
  }

  /** The XP leaderboard. Ranks are 1-based and dense over the returned page. */
  async leaderboard(guildId: string, limit: number): Promise<readonly Standing[]> {
    const rows = await this.repo.top(guildId, Math.max(1, Math.min(100, limit)));
    return rows.map((row, i) => toStanding(row, i + 1));
  }

  async policy(guildId: string): Promise<XpPolicy> {
    return toPolicyMap(await this.repo.policy(guildId));
  }

  async setSourcePolicy(guildId: string, policy: XpSourcePolicy): Promise<XpSourcePolicy> {
    return this.repo.setSourcePolicy(guildId, policy);
  }

  // ─────────────────────────── writes ───────────────────────────

  /**
   * A staff adjustment. Signed, always reasoned, and never deduped — two
   * identical adjustments on the same day are two decisions, not a replay.
   *
   * The balance is rebuilt immediately rather than waiting for the nightly job,
   * because the staff member who just ran this will look at the result.
   */
  /**
   * Credit a milestone reward. Idempotent through the milestone id as dedupe
   * key: detection can be re-run and the day re-aggregated without paying
   * twice. A zero reward writes nothing — an empty ledger row would show up in
   * a standing breakdown as a source that gave nothing.
   */
  async awardMilestone(
    guildId: string,
    discordId: string,
    amount: number,
    milestoneId: string,
    label: string,
  ): Promise<boolean> {
    const value = Math.trunc(amount);
    if (value <= 0) return false;

    await this.repo.recordAwards(guildId, [
      {
        discordId,
        source: "MILESTONE",
        amount: value,
        rawValue: value,
        day: this.today(),
        dedupeKey: `milestone:${milestoneId}`,
        meta: { label },
      },
    ]);
    await this.rebuildBalances(guildId);
    return true;
  }

  async adjust(
    guildId: string,
    discordId: string,
    amount: number,
    reason: string,
    byDiscordId: string,
  ): Promise<Standing | null> {
    const award: XpAward = {
      discordId,
      source: "MANUAL",
      amount: Math.trunc(amount),
      rawValue: Math.abs(Math.trunc(amount)),
      day: this.today(),
      dedupeKey: null,
      meta: { reason, by: byDiscordId },
    };
    await this.repo.recordAwards(guildId, [award]);
    await this.rebuildBalances(guildId);
    return this.standing(guildId, discordId);
  }

  /**
   * Derive a day's XP from its counters and rebuild every balance.
   *
   * Safe to re-run: derived awards carry a dedupe key, so a second run over a
   * day still in progress overwrites this morning's partial figure rather than
   * adding to it. That is also why the balance rebuild reads the whole ledger
   * instead of applying a delta — the ledger is the truth, the balance is a
   * cache of it.
   */
  async aggregate(guildId: string, day: string): Promise<AggregateSummary> {
    const policy = await this.policy(guildId);
    const [activity, gexp, tenure, events] = await Promise.all([
      this.repo.activityForDay(guildId, day),
      this.repo.gexpForDay(guildId, day),
      this.repo.tenureForDay(guildId, day),
      this.repo.eventsForDay(guildId, day),
    ]);

    const gexpBy = new Map(gexp.map((g) => [g.discordId, g.gexp]));
    const tenureBy = new Map(tenure.map((t) => [t.discordId, t.days]));
    const eventsBy = new Map(events.map((e) => [e.discordId, e.count]));
    const counterBy = new Map(activity.map((a) => [a.discordId, a.counters]));

    // Everyone who did *anything* that day, from any source. A member with GEXP
    // but no messages still earns, and vice versa.
    const members = new Set<string>([...counterBy.keys(), ...gexpBy.keys(), ...tenureBy.keys(), ...eventsBy.keys()]);

    const awards: XpAward[] = [];
    for (const discordId of members) {
      awards.push(
        ...awardsFor(
          {
            discordId,
            day,
            counters: counterBy.get(discordId) ?? NO_ACTIVITY,
            gexp: gexpBy.get(discordId) ?? 0,
            tenureDays: tenureBy.get(discordId) ?? 0,
            events: eventsBy.get(discordId) ?? 0,
          },
          policy,
        ),
      );
    }

    if (awards.length > 0) await this.repo.recordAwards(guildId, awards);
    const balancesRebuilt = await this.rebuildBalances(guildId, tenureBy);

    return { day, membersConsidered: members.size, awardsWritten: awards.length, balancesRebuilt };
  }

  /** Recompute every balance from the ledger. Returns how many were written. */
  async rebuildBalances(guildId: string, tenure?: ReadonlyMap<string, number>): Promise<number> {
    const ledger = await this.repo.ledger(guildId);
    const byMember = new Map<string, { rows: typeof ledger; last: Date }>();

    for (const row of ledger) {
      const bucket = byMember.get(row.discordId);
      if (bucket === undefined) {
        byMember.set(row.discordId, { rows: [row], last: row.createdAt });
      } else {
        byMember.set(row.discordId, {
          rows: [...bucket.rows, row],
          last: row.createdAt > bucket.last ? row.createdAt : bucket.last,
        });
      }
    }

    const balances: BalanceRow[] = [];
    for (const [discordId, bucket] of byMember) {
      const bySource = totalsBySource(bucket.rows);
      // Clamped at zero: a deduction can wipe a balance but not invert it, and a
      // negative total would give the level curve an imaginary root.
      const totalXp = Math.max(0, Object.values(bySource).reduce((sum, n) => sum + n, 0));
      balances.push({
        discordId,
        totalXp,
        level: levelProgress(totalXp).level,
        bySource,
        tenureDays: tenure?.get(discordId) ?? 0,
        lastAwardAt: bucket.last,
      });
    }

    await this.repo.saveBalances(guildId, balances);
    return balances.length;
  }

  // ─────────────────────────── internals ───────────────────────────

  private async passesCooldown(
    guildId: string,
    discordId: string,
    source: XpSource,
    cooldownSec: number,
  ): Promise<boolean> {
    if (cooldownSec <= 0) return true;
    // `cd:` because the gate adapter takes a whole key and writes it verbatim —
    // the namespace is the caller's job, and an unprefixed `xp:*` would be the
    // one cooldown key in the keyspace nobody could find by prefix.
    const gate = await this.cooldowns.consume(`cd:xp:${guildId}:${source}:${discordId}`, cooldownSec * 1000);
    return gate.allowed;
  }

  /** `YYYY-MM-DD` in UTC — the grain every counter and award shares. */
  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }
}

function toStanding(row: BalanceRow, rank: number | null): Standing {
  const progress = levelProgress(row.totalXp);
  return {
    discordId: row.discordId,
    totalXp: row.totalXp,
    level: progress.level,
    intoLevel: progress.intoLevel,
    levelSpan: progress.levelSpan,
    bySource: row.bySource,
    tenureDays: row.tenureDays,
    lastAwardAt: row.lastAwardAt,
    rank,
  };
}
