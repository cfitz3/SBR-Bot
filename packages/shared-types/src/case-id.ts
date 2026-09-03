/**
 * Case identifiers people can actually use.
 *
 * A case used to be called `cmt7k3brh00dtb0uixiys3dbr`. That is a fine primary
 * key and a terrible name: nobody reads it aloud, nobody types it into a search
 * box without transposing something, and two of them side by side in a mod-log
 * are indistinguishable at a glance. Staff worked around it by describing cases
 * — "the mute on DrJay last Tuesday" — which is exactly the information the id
 * should have carried.
 *
 * So a case is now `CASE-DrJay-a1b2c3d4-2`, and each part earns its place:
 *
 * - **`DrJay`** — who it is about, which is the first thing anyone asks. It is
 *   a label, not a key: names change, and a case keeps whatever name the person
 *   had when it was issued.
 * - **`a1b2c3d4`** — the first eight characters of their Minecraft uuid, which
 *   is the part that *is* stable. Two members called `Steve` are two different
 *   people here, and a rename does not orphan the case.
 * - **`2`** — their second case in this guild. This is what turns "he's been
 *   warned before" into a number, and it is why the sequence is per person
 *   rather than global: a guild's thousandth case tells you nothing, and
 *   somebody's third one tells you everything.
 *
 * The old cuid is not thrown away. It stays the primary key, every existing
 * mod-log card that quoted it still resolves, and this is an additional name
 * rather than a replacement.
 */

/** What every case id starts with, so one is recognisable pasted into anything. */
export const CASE_PREFIX = "CASE";

/** Longest name segment. Long enough for any Minecraft IGN; short enough to read. */
export const CASE_NAME_MAX = 16;

/** How many uuid characters ride in the id. */
export const CASE_UUID_CHARS = 8;

/** The stand-in when we have no name at all — a webhook action, a purged user. */
const UNKNOWN_NAME = "unknown";

/**
 * Reduce a name to the characters an id can safely carry.
 *
 * Hyphen is the separator, so it cannot appear inside a segment; everything
 * else outside `[A-Za-z0-9_]` goes for the same reason a filename does not keep
 * spaces. Case is preserved — `DrJay` reads better than `drjay`, and matching is
 * done case-insensitively anyway.
 */
export function sanitizeCaseName(name: string | null | undefined): string {
  const cleaned = (name ?? "").replace(/[^A-Za-z0-9_]/g, "").slice(0, CASE_NAME_MAX);
  return cleaned.length > 0 ? cleaned : UNKNOWN_NAME;
}

/**
 * The identifying fragment of a uuid.
 *
 * Dashes are stripped first because our records are dashed and Hypixel's are
 * not, and an id that differed by input format would defeat the point. With no
 * uuid — a Discord-only punishment on somebody who never linked — the caller
 * passes their snowflake instead, which is just as stable and just as much
 * theirs.
 */
export function caseUuidFragment(uuid: string | null | undefined): string {
  const compact = (uuid ?? "").replace(/-/g, "").toLowerCase();
  return compact.length > 0 ? compact.slice(0, CASE_UUID_CHARS) : "00000000";
}

export interface CaseCodeParts {
  /** The target's IGN, or their Discord username when they have never linked. */
  readonly name: string | null | undefined;
  /** Minecraft uuid, or the Discord snowflake as the stable fallback. */
  readonly uuid: string | null | undefined;
  /** Their nth case in this guild, starting at 1. */
  readonly sequence: number;
}

/** Format one case id. Total order of the parts is the contract; see the header. */
export function formatCaseCode(parts: CaseCodeParts): string {
  const sequence = Number.isFinite(parts.sequence) && parts.sequence > 0 ? Math.floor(parts.sequence) : 1;
  return [
    CASE_PREFIX,
    sanitizeCaseName(parts.name),
    caseUuidFragment(parts.uuid),
    String(sequence),
  ].join("-");
}

export interface ParsedCaseCode {
  readonly name: string;
  readonly uuidFragment: string;
  readonly sequence: number;
}

/**
 * Read an id back, for a search box that is handed one.
 *
 * Deliberately strict about shape and lenient about case, because the two ways
 * somebody arrives at a search box with an id are pasting it and typing it, and
 * only the second gets the capitals wrong.
 */
export function parseCaseCode(code: string): ParsedCaseCode | null {
  const parts = code.trim().split("-");
  if (parts.length !== 4) return null;
  const [prefix, name, uuidFragment, sequence] = parts as [string, string, string, string];
  if (prefix.toUpperCase() !== CASE_PREFIX) return null;
  if (!/^[A-Za-z0-9_]+$/.test(name)) return null;
  if (!/^[0-9a-fA-F]+$/.test(uuidFragment)) return null;
  const n = Number(sequence);
  if (!Number.isInteger(n) || n < 1) return null;
  return { name, uuidFragment: uuidFragment.toLowerCase(), sequence: n };
}

/**
 * Whether a search term looks like somebody reaching for a case id.
 *
 * Used to decide whether a free-text search should match the id column exactly
 * or fall back to matching names — a term that is obviously an id should not
 * also drag in every case whose reason happens to contain it.
 */
export function looksLikeCaseCode(term: string): boolean {
  return term.trim().toUpperCase().startsWith(`${CASE_PREFIX}-`);
}
