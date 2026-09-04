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
 * So the immediate path is paced rather than parallel: by default one member at
 * a time, per guild, drawing from a small token bucket. A single person linking
 * spends a token that is always there and is reconciled at once, which is the
 * case this whole mechanism exists for. A crowd is spread out over the
 * following minutes rather than turned away.
 *
 * Every number below is a default rather than a constant, because every one of
 * them is a guess about a ceiling Discord does not publish. `ROLE_NUDGE_BURST`,
 * `ROLE_NUDGE_REFILL_MS`, `ROLE_NUDGE_MAX_PENDING` and `ROLE_NUDGE_CONCURRENCY`
 * move them without a deploy, in either direction — which is what makes it
 * reasonable to ship the conservative reading as the default.
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
 * A ceiling, not a target, and its only cost is a string per waiting member —
 * the pacing above is what protects Discord, so a longer queue does not send
 * anything faster, it only stops the queue from throwing people out.
 *
 * Five hundred rather than fifty because fifty was a number chosen against the
 * ordinary day. A recruitment push, a server merge, or a "link your account to
 * enter" event puts a few hundred people through `/link` inside an hour, and
 * the old ceiling handed everybody past the fiftieth to the fifteen-minute
 * sweep — the exact crowd the immediate path exists for. Past five hundred the
 * original argument does hold: the queue is over twenty minutes deep, the sweep
 * would reach them sooner, and declining is the honest answer.
 */
export const NUDGE_MAX_PENDING = 500;

/**
 * How many members one guild may be reconciling at the same time.
 *
 * One by default, which is the pacing above doing its job — the token bucket is
 * what the per-guild role budget is spent against, and running two at once
 * against a bucket that refills once every two and a half seconds only changes
 * where the waiting happens. It is a knob because the budget is not a published
 * number: an operator who has watched `rateLimited` sit at zero through a
 * recruitment push can raise it and watch that number instead of guessing.
 */
export const NUDGE_CONCURRENCY = 1;

/**
 * The four numbers above, as one thing that can be handed in.
 *
 * Overridable because every one of them is a guess about somebody else's
 * ceiling. The defaults are the conservative reading; `ROLE_NUDGE_*` in the
 * environment is how a guild that has measured its own headroom uses it, and
 * how a guild that gets rate-limited anyway backs off without a deploy.
 */
export interface RoleNudgeTuning {
  readonly burst: number;
  readonly refillMs: number;
  readonly maxPending: number;
  readonly concurrency: number;
}

export const NUDGE_DEFAULTS: RoleNudgeTuning = Object.freeze({
  burst: NUDGE_BURST,
  refillMs: NUDGE_REFILL_MS,
  maxPending: NUDGE_MAX_PENDING,
  concurrency: NUDGE_CONCURRENCY,
});

/**
 * Read the tuning out of the environment, falling back a value at a time.
 *
 * Every field is clamped rather than validated: a typo in `ROLE_NUDGE_REFILL_MS`
 * should slow the immediate path down or leave it alone, never stop a process
 * from starting. The sweep is behind all of this regardless.
 */
export function resolveNudgeTuning(env: Readonly<Record<string, string | undefined>>): RoleNudgeTuning {
  const read = (name: string, fallback: number, min: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.max(min, Math.floor(value)) : fallback;
  };
  return {
    burst: read("ROLE_NUDGE_BURST", NUDGE_BURST, 1),
    refillMs: read("ROLE_NUDGE_REFILL_MS", NUDGE_REFILL_MS, 0),
    maxPending: read("ROLE_NUDGE_MAX_PENDING", NUDGE_MAX_PENDING, 1),
    concurrency: read("ROLE_NUDGE_CONCURRENCY", NUDGE_CONCURRENCY, 1),
  };
}

export interface RoleNudgeQueueDeps {
  /** Reconcile one member. Expected never to throw; `syncOneMember` does not. */
  sync(guildId: string, discordId: string): Promise<boolean>;
  /** Per-field override of `NUDGE_DEFAULTS`. Absent fields keep their default. */
  tuning?: Partial<RoleNudgeTuning>;
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
  /** The numbers actually in force, after environment and clamping. */
  tuning(): RoleNudgeTuning;
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
   * The members being reconciled right now.
   *
   * Held separately from `waiting` so dedupe covers them too. A reconcile takes
   * a round trip to Discord, and several facts about one person routinely land
   * inside it — a link fills in an IGN, which completes a milestone, which
   * qualifies them for a second rule. Queueing them again would spend a second
   * role call to ask a question the in-flight pass is already answering with
   * fresher facts. If something genuinely did change in that window, the mark
   * that came with the nudge is still in the dirty set for the sweep.
   *
   * A set rather than one id because `concurrency` may be raised above one, and
   * the dedupe has to cover everybody in the air, not just the newest.
   */
  readonly inFlight: Set<string>;
  tokens: number;
  lastRefill: number;
  draining: boolean;
}

