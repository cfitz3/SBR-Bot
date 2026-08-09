/**
 * The vocabulary of a screening: what we found, what it means, and what was
 * decided.
 *
 * Two conventions run through everything here.
 *
 * **Unknown is its own value.** Every stat is `number | null`, and the scammer
 * check is a three-state rather than a boolean. A player with their API off is
 * unreadable, not level zero; a scammer list that timed out has not cleared
 * anybody. The policy is allowed to treat unknown harshly — that is a config
 * choice — but it is never allowed to mistake it for a pass.
 *
 * **Reasons are codes, not sentences.** The policy raises `NEW_ACCOUNT`; the
 * bridge and the staff report turn that into English. Codes survive being
 * stored for a year and counted afterwards, which is the whole point of keeping
 * a row per attempt.
 */

/** What the policy concluded. */
export type ScreeningVerdict = "ACCEPT" | "REVIEW" | "DENY";

/** What happened to the request afterwards. Mirrors the DB enum. */
export type ScreeningOutcome = "PENDING" | "ACCEPTED" | "DENIED" | "EXPIRED" | "JOINED";

/**
 * Why the policy landed where it did. Ordered roughly by severity within each
 * group; the renderer relies on nothing but exhaustiveness.
 */
export type ScreeningReason =
  // Scammer list
  | "SCAMMER_FLAGGED"
  | "SCAMMER_UNKNOWN"
  // History with this guild
  | "PRIOR_EXPULSION"
  | "PRIOR_DENIAL"
  | "REPEAT_ATTEMPTS"
  // The account itself
  | "NEW_ACCOUNT"
  | "INACTIVE"
  | "STATS_UNREADABLE"
  | "API_DISABLED"
  // Requirement bars
  | "BELOW_SKYBLOCK_LEVEL"
  | "BELOW_SKILL_AVERAGE"
  | "BELOW_CATACOMBS"
  | "BELOW_WEIGHT"
  | "BELOW_NETWORTH"
  // Everything passed
  | "MEETS_REQUIREMENTS";

/**
 * A scammer-list finding. `CLEAR` means the list was asked and had nothing;
 * `UNKNOWN` means we could not ask, or could not read the answer.
 */
export type ScammerFinding =
  | { readonly status: "CLEAR" }
  | {
      readonly status: "FLAGGED";
      readonly reason: string | null;
      /** Which identifier matched, so a staff report can say how we know. */
      readonly source: "UUID" | "DISCORD";
    }
  | { readonly status: "UNKNOWN"; readonly detail: string | null };

/**
 * The applicant's stats as read at the moment of the request. Every field is
 * independently nullable: Hypixel exposes each API section separately, so a
 * profile can be readable for skills and dark for banking in the same breath.
 */
export interface ApplicantStats {
  readonly profileName: string | null;
  readonly skyblockLevel: number | null;
  readonly skillAverage: number | null;
  readonly catacombsLevel: number | null;
  readonly senitherWeight: number | null;
  /** Coins. Bigint because an established account clears 2^31 easily. */
  readonly networth: bigint | null;
  readonly firstLoginAt: Date | null;
  readonly lastLoginAt: Date | null;
  /** Guild they are currently in, when we could see one. */
  readonly currentGuild: string | null;
  /** True when we know a section was hidden rather than merely absent. */
  readonly apiDisabled: boolean;
  /** Nothing at all was readable — the account is opaque to us. */
  readonly unreadable: boolean;
  /** Anything else worth storing but not worth a column. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** An empty reading, for the paths where the stats source could not answer. */
export const UNREADABLE_STATS: ApplicantStats = {
  profileName: null,
  skyblockLevel: null,
  skillAverage: null,
  catacombsLevel: null,
  senitherWeight: null,
  networth: null,
  firstLoginAt: null,
  lastLoginAt: null,
  currentGuild: null,
  apiDisabled: false,
  unreadable: true,
  extra: {},
};

/** What the guild already knows about this applicant. */
export interface ApplicantHistory {
  /** Screening attempts inside the policy's repeat window, this one excluded. */
  readonly recentAttempts: number;
  /** A previous attempt was refused. */
  readonly priorDenial: boolean;
  /** They were kicked or banned by this guild before. */
  readonly priorExpulsion: boolean;
  /** Why, when the moderation record said. */
  readonly expulsionReason: string | null;
}

export const NO_HISTORY: ApplicantHistory = {
  recentAttempts: 0,
  priorDenial: false,
  priorExpulsion: false,
  expulsionReason: null,
};

/**
 * Per-guild screening policy. Lives in `GuildSetting` under `screening.policy`,
 * never in `.env` — a requirement bar is exactly the kind of thing staff change
 * on a Friday night without wanting a redeploy.
 *
 * Every threshold is nullable and null means "do not check this". A guild that
 * only cares about the scammer list sets nothing else and gets exactly that.
 */
export interface ScreeningPolicy {
  /** Off means the bot observes and records but never decides. */
  readonly enabled: boolean;
  /**
   * Whether an ACCEPT verdict actually sends `/g accept`. Separate from
   * `enabled` on purpose: the honest way to roll this out is to run it in
   * report-only mode for a week and read what it *would* have done.
   */
  readonly autoAccept: boolean;
  /** A listed scammer is refused outright rather than queued for a human. */
  readonly denyOnScammer: boolean;
  /** An unreachable scammer list holds the request for a human. */
  readonly reviewOnScammerUnknown: boolean;
  /** A previous kick or ban from this guild is refused outright. */
  readonly denyOnPriorExpulsion: boolean;
  /** An unreadable account holds for a human rather than passing. */
  readonly reviewOnUnreadable: boolean;

