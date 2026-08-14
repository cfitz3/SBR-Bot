/**
 * Canned replies, and the auto-response patterns that fire them.
 *
 * The pattern is operator-supplied, which makes it the one genuinely dangerous
 * value in this package: an invalid regex throws, and a catastrophically
 * backtracking one hangs the message-capture path for every ticket in the
 * guild. So a pattern is compiled once, defensively, and a tag whose pattern
 * will not compile is **disabled rather than skipped silently** — the panel can
 * then show the operator that their pattern is broken instead of leaving them
 * wondering why the tag never fires.
 */
import type { TicketTagDTO } from "@sbr/shared-types";

export interface CompiledTag {
  readonly tag: TicketTagDTO;
  /** Null when the tag has no pattern, or when the pattern would not compile. */
  readonly pattern: RegExp | null;
  /** Set when the pattern was rejected, for the panel to show. */
  readonly problem: string | null;
}

/**
 * Rough guard against a pattern that will backtrack forever. Not a proof — no
 * cheap check is — but it catches the shapes people actually write by accident,
 * like `(a+)+` and `(.*)*`.
 */
function looksCatastrophic(pattern: string): boolean {
  return /\([^)]*[+*]\)[+*]/.test(pattern);
}

export function compileTag(tag: TicketTagDTO): CompiledTag {
  if (tag.autoPattern === null || tag.autoPattern.trim() === "") {
    return { tag, pattern: null, problem: null };
  }
  if (tag.autoPattern.length > 300) {
    return { tag, pattern: null, problem: "pattern is too long (300 characters max)" };
  }
  if (looksCatastrophic(tag.autoPattern)) {
    return { tag, pattern: null, problem: "pattern nests repetition and could hang on some messages" };
  }
  try {
    // `mi` — the reference implementation's flags: case-insensitive, and `^`/`$`
    // anchor per line so a pattern still matches inside a multi-line message.
    return { tag, pattern: new RegExp(tag.autoPattern, "mi"), problem: null };
  } catch (error) {
    return { tag, pattern: null, problem: `pattern is not a valid expression: ${String(error)}` };
  }
}

export function compileTags(tags: readonly TicketTagDTO[]): readonly CompiledTag[] {
  return tags.map(compileTag);
}

/**
 * The first enabled tag whose pattern matches, or null.
 *
 * First rather than all: a member asking one question should get one canned
 * answer, not four. Ordering is the caller's — the repository returns tags by
 * name, so the choice is at least stable and explicable.
 */
export function matchTag(compiled: readonly CompiledTag[], text: string): TicketTagDTO | null {
  for (const c of compiled) {
    if (!c.tag.enabled || c.pattern === null) continue;
    // `lastIndex` is irrelevant without /g, but resetting keeps this safe if a
    // future flag change adds it.
    c.pattern.lastIndex = 0;
    if (c.pattern.test(text)) return c.tag;
  }
  return null;
}

/** A tag by name, case-insensitively — `/tag welcome` should find "Welcome". */
export function findTag(tags: readonly TicketTagDTO[], name: string): TicketTagDTO | null {
  const q = name.trim().toLowerCase();
  return tags.find((t) => t.name.toLowerCase() === q) ?? null;
}
