/**
 * The two product rules SBR-Guide is built on, written as code rather than as a
 * paragraph in a README, because a rule that only exists in prose is a rule that
 * gets forgotten during a busy slice (docs/GUIDE.md).
 *
 * Nothing here does I/O, reads a clock, or knows what a Discord message is. The
 * loader in `@sbr/guide-content` calls `isPublishable` on every record it
 * compiles, and the ranker never sees a record that failed.
 */

/**
 * The minimum a content record must carry to be allowed out of the loader.
 *
 * Structural on purpose: the full `GuideStep` shape lands with the content
 * schema, and declaring the gate over the two fields it actually reads means the
 * gate does not have to be revised when the rest of the record grows.
 */
export interface Citable {
  /**
   * Where the claim comes from. At least one entry, each a URL or a named
   * primary source a human can open and check.
   *
   * There is no LLM in the request path and no generated prose anywhere in this
   * project. A recommendation that cannot name where it came from is a guess
   * wearing a confident tone, and shipping one costs more trust than the advice
   * was ever going to earn.
   */
  readonly sources: readonly string[];
  /**
   * `"unverified"` is the honest state for a mechanic nobody has checked against
   * a primary source yet. It is written down rather than guessed at, and it is
   * excluded here rather than at render time, so an unverified record cannot
   * reach a player by way of some path that forgot to ask.
   */
  readonly status: ContentStatus;
}

export type ContentStatus = "verified" | "unverified";

/** Every rendered recommendation traces to a verified, sourced record. */
export function isPublishable(record: Citable): boolean {
  return record.status === "verified" && record.sources.some((s) => s.trim().length > 0);
}

/**
 * Why a record was withheld, for the loader's report.
 *
 * The compiler prints these; a corpus that silently drops half its records is
 * indistinguishable from a corpus that is half-written.
 */
export function withholdReason(record: Citable): string | null {
  if (!record.sources.some((s) => s.trim().length > 0)) return "no sources";
  if (record.status !== "verified") return `status is ${record.status}`;
  return null;
}
