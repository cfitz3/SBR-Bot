/**
 * ScreeningService — everything that happens between "someone asked to join"
 * and "staff have a decision in front of them".
 *
 * The orchestration is small; what it is careful about is failure. A join
 * request arrives on a Minecraft chat line, inside a bot whose event loop also
 * carries the bridge. So:
 *
 * - **No port is trusted to resolve.** Each is wrapped, and a throw becomes an
 *   UNKNOWN reading with the error recorded on the row.
 * - **The lookups run concurrently.** Three sequential network calls is a
 *   noticeable pause on a request that a human is watching in guild chat.
 * - **A failure to persist never blocks a decision.** If the database is down
 *   we still tell staff what we found; losing the audit row is bad, refusing to
 *   screen because we cannot write is worse.
 * - **Deciding is separate from screening.** `screen()` produces a verdict and
 *   a row; whether that turns into `/g accept` is the caller's business, gated
 *   on `policy.autoAccept`. The domain does not send game commands.
 */
import type { Logger } from "@sbr/observability";
import { evaluate, parsePolicy } from "./policy.js";
import { JOIN_WINDOW_MS } from "./window.js";
import type {
  ApplicantHistorySource,
  ApplicantLinkSource,
  ApplicantStatsSource,
  ScammerLookup,
  ScreeningRecord,
  ScreeningRepository,
  ScreeningPolicySource,
} from "./ports.js";
import {
  DEFAULT_POLICY,
  NO_HISTORY,
  UNREADABLE_STATS,
  type ApplicantHistory,
  type ApplicantStats,
  type ScammerFinding,
  type Screening,
  type ScreeningOutcome,
  type ScreeningPolicy,
} from "./types.js";

export interface ScreeningServiceDeps {
  readonly repo: ScreeningRepository;
  readonly logger: Logger;
  /** Without it, every screening records SCAMMER_UNKNOWN — which is honest. */
  readonly scammer?: ScammerLookup;
  /** Without it, stats are unreadable rather than absent. */
  readonly stats?: ApplicantStatsSource;
  /** Without it, no applicant has any history. */
  readonly history?: ApplicantHistorySource;
  /** Without it, policy is the default: record, report, decide nothing. */
  readonly policy?: ScreeningPolicySource;
  /** Without it, the Discord side of the scammer check is simply skipped. */
  readonly links?: ApplicantLinkSource;
  /**
   * How long the gathering phase may take before it answers with what it has.
   *
   * A join request is on a five-minute upstream clock (see `window.ts`), and
   * every lookup here is a third party: Hypixel, the scammer list, our own
   * database. Without a budget a single hung socket holds the verdict for as
   * long as its own timeout — which for an undisclosed default can be minutes —
   * and the request expires while we are still deciding. Better to judge on
   * three fields we have and one we admit we could not read.
   */
  readonly budgetMs?: number;
  readonly now?: () => Date;
}

/**
 * Long enough for a healthy Hypixel round trip plus a retry, short enough that
 * a dead dependency costs a twentieth of the window rather than all of it.
 */
export const DEFAULT_SCREEN_BUDGET_MS = 8_000;

export interface ScreenRequest {
  readonly guildId: string;
  readonly uuid: string;
  readonly ign: string;
  /** Passed when the caller already knows it; otherwise resolved via `links`. */
  readonly discordId?: string | null;
}

export interface ScreenResult {
  readonly screening: Screening;
  readonly policy: ScreeningPolicy;
  /** Row id, or null when the write failed — the screening still stands. */
  readonly id: string | null;
  /**
   * Whether the caller should send `/g accept` now. True only for an ACCEPT
   * verdict under a policy that is both enabled and set to auto-accept.
   */
  readonly shouldAccept: boolean;
}

export class ScreeningService {
  private readonly d: ScreeningServiceDeps;
  private readonly log: Logger;

  constructor(deps: ScreeningServiceDeps) {
    this.d = deps;
    this.log = deps.logger.child({ component: "screening" });
  }

