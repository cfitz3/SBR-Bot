/**
 * The workers' client for the bridge bot's weekly-digest API.
 *
 * Fifth client for that little API and, like the event board's, the quiet one:
 * nobody is waiting on a digest, so a failure is a log line and a false, and
 * the next pass tries again next week. See `apps/workers/src/ticket-bridge.ts`
 * — the shape is deliberately the same.
 */
import type { Logger } from "@sbr/observability";
import type { DigestGuild } from "@sbr/jobs";

/** Four boards, four reads and four posts. Slower than a single edit. */
const TIMEOUT_MS = 30_000;

export interface WorkerLeaderboardDigestDeps {
  readonly baseUrl: string;
  /** Absent means the bridge isn't serving; every call reports as unposted. */
  readonly token: string | undefined;
  readonly logger: Logger;
}

export interface WorkerLeaderboardDigest {
  publish(guild: DigestGuild): Promise<boolean>;
}

export function createWorkerLeaderboardDigest(deps: WorkerLeaderboardDigestDeps): WorkerLeaderboardDigest {
  const base = deps.baseUrl.replace(/\/+$/, "");
  return {
    async publish(guild) {
      if (deps.token === undefined) return false;
      try {
        const res = await fetch(`${base}/internal/g/${encodeURIComponent(guild.id)}/leaderboard-post`, {
          method: "POST",
          headers: { authorization: `Bearer ${deps.token}`, "content-type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
          // 422 is the ordinary case, not a fault: most guilds never bind the
          // `leaderboard` slot, and binding it is how a guild opts in. 503 is
          // the bridge still connecting. Neither is news.
          const level = res.status === 422 || res.status === 503 ? "debug" : "warn";
          deps.logger[level]("leaderboard digest refused", { guildId: guild.id, status: res.status });
          return false;
        }
        return true;
      } catch (error) {
        deps.logger.warn("bridge digest api unreachable", { guildId: guild.id, error: String(error) });
        return false;
      }
    },
  };
}
