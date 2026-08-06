import { prisma } from "./client.js";

export interface DbPingResult {
  readonly ok: boolean;
  readonly latencyMs: number | null;
  readonly detail?: string;
}

/** Lightweight liveness probe used by the observability health registry. */
export async function pingDb(): Promise<DbPingResult> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - start };
  } catch (error) {
    return {
      ok: false,
      latencyMs: null,
      detail: error instanceof Error ? error.message : "unknown error",
    };
  }
}
