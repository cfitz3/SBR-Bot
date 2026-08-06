/**
 * Concrete bridge-relay adapters (BridgeGuard / WordlistFilter / FloodControl)
 * over Redis + Prisma. `guildId` is the internal Guild.id.
 */
import type { BridgeGuard, FilterVerdict, FloodControl, WordlistFilter } from "@sbr/bridge";
import type { IdentityService } from "@sbr/shared-types";
import { guildConfigRepository, wordlistRepository, type WordlistEntryRow } from "@sbr/db";
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

type Matcher = (content: string) => boolean;

function compile(entry: WordlistEntryRow): Matcher {
  const p = entry.pattern;
  switch (entry.matchType) {
    case "EXACT":
      return (c) => c.toLowerCase() === p.toLowerCase();
    case "SUBSTRING":
      return (c) => c.toLowerCase().includes(p.toLowerCase());
    case "REGEX":
      try {
        const re = new RegExp(p, "i");
        return (c) => re.test(c);
      } catch {
        return () => false;
      }
    case "WILDCARD": {
      const re = new RegExp("^" + p.split("*").map(escapeRegex).join(".*") + "$", "i");
      return (c) => re.test(c);
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class WordlistFilterImpl implements WordlistFilter {
  private cache = new Map<string, { matchers: Array<{ m: Matcher; action: WordlistEntryRow["action"] }>; expiry: number }>();
  constructor(private readonly ttlMs = 30_000) {}

  private async load(guildId: string) {
    const cached = this.cache.get(guildId);
    if (cached && cached.expiry > Date.now()) return cached.matchers;
    const rows = await wordlistRepository.listEnabled(guildId);
    const matchers = rows.map((r) => ({ m: compile(r), action: r.action }));
    this.cache.set(guildId, { matchers, expiry: Date.now() + this.ttlMs });
    return matchers;
  }

  async check(guildId: string, content: string): Promise<FilterVerdict> {
    const matchers = await this.load(guildId);
    let flagged = false;
    let replaced: string | null = null;
    for (const { m, action } of matchers) {
      if (!m(content)) continue;
      if (action === "BLOCK" || action === "SHADOW_MUTE") return { action };
      if (action === "REPLACE") replaced = (replaced ?? content).replace(/\S/g, "*");
      if (action === "FLAG") flagged = true;
    }
    if (replaced !== null) return { action: "REPLACE", replacement: replaced };
    if (flagged) return { action: "FLAG" };
    return { action: "ALLOW" };
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
