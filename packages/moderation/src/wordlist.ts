/**
 * Chat-filter rules: compilation, evaluation, and the CRUD behind
 * `/wordlist-add`, `/wordlist-remove` and `/filter-test`.
 *
 * The matcher lives here rather than in the relay so that a rule a staffer
 * tests with `/filter-test` is compiled by exactly the same code that will
 * judge the next relayed message. A filter that behaves differently in its own
 * test harness than in production is worse than no test at all.
 */
import {
  err,
  ok,
  type FilterTestDTO,
  type NewWordlistRule,
  type Result,
  type WordAction,
  type WordlistError,
  type WordlistRuleDTO,
  type WordlistRuleUpdate,
  type WordlistService,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import type { WordlistRepository } from "./ports.js";

/** A compiled rule: does this message text trip it? */
export type Matcher = (content: string) => boolean;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile one rule to a matcher. A malformed REGEX yields a matcher that never
 * fires: the relay must not blow up on a rule somebody typed wrong months ago,
 * and `/wordlist-add` rejects bad patterns at entry so this path stays rare.
 */
export function compileRule(rule: Pick<WordlistRuleDTO, "pattern" | "matchType">): Matcher {
  const p = rule.pattern;
  switch (rule.matchType) {
    case "EXACT":
      return (c) => c.toLowerCase() === p.toLowerCase();
    case "SUBSTRING":
      return (c) => c.toLowerCase().includes(p.toLowerCase());
    case "REGEX":
      try {
        const re = new RegExp(p, "i");
        return (c) => re.test(c);
      } catch {
        return () => false;
      }
    case "WILDCARD": {
      const re = new RegExp(`^${p.split("*").map(escapeRegex).join(".*")}$`, "i");
      return (c) => re.test(c);
    }
  }
}

/** Rejects a pattern the relay could never use, with the reason a staffer needs. */
export function validatePattern(pattern: string, matchType: WordlistRuleDTO["matchType"]): string | null {
  if (pattern.trim().length === 0) return "the pattern is empty";
  if (matchType !== "REGEX") return null;
  try {
    new RegExp(pattern, "i");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "not a valid regular expression";
  }
}

/**
 * The verdict for a whole message. Precedence matters and is not "first match
 * wins": a message that trips both a REPLACE rule and a BLOCK rule must be
 * blocked, or the harsher rule would be defeated by rule ordering.
 */
export function evaluateText(rules: readonly WordlistRuleDTO[], text: string): FilterTestDTO {
  const matched: WordlistRuleDTO[] = [];
  let strongest: WordAction | null = null;
  let replacement: string | null = null;

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!compileRule(rule)(text)) continue;
    matched.push(rule);
    if (rule.action === "BLOCK" || rule.action === "SHADOW_MUTE") {
      // BLOCK and SHADOW_MUTE both suppress the message; first one seen wins,
      // since there is nothing stronger to be outranked by.
      strongest = strongest === "BLOCK" || strongest === "SHADOW_MUTE" ? strongest : rule.action;
    } else if (rule.action === "REPLACE") {
      replacement = (replacement ?? text).replace(/\S/g, "*");
      if (strongest !== "BLOCK" && strongest !== "SHADOW_MUTE") strongest = "REPLACE";
    } else if (strongest === null) {
      strongest = "FLAG";
    }
  }

  const action: WordAction | "ALLOW" = strongest ?? "ALLOW";
  return {
    text,
    matched,
    action,
    replacement: action === "REPLACE" ? replacement : null,
  };
}

export interface WordlistServiceDeps {
  readonly repo: WordlistRepository;
  readonly logger: Logger;
}

export class WordlistServiceImpl implements WordlistService {
  private readonly repo: WordlistRepository;
  private readonly log: Logger;

  constructor(deps: WordlistServiceDeps) {
    this.repo = deps.repo;
    this.log = deps.logger.child({ service: "wordlist" });
  }

  async list(guildId: string): Promise<Result<readonly WordlistRuleDTO[]>> {
    return ok(await this.repo.list(guildId));
  }

  async add(input: NewWordlistRule): Promise<Result<WordlistRuleDTO, WordlistError>> {
    const invalid = validatePattern(input.pattern, input.matchType);
    if (invalid !== null) return err({ kind: "INVALID_PATTERN", detail: invalid });

    const existing = await this.repo.list(input.guildId);
    if (existing.some((r) => r.pattern === input.pattern && r.matchType === input.matchType)) {
      return err({ kind: "DUPLICATE" });
    }

    const rule = await this.repo.add({
      guildId: input.guildId,
      pattern: input.pattern,
      matchType: input.matchType,
      action: input.action,
      severity: input.severity ?? 1,
      addedByDiscordId: input.addedByDiscordId,
      note: input.note ?? null,
    });
    this.log.info("wordlist rule added", {
      guildId: input.guildId,
      id: rule.id,
      matchType: rule.matchType,
      action: rule.action,
      actor: input.addedByDiscordId,
    });
    return ok(rule);
  }

  /**
   * Edit a rule in place.
   *
   * Validation and the duplicate check run on the *result* of the patch, not on
   * what was sent: editing only the match type can turn a pattern that was a
   * harmless substring into an invalid regex, and can collide with a rule that
   * already exists — neither is visible from the patch alone.
   */
  async update(
    guildId: string,
    id: string,
    patch: WordlistRuleUpdate,
  ): Promise<Result<WordlistRuleDTO | null, WordlistError>> {
    const existing = await this.repo.list(guildId);
    const current = existing.find((r) => r.id === id);
    if (!current) return ok(null);

    const pattern = patch.pattern ?? current.pattern;
    const matchType = patch.matchType ?? current.matchType;
    const invalid = validatePattern(pattern, matchType);
    if (invalid !== null) return err({ kind: "INVALID_PATTERN", detail: invalid });
    if (existing.some((r) => r.id !== id && r.pattern === pattern && r.matchType === matchType)) {
      return err({ kind: "DUPLICATE" });
    }

    const updated = await this.repo.update(guildId, id, patch);
    if (updated) {
      this.log.info("wordlist rule updated", {
        guildId,
        id,
        fields: Object.keys(patch),
      });
    }
    return ok(updated);
  }

  async remove(guildId: string, ref: string): Promise<Result<WordlistRuleDTO | null>> {
    const removed = (await this.repo.removeById(guildId, ref)) ?? (await this.repo.removeByPattern(guildId, ref));
    if (removed) this.log.info("wordlist rule removed", { guildId, id: removed.id });
    return ok(removed);
  }

  async test(guildId: string, text: string): Promise<Result<FilterTestDTO>> {
    return ok(evaluateText(await this.repo.list(guildId), text));
  }
}
