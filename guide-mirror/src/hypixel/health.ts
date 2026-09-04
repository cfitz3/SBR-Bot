/**
 * A Hypixel health probe that costs no requests.
 *
 * Every other check in the registry pings the thing it names. This one cannot:
 * Hypixel's budget is shared by the whole guild and metered per key, so a probe
 * on every health read would spend real capacity to answer a question, and it
 * would spend the most of it exactly when members are running `/health` because
 * something is already wrong. So the client records what its last real call did
 * and this reads that.
 *
 * The cost of that trade is honest and worth naming: the answer is as old as
 * the last command anybody ran.
 */
import type { HealthCheck } from "../types/index.js";
import type { HypixelObservation } from "./client.js";

/**
 * How long an observation stays current.
 *
 * Past this, a failure is no longer news — the outage it recorded may have
 * ended twenty minutes ago and nothing has asked since. Reverting to `ok`
 * rather than to a third "unknown" state is deliberate: the card answers "is
 * anything known to be wrong", and nothing is.
 */
export const OBSERVATION_TTL_MS = 5 * 60_000;

/** A rate-limited key is throttled, not broken; the rest are outages. */
const STATUS = {
  RATE_LIMITED: "degraded",
  API_DISABLED: "down",
  UNREACHABLE: "down",
} as const;

export function hypixelCheck(
  source: { lastUpstream(): HypixelObservation | null },
  now: () => number = Date.now,
): HealthCheck {
  return {
    name: "hypixel",
    async check() {
      const last = source.lastUpstream();
      if (last === null) return { status: "ok", latencyMs: null };
      if (last.ok) return { status: "ok", latencyMs: null };
      if (now() - Date.parse(last.at) > OBSERVATION_TTL_MS) return { status: "ok", latencyMs: null };
      return { status: STATUS[last.reason ?? "UNREACHABLE"], latencyMs: null };
    },
  };
}