  /** Screen one join request: gather, judge, record. */
  async screen(req: ScreenRequest): Promise<ScreenResult> {
    const now = this.d.now?.() ?? new Date();
    const policy = parsePolicy(await this.guarded("policy", () => this.d.policy?.read(req.guildId), undefined));

    const discordId = req.discordId ?? (await this.guarded("link", () => this.d.links?.discordIdForUuid(req.uuid), null)) ?? null;

    const errors: string[] = [];
    const [scammer, stats, history] = await Promise.all([
      this.readScammer(req.uuid, discordId, errors),
      this.readStats(req.uuid, errors),
      this.readHistory(req.guildId, req.uuid, discordId, policy.repeatWindowDays, errors),
    ]);

    const decision = evaluate({ policy, scammer, stats, history });

    const screening: Screening = {
      uuid: req.uuid,
      ign: req.ign,
      discordId,
      requestedAt: now,
      verdict: decision.verdict,
      riskScore: decision.riskScore,
      reasons: decision.reasons,
      scammer,
      stats,
      history,
      error: errors.length > 0 ? errors.join("; ") : null,
    };

    const id = await this.guarded("record", () => this.d.repo.record(req.guildId, screening), null);
    if (id === null) this.log.warn("screening not persisted; decision still stands", { uuid: req.uuid });

    const shouldAccept = policy.enabled && policy.autoAccept && decision.verdict === "ACCEPT";

    this.log.info("join request screened", {
      guildId: req.guildId,
      ign: req.ign,
      verdict: decision.verdict,
      risk: decision.riskScore,
      reasons: [...decision.reasons].join(","),
      shouldAccept,
    });

    return { screening, policy, id, shouldAccept };
  }

  /**
   * Attach an outcome to a recorded screening. Silent when `id` is null — the
   * caller can then still act, it just has nothing to annotate.
   */
  async decide(id: string | null, outcome: ScreeningOutcome, by: string): Promise<void> {
    if (!id) return;
    await this.guarded("decide", () => this.d.repo.decide(id, outcome, by), undefined);
  }

  /**
   * The staff queue: requests that can still be answered.
   *
   * Stale rows are retired first. It would be cheaper to filter them out on
   * read and let a nightly job do the writing, but then the queue and the table
   * disagree — the panel shows four waiting, the database says nine PENDING,
   * and the next person to look at either concludes the other is broken.
   */
  async pending(guildId: string, limit = 25): Promise<readonly ScreeningRecord[]> {
    await this.expireStale(guildId);
    return (await this.guarded("pending", () => this.d.repo.pending(guildId, limit), [])) ?? [];
  }

  /**
   * Retire requests whose upstream window has closed. Returns how many.
   *
   * Safe to call as often as you like: it only ever touches rows that are both
   * PENDING and older than the window, so a second call in the same second
   * finds nothing left to do.
   */
  async expireStale(guildId: string, windowMs: number = JOIN_WINDOW_MS): Promise<number> {
    const cutoff = new Date((this.d.now?.() ?? new Date()).getTime() - windowMs);
    const expired = (await this.guarded("expireStale", () => this.d.repo.expireStale(guildId, cutoff), 0)) ?? 0;
    if (expired > 0) this.log.info("join requests expired unanswered", { guildId, count: expired });
    return expired;
  }

  /** Screening history for one player. */
  async forPlayer(guildId: string, uuid: string, limit = 5): Promise<readonly ScreeningRecord[]> {
    return (await this.guarded("forPlayer", () => this.d.repo.forPlayer(guildId, uuid, limit), [])) ?? [];
  }

  /** The row a `/g accept` in chat should be matched against, if any. */
  async findPending(guildId: string, uuid: string): Promise<ScreeningRecord | null> {
    return (await this.guarded("findPending", () => this.d.repo.findPending(guildId, uuid), null)) ?? null;
  }

  /**
   * The most recent request we have on record from somebody staff have named.
   *
   * Any outcome, not just PENDING, and by name when no uuid resolves. Both
   * relaxations serve one caller — `admit()` — which is not asking "is there
   * work queued for me" but "what happened to this person's request", and would
   * otherwise mistake a lapsed request for no request at all.
   */
  async latestRequest(guildId: string, uuid: string | null, ign: string): Promise<ScreeningRecord | null> {
    if (uuid !== null) {
      const byUuid = await this.forPlayer(guildId, uuid, 1);
      const newest = byUuid[0];
      if (newest !== undefined) return newest;
    }
    return (await this.guarded("findLatestByIgn", () => this.d.repo.findLatestByIgn(guildId, ign), null)) ?? null;
  }