export function createRoleNudgeQueue(deps: RoleNudgeQueueDeps): RoleNudgeQueue {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tuning: RoleNudgeTuning = { ...NUDGE_DEFAULTS, ...deps.tuning };
  const lanes = new Map<string, GuildLane>();
  let stopped = false;

  const laneFor = (guildId: string): GuildLane => {
    const existing = lanes.get(guildId);
    if (existing !== undefined) return existing;
    const lane: GuildLane = {
      waiting: new Set(),
      inFlight: new Set(),
      tokens: tuning.burst,
      lastRefill: now(),
      draining: false,
    };
    lanes.set(guildId, lane);
    return lane;
  };

  /** Hands back whatever time has earned since the last look. */
  const refill = (lane: GuildLane): void => {
    const at = now();
    // A refill of zero is "no pacing at all", which is a configuration a guild
    // with a measured ceiling is allowed to ask for. Guarded because dividing
    // by it would earn Infinity tokens and then never advance the clock.
    const earned =
      tuning.refillMs <= 0 ? tuning.burst : Math.floor((at - lane.lastRefill) / tuning.refillMs);
    if (earned <= 0) return;
    lane.tokens = Math.min(tuning.burst, lane.tokens + earned);
    lane.lastRefill = at;
  };

  const drain = async (guildId: string, lane: GuildLane): Promise<void> => {
    lane.draining = true;
    /** The reconciles in the air, so the loop can wait for the next free slot. */
    const running = new Set<Promise<void>>();
    try {
      while (!stopped && (lane.waiting.size > 0 || running.size > 0)) {
        // Nothing left to start, or no room to start it: wait for whichever of
        // the in-flight passes finishes first. `running` is never empty here —
        // the loop condition and a concurrency floor of one guarantee it.
        if (lane.waiting.size === 0 || running.size >= tuning.concurrency) {
          await Promise.race(running);
          continue;
        }

        refill(lane);
        if (lane.tokens <= 0) {
          // Either a token arrives or a pass finishes; both change the answer,
          // and waiting only for the timer would idle a free slot.
          await (running.size > 0
            ? Promise.race([...running, sleep(tuning.refillMs)])
            : sleep(tuning.refillMs));
          continue;
        }

        const next = lane.waiting.values().next();
        if (next.done === true) continue;
        const discordId = next.value;
        lane.waiting.delete(discordId);
        lane.tokens -= 1;
        // A lane that has just spent its last token starts earning again from
        // now, not from whenever it was last idle — otherwise a queue that sat
        // quiet for a minute would bank sixty tokens and spend them at once.
        if (lane.tokens === 0) lane.lastRefill = now();

        // Guarded even though `syncOneMember` is documented not to throw. A
        // lane that died on one member would hand everybody queued behind them
        // back to the sweep, which is a fifteen-minute penalty for being
        // unlucky about queue position.
        lane.inFlight.add(discordId);
        // Declared before it is built so the completion callback can remove
        // itself from the set it is about to be put into.
        let pass: Promise<void>;
        pass = deps
          .sync(guildId, discordId)
          .catch(() => undefined)
          .then(() => {
            lane.inFlight.delete(discordId);
            running.delete(pass);
          });
        running.add(pass);
      }
      if (stopped) {
        for (const discordId of lane.waiting) deps.onDropped?.(guildId, discordId, "stopped");
        lane.waiting.clear();
      }
    } finally {
      lane.draining = false;
      if (lane.waiting.size === 0 && lane.tokens >= tuning.burst) lanes.delete(guildId);
    }
  };

  return {
    nudge(guildId, discordId) {
      if (stopped) return false;
      const lane = laneFor(guildId);
      if (lane.waiting.has(discordId) || lane.inFlight.has(discordId)) return true;
      if (lane.waiting.size >= tuning.maxPending) {
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
    tuning() {
      return tuning;
    },
    stop() {
      stopped = true;
    },
  };
}
