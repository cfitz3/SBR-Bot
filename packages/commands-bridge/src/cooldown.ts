import type { CooldownGate } from "./types.js";

/** In-memory cooldown gate (single-instance / tests). Redis-backed at wiring time. */
export class InMemoryCooldownGate implements CooldownGate {
  private readonly until = new Map<string, number>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  async consume(key: string, ttlMs: number): Promise<{ allowed: boolean; retryAfterMs?: number }> {
    const now = this.now();
    const expiry = this.until.get(key);
    if (expiry !== undefined && expiry > now) {
      return { allowed: false, retryAfterMs: expiry - now };
    }
    this.until.set(key, now + ttlMs);
    return { allowed: true };
  }
}
