/**
 * Concrete bridge-relay adapters (BridgeGuard / WordlistFilter / FloodControl)
 * over Redis + Prisma. `guildId` is the internal Guild.id.
 */
import type { BridgeGuard, FilterVerdict, FloodControl, WordlistFilter } from "@sbr/bridge";
import type { IdentityService, WordlistRuleDTO } from "@sbr/shared-types";
import { guildConfigRepository, wordlistRepository } from "@sbr/db";
import { evaluateText } from "@sbr/moderation";
import { COOLDOWN_SETTING_KEY, parseCooldowns } from "@sbr/guild-config";
import type { RedisContext } from "@sbr/redis";

const FLOOD_LIMIT = 6;
const FLOOD_WINDOW_S = 10;
const DEDUP_WINDOW_S = 8;

export class BridgeGuardImpl implements BridgeGuard {
  constructor(private readonly ctx: RedisContext, private readonly identity: IdentityService) {}

  async isSuspended(guildId: string): Promise<boolean> {
    // Fast path: Redis suspension flag; fall back to the persisted config.
    const flag = await this.ctx.client.exists(this.ctx.keys.suspendBridge(guildId));
    if (flag) return true;
    const cfg = await guildConfigRepository.get(guildId);
    return cfg?.bridgeSuspended ?? false;
  }

  async isMuted(guildId: string, authorId: string): Promise<boolean> {
    return (await this.ctx.client.exists(this.ctx.keys.mute(guildId, authorId))) === 1;
  }

  /**
   * Whether this author's message may cross into guild chat.
   *
   * This used to end `|| true`, which made the whole check decorative: the
   * capability was resolved and then discarded, so a deny row, a demotion and a
   * stranger all relayed anyway. It is a real gate now.
   *
   * It is still an *open* gate by default, which is the intended posture — the
   * `RELAY_MESSAGE` floor is MEMBER, so anyone recorded as a member of the guild
   * may speak (BRIDGE_BOT.md §3.3). What changed is that the three cases which
   * were always supposed to fail now do: an explicit deny row, a member the
   * guild has demoted below its configured floor, and somebody with no
   * membership at all.
   */
  async canRelay(guildId: string, authorId: string): Promise<boolean> {
    return this.identity.hasCapability(guildId, authorId, "RELAY_MESSAGE");
  }
}

/**
 * The relay's chat filter. Evaluation is delegated to `evaluateText` from
 * @sbr/moderation — the same function behind `/filter-test` — so a rule a
 * staffer verifies in Discord behaves identically on the next relayed message.
 * A filter that disagrees with its own test harness is worse than no test.
 *
 * Rules are cached briefly because the relay evaluates every message; a
 * `/wordlist-add` therefore takes effect within one TTL rather than instantly,
 * which is the trade the relay's message volume demands.
 */
export class WordlistFilterImpl implements WordlistFilter {
  private cache = new Map<string, { rules: readonly WordlistRuleDTO[]; expiry: number }>();
  /**
   * `metrics` is the Analytics page's `filter.hit` series for the relay. The
   * automod runner records its own hits; this covers the plain wordlist, which
   * runs on every relayed line and is the one most guilds actually configure.
   */
  constructor(
    private readonly ttlMs = 30_000,
    private readonly metrics?: { filterHit(guildId: string, ruleId: string, action: string): void },
  ) {}

  private async load(guildId: string): Promise<readonly WordlistRuleDTO[]> {
    const cached = this.cache.get(guildId);
    if (cached && cached.expiry > Date.now()) return cached.rules;
    // `list` rather than `listEnabled`: evaluateText skips disabled rules
    // itself, and this keeps the relay's input identical to `/filter-test`'s.
    const rules = await wordlistRepository.list(guildId);
    this.cache.set(guildId, { rules, expiry: Date.now() + this.ttlMs });
    return rules;
  }

  async check(guildId: string, content: string): Promise<FilterVerdict> {
    const result = evaluateText(await this.load(guildId), content);
    // One per matched rule, not one per message: "which rule is doing the work"
    // is the question the chart answers, and a message caught by three rules is
    // three answers to it.
    for (const rule of result.matched) {
      this.metrics?.filterHit(guildId, rule.id, result.action);
    }
    if (result.action === "REPLACE") {
      return { action: "REPLACE", replacement: result.replacement ?? content };
    }
    return { action: result.action };
  }
}

export class FloodControlImpl implements FloodControl {
  constructor(private readonly ctx: RedisContext) {}

  async allow(
    guildId: string,
    authorId: string,
    content: string,
  ): Promise<{ allowed: boolean; reason?: "RATE" | "DUPLICATE" }> {
    const { client, keys } = this.ctx;

    // Duplicate suppression.
    const hash = simpleHash(`${authorId}:${content}`);
    const dup = await client.set(keys.dedupRelay(guildId, hash), "1", { NX: true, EX: DEDUP_WINDOW_S });
    if (!dup) return { allowed: false, reason: "DUPLICATE" };

    // Per-user rate. Two limits sit here, and they are not the same thing:
    // the hard flood window below protects the bridge account from Hypixel's
    // own limit and is not configurable, while the guild's own relay cooldown
    // is a comfort setting layered on top of it.
    const rateKey = keys.floodUser(guildId, authorId);
    const count = await client.incr(rateKey);
    if (count === 1) await client.expire(rateKey, FLOOD_WINDOW_S);
    if (count > FLOOD_LIMIT) return { allowed: false, reason: "RATE" };

    const relaySeconds = await this.relayCooldownSeconds(guildId);
    if (relaySeconds > 0) {
      const cdKey = keys.relayCooldown(guildId, authorId);
      const fresh = await client.set(cdKey, "1", { NX: true, EX: relaySeconds });
      if (!fresh) return { allowed: false, reason: "RATE" };
    }

    return { allowed: true };
  }

  /**
   * Read on the hot path rather than cached, because the setting is a single
   * indexed lookup Redis already fronts, and a stale cooldown is the kind of
   * "I changed it and nothing happened" that makes operators stop trusting a
   * panel. An unreadable policy means no extra cooldown, never a blocked relay.
   */
  private async relayCooldownSeconds(guildId: string): Promise<number> {
    try {
      return parseCooldowns(await guildConfigRepository.getSetting(guildId, COOLDOWN_SETTING_KEY)).relaySeconds;
    } catch {
      return 0;
    }
  }
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}
