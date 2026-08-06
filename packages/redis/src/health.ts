import { getRedis } from "./client.js";

export interface RedisPingResult {
  readonly ok: boolean;
  readonly latencyMs: number | null;
  readonly detail?: string;
}

/** Liveness probe for the observability health registry. */
export async function pingRedis(): Promise<RedisPingResult> {
  const start = Date.now();
  try {
    const { client } = await getRedis();
    await client.ping();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (error) {
    return {
      ok: false,
      latencyMs: null,
      detail: error instanceof Error ? error.message : "unknown error",
    };
  }
}