  /** The guild's current policy, defaults filled in. */
  async policyFor(guildId: string): Promise<ScreeningPolicy> {
    const raw = await this.guarded("policy", () => this.d.policy?.read(guildId), undefined);
    return raw === undefined ? DEFAULT_POLICY : parsePolicy(raw);
  }

  // ── gathering ──

  /** The gathering budget in force. */
  private get budget(): number {
    return this.d.budgetMs ?? DEFAULT_SCREEN_BUDGET_MS;
  }

  private async readScammer(uuid: string, discordId: string | null, errors: string[]): Promise<ScammerFinding> {
    if (!this.d.scammer) return { status: "UNKNOWN", detail: "scammer lookup not configured" };
    try {
      const timeout = `timed out after ${this.budget}ms`;
      return await deadline(this.d.scammer.check(uuid, discordId), this.budget, () => {
        errors.push(`scammer: ${timeout}`);
        this.log.warn("scammer lookup exceeded the screening budget", { uuid, budgetMs: this.budget });
        return { status: "UNKNOWN", detail: timeout } as const;
      });
    } catch (e) {
      const detail = message(e);
      errors.push(`scammer: ${detail}`);
      this.log.warn("scammer lookup failed", { uuid, err: detail });
      return { status: "UNKNOWN", detail };
    }
  }

  private async readStats(uuid: string, errors: string[]): Promise<ApplicantStats> {
    if (!this.d.stats) return UNREADABLE_STATS;
    try {
      return await deadline(this.d.stats.read(uuid), this.budget, () => {
        errors.push(`stats: timed out after ${this.budget}ms`);
        this.log.warn("stat read exceeded the screening budget", { uuid, budgetMs: this.budget });
        return UNREADABLE_STATS;
      });
    } catch (e) {
      const detail = message(e);
      errors.push(`stats: ${detail}`);
      this.log.warn("stat read failed", { uuid, err: detail });
      return UNREADABLE_STATS;
    }
  }

  private async readHistory(
    guildId: string,
    uuid: string,
    discordId: string | null,
    windowDays: number,
    errors: string[],
  ): Promise<ApplicantHistory> {
    if (!this.d.history) return NO_HISTORY;
    try {
      return await deadline(this.d.history.read(guildId, uuid, discordId, windowDays), this.budget, () => {
        errors.push(`history: timed out after ${this.budget}ms`);
        this.log.warn("history read exceeded the screening budget", { uuid, budgetMs: this.budget });
        return NO_HISTORY;
      });
    } catch (e) {
      const detail = message(e);
      errors.push(`history: ${detail}`);
      this.log.warn("history read failed", { uuid, err: detail });
      return NO_HISTORY;
    }
  }

  /**
   * Run an optional, possibly-throwing call and fall back rather than reject.
   * The fallback is passed rather than inferred so each caller states what
   * "we could not find out" means for its own field.
   */
  private async guarded<T>(what: string, run: () => Promise<T> | undefined, fallback: T): Promise<T> {
    try {
      const out = await run();
      return out === undefined ? fallback : out;
    } catch (e) {
      this.log.warn("screening dependency failed", { what, err: message(e) });
      return fallback;
    }
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Resolve `work`, or `onTimeout()` if it takes longer than `ms`.
 *
 * Two details that are easy to get wrong and expensive to debug. The timer is
 * always cleared, so a fast lookup does not pin the event loop open for the
 * remainder of the budget — in a process that also runs a Minecraft session,
 * leaked timers are how a clean shutdown becomes a hang. And the abandoned work
 * keeps a catch attached: it is still in flight when we stop waiting, and a
 * socket that rejects after the race has been lost would otherwise surface as
 * an unhandled rejection with no context at all.
 */
async function deadline<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    const outcome = await Promise.race([work, expiry]);
    if (outcome === TIMED_OUT) {
      void work.catch(() => {});
      return onTimeout();
    }
    return outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A sentinel no port could return, so the race result is unambiguous. */
const TIMED_OUT = Symbol("screening-deadline");