  readonly minSkyblockLevel: number | null;
  readonly minSkillAverage: number | null;
  readonly minCatacombs: number | null;
  readonly minSenitherWeight: number | null;
  /** Coins. Serialized as a string in settings JSON; parsed to bigint here. */
  readonly minNetworth: bigint | null;
  readonly minAccountAgeDays: number | null;
  /** Last login older than this holds for review. */
  readonly maxInactiveDays: number | null;

  /** How far back `recentAttempts` looks. */
  readonly repeatWindowDays: number;
  /** Attempts inside the window, beyond which the request holds for review. */
  readonly maxAttemptsInWindow: number;
  /**
   * Risk at or above which an otherwise-passing request holds for review.
   * Reasons alone decide DENY; the score only ever escalates ACCEPT to REVIEW.
   */
  readonly reviewAtRisk: number;
}

/**
 * The policy as it travels over JSON — identical to `ScreeningPolicy` except
 * that the coin threshold is a decimal string, because JSON has no bigint and
 * ten billion coins is past the point where a double is still exact.
 *
 * Named as a distinct type rather than left as `Record<string, unknown>` so the
 * panel's edit form and its read of the current values are checked against the
 * same field list the evaluator uses.
 */
export type ScreeningPolicyView = Omit<ScreeningPolicy, "minNetworth"> & {
  readonly minNetworth: string | null;
};

/**
 * The `GuildSetting` key the policy lives under. Declared here, beside the
 * shape it names, so the reader, the writer and the panel cannot disagree about
 * where it is stored.
 */
export const SCREENING_POLICY_KEY = "screening.policy";

/**
 * Defaults chosen to be *safe rather than useful*: screening runs, records, and
 * reports, but decides nothing and admits nobody until a guild says otherwise.
 * A platform that starts auto-accepting strangers the moment it is deployed is
 * a platform nobody can safely deploy.
 */
export const DEFAULT_POLICY: ScreeningPolicy = {
  enabled: true,
  autoAccept: false,
  denyOnScammer: true,
  reviewOnScammerUnknown: true,
  denyOnPriorExpulsion: true,
  reviewOnUnreadable: true,
  minSkyblockLevel: null,
  minSkillAverage: null,
  minCatacombs: null,
  minSenitherWeight: null,
  minNetworth: null,
  minAccountAgeDays: null,
  maxInactiveDays: null,
  repeatWindowDays: 30,
  maxAttemptsInWindow: 3,
  reviewAtRisk: 50,
};

/** The complete result of screening one request. */
export interface Screening {
  readonly uuid: string;
  readonly ign: string;
  readonly discordId: string | null;
  readonly requestedAt: Date;
  readonly verdict: ScreeningVerdict;
  /** 0–100. Higher is riskier. */
  readonly riskScore: number;
  readonly reasons: readonly ScreeningReason[];
  readonly scammer: ScammerFinding;
  readonly stats: ApplicantStats;
  readonly history: ApplicantHistory;
  /** Set when screening itself failed, so an outage-driven REVIEW is legible. */
  readonly error: string | null;
}
