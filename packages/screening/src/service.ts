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
  readonly now?: () => Date;
}

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

    const decision = evaluate({ policy, scammer, stats, history, now });

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

  /** The staff queue. */
  async pending(guildId: string, limit = 25): Promise<readonly ScreeningRecord[]> {
    return (await this.guarded("pending", () => this.d.repo.pending(guildId, limit), [])) ?? [];
  }

  /** Screening history for one player. */
  async forPlayer(guildId: string, uuid: string, limit = 5): Promise<readonly ScreeningRecord[]> {
    return (await this.guarded("forPlayer", () => this.d.repo.forPlayer(guildId, uuid, limit), [])) ?? [];
  }

  /** The row a `/g accept` in chat should be matched against, if any. */
  async findPending(guildId: string, uuid: string): Promise<ScreeningRecord | null> {
    return (await this.guarded("findPending", () => this.d.repo.findPending(guildId, uuid), null)) ?? null;
  }

  /** The guild's current policy, defaults filled in. */
  async policyFor(guildId: string): Promise<ScreeningPolicy> {
    const raw = await this.guarded("policy", () => this.d.policy?.read(guildId), undefined);
    return raw === undefined ? DEFAULT_POLICY : parsePolicy(raw);
  }

  // ── gathering ──

  private async readScammer(uuid: string, discordId: string | null, errors: string[]): Promise<ScammerFinding> {
    if (!this.d.scammer) return { status: "UNKNOWN", detail: "scammer lookup not configured" };
    try {
      return await this.d.scammer.check(uuid, discordId);
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
      return await this.d.stats.read(uuid);
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
      return await this.d.history.read(guildId, uuid, discordId, windowDays);
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
