/**
 * What screening needs from the outside world.
 *
 * Four ports, and every one of them is allowed to fail: the scammer list can be
 * down, Hypixel can be rate-limited, the applicant's API can be off, the guild
 * may have no policy stored yet. The service's job is to turn each of those into
 * a *recorded uncertainty* rather than an exception, so wire the adapters to
 * resolve rather than throw wherever you can — but the service defends against
 * throwing adapters too, because a rejected promise inside a chat handler takes
 * the bridge down with it.
 */
import type { ApplicantHistory, ApplicantStats, ScammerFinding, Screening, ScreeningOutcome } from "./types.js";

/** The scammer list. Implemented over `@sbr/skykings` at wiring time. */
export interface ScammerLookup {
  /**
   * Check a player. `discordId` is passed when we know it, because the list
   * indexes both and a scammer who changed accounts is still the same person.
   */
  check(uuid: string, discordId: string | null): Promise<ScammerFinding>;
}

/** The applicant's public stats. Implemented over Hypixel + progression. */
export interface ApplicantStatsSource {
  read(uuid: string): Promise<ApplicantStats>;
}

/** What the guild already knows about them. Implemented over `@sbr/db`. */
export interface ApplicantHistorySource {
  read(guildId: string, uuid: string, discordId: string | null, windowDays: number): Promise<ApplicantHistory>;
}

/** A stored screening, as it comes back out. */
export interface ScreeningRecord extends Screening {
  readonly id: string;
  readonly guildId: string;
  readonly outcome: ScreeningOutcome;
  readonly decidedAt: Date | null;
  readonly decidedBy: string | null;
}

export interface ScreeningRepository {
  /** Persist a completed screening. Returns the row id for later decisions. */
  record(guildId: string, screening: Screening): Promise<string>;
  /** Attach the outcome once it is known. `by` is `AUTO` or a Discord id. */
  decide(id: string, outcome: ScreeningOutcome, by: string): Promise<void>;
  /** The staff queue: PENDING screenings, oldest first. */
  pending(guildId: string, limit: number): Promise<readonly ScreeningRecord[]>;
  /** Most recent screenings for one player, newest first. */
  forPlayer(guildId: string, uuid: string, limit: number): Promise<readonly ScreeningRecord[]>;
  /** Newest screening for a player still awaiting a decision, if any. */
  findPending(guildId: string, uuid: string): Promise<ScreeningRecord | null>;
}

/**
 * The per-guild policy, read from `GuildSetting` under `screening.policy`.
 * Returns the raw stored JSON; `parsePolicy` does the interpreting, so a
 * malformed value degrades to defaults instead of taking screening offline.
 */
export interface ScreeningPolicySource {
  read(guildId: string): Promise<unknown>;
}

/** Resolve a uuid to a linked Discord id, when the platform knows one. */
export interface ApplicantLinkSource {
  discordIdForUuid(uuid: string): Promise<string | null>;
}
