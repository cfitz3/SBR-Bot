/**
 * Concrete bridge-relay adapters (BridgeGuard / WordlistFilter / FloodControl)
 * over Redis + Prisma. `guildId` is the internal Guild.id.
 */
import type { BridgeGuard, FilterVerdict, FloodControl, WordlistFilter } from "@sbr/bridge";
import type { IdentityService, WordlistRuleDTO } from "@sbr/shared-types";
import { guildConfigRepository, wordlistRepository } from "@sbr/db";
import { evaluateText } from "@sbr/moderation";
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

  async canRelay(guildId: string, authorId: string): Promise<boolean> {
    // Open bridge by default; an explicit BYPASS/deny model tightens this later.
    // A granted RELAY_MESSAGE capability always permits.
    return (await this.identity.hasCapability(guildId, authorId, "RELAY_MESSAGE")) || true;
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
  constructor(private readonly ttlMs = 30_000) {}

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

    // Per-user rate.
    const rateKey = keys.floodUser(guildId, authorId);
    const count = await client.incr(rateKey);
    if (count === 1) await client.expire(rateKey, FLOOD_WINDOW_S);
    if (count > FLOOD_LIMIT) return { allowed: false, reason: "RATE" };

    return { allowed: true };
  }
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}
