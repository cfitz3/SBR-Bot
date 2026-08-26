/**
 * The queue in front of the immediate role path.
 *
 * `syncOneMember` is safe to call whenever; calling it *as often as things
 * happen* is not. Discord's global ceiling is generous, but role writes sit in a
 * per-guild bucket that is empirically about ten modifications per ten seconds,
 * and one member's reconcile can cost two of them — one PATCH to add, one to
 * remove. Twenty people linking during a recruitment push would sail through
 * that in a second and earn the whole guild a 429 on a surface (moderation,
 * greetings) that shares it.
 *
 * So the immediate path is paced rather than parallel: one member at a time,
 * per guild, drawing from a small token bucket. A single person linking spends a
 * token that is always there and is reconciled at once, which is the case this
 * whole mechanism exists for. A crowd is spread out over the following minute.
 *
 * Nothing here is a retry mechanism, and nothing here is durable. A member the
 * queue drops — because the backlog is full, or because the process is stopping
 * — is still sitting in `roles:dirty:<guildId>`, and the fifteen-minute sweep is
 * still the thing that guarantees they are reconciled at all. This only decides
 * how many of them get there sooner.
 */

/**
 * How many immediate reconciles may happen back-to-back before pacing starts.
 *
 * One, which is not a burst so much as the absence of a queue: an idle lane
 * always has this token, so the ordinary case — somebody links, nobody else is
 * waiting — is reconciled on the spot. Allowing two or three would let the very
 * first ten-second window carry the burst *and* a full window of refills, which
 * is how a token bucket quietly exceeds the limit it was added to respect.
 */
export const NUDGE_BURST = 1;

/**
 * How often a spent token comes back.
 *
 * One member every two and a half seconds is at most four in any ten-second
 * window, and at most two role calls each: eight against a bucket of about ten.
 * The margin is deliberate, because the sweep, the moderation effector and role
 * menus all draw on the same per-guild bucket and none of them asks this queue
 * first.
 */
export const NUDGE_REFILL_MS = 2_500;

/**
 * How many members may be waiting per guild before nudges are refused.
 *
 * A ceiling, not a target. Past this the honest answer is that the immediate
 * path has nothing to offer over the sweep — it would deliver the two-hundredth
 * member six minutes late either way — so it declines instead of growing a
 * queue nobody is watching.
 */
export const NUDGE_MAX_PENDING = 50;

export interface RoleNudgeQueueDeps {
  /** Reconcile one member. Expected never to throw; `syncOneMember` does not. */
  sync(guildId: string, discordId: string): Promise<boolean>;
  /** Injected so tests do not spend real seconds proving the pacing works. */
  sleep?(ms: number): Promise<void>;
  now?(): number;
  /** A nudge that was not taken. The member stays dirty; this is for the log. */
  onDropped?(guildId: string, discordId: string, why: "backlog" | "stopped"): void;
}

export interface RoleNudgeQueue {
  /**
   * Ask for one member to be reconciled soon. Returns whether the nudge was
   * accepted, and resolves immediately — the caller is on somebody's request
   * path and does not wait for Discord.
   */
  nudge(guildId: string, discordId: string): boolean;
  /** How many members are waiting, across every guild. For the health card. */
  pending(): number;
  /** Stop draining and forget the backlog. The sweep still owns those members. */
  stop(): void;
}

interface GuildLane {
  /**
   * A set, not an array: two events about the same member within the same
   * second — a link that both fills in an IGN and completes a milestone — want
   * one reconcile, not two identical ones.
   */
  readonly waiting: Set<string>;
  /**
   * The member being reconciled right now, if any.
   *
   * Held separately from `waiting` so dedupe covers them too. A reconcile takes
   * a round trip to Discord, and several facts about one person routinely land
   * inside it — a link fills in an IGN, which completes a milestone, which
   * qualifies them for a second rule. Queueing them again would spend a second
   * role call to ask a question the in-flight pass is already answering with
   * fresher facts. If something genuinely did change in that window, the mark
   * that came with the nudge is still in the dirty set for the sweep.
   */
  inFlight: string | null;
  tokens: number;
  lastRefill: number;
  draining: boolean;
}

export function createRoleNudgeQueue(deps: RoleNudgeQueueDeps): RoleNudgeQueue {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const lanes = new Map<string, GuildLane>();
  let stopped = false;

  const laneFor = (guildId: string): GuildLane => {
    const existing = lanes.get(guildId);
    if (existing !== undefined) return existing;
    const lane: GuildLane = {
      waiting: new Set(),
      inFlight: null,
      tokens: NUDGE_BURST,
      lastRefill: now(),
      draining: false,
    };
    lanes.set(guildId, lane);
    return lane;
  };

  /** Hands back whatever time has earned since the last look. */
  const refill = (lane: GuildLane): void => {
    const at = now();
    const earned = Math.floor((at - lane.lastRefill) / NUDGE_REFILL_MS);
    if (earned <= 0) return;
    lane.tokens = Math.min(NUDGE_BURST, lane.tokens + earned);
    lane.lastRefill = at;
  };

  const drain = async (guildId: string, lane: GuildLane): Promise<void> => {
    lane.draining = true;
    try {
      while (!stopped && lane.waiting.size > 0) {
        refill(lane);
        if (lane.tokens <= 0) {
          await sleep(NUDGE_REFILL_MS);
          continue;
        }

        const next = lane.waiting.values().next();
        if (next.done === true) break;
        lane.waiting.delete(next.value);
        lane.tokens -= 1;
        // A lane that has just spent its last token starts earning again from
        // now, not from whenever it was last idle — otherwise a queue that sat
        // quiet for a minute would bank sixty tokens and spend them at once.
        if (lane.tokens === 0) lane.lastRefill = now();

        // Guarded even though `syncOneMember` is documented not to throw. A
        // lane that died on one member would hand everybody queued behind them
        // back to the sweep, which is a fifteen-minute penalty for being
        // unlucky about queue position.
        lane.inFlight = next.value;
        try {
          await deps.sync(guildId, next.value).catch(() => undefined);
        } finally {
          lane.inFlight = null;
        }
      }
      if (stopped) {
        for (const discordId of lane.waiting) deps.onDropped?.(guildId, discordId, "stopped");
        lane.waiting.clear();
      }
    } finally {
      lane.draining = false;
      if (lane.waiting.size === 0 && lane.tokens >= NUDGE_BURST) lanes.delete(guildId);
    }
  };

  return {
    nudge(guildId, discordId) {
      if (stopped) return false;
      const lane = laneFor(guildId);
      if (lane.waiting.has(discordId) || lane.inFlight === discordId) return true;
      if (lane.waiting.size >= NUDGE_MAX_PENDING) {
        deps.onDropped?.(guildId, discordId, "backlog");
        return false;
      }
      lane.waiting.add(discordId);
      // Fire and forget on purpose. `drain` awaits Discord; the caller is
      // finishing somebody's link and must not.
      if (!lane.draining) void drain(guildId, lane);
      return true;
    },
    pending() {
      let total = 0;
      for (const lane of lanes.values()) total += lane.waiting.size;
      return total;
    },
    stop() {
      stopped = true;
    },
  };
}
