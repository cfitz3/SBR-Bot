/**
 * Categories: the seeded set, ordering, and resolution by key.
 *
 * The five entries below are the values the old `TicketCategory` enum carried.
 * They are seeded as ordinary rows per guild by the rebuild migration rather
 * than held as a fallback in code, which is the whole point of the change: a
 * guild can rename, reorder, disable or delete any of them, and nothing here
 * reaches back in to restore what an admin deliberately removed.
 */
import type { TicketCategoryDTO, TicketCategoryInput } from "@sbr/shared-types";

/** Shape of a seeded category, before it has a guild or an id. */
export interface SeedCategory {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly position: number;
}

export const SEED_CATEGORIES: readonly SeedCategory[] = [
  { key: "SUPPORT", name: "Support", description: "General help from the staff team.", position: 0 },
  { key: "REPORT", name: "Report", description: "Report a member or a rule break.", position: 1 },
  { key: "APPEAL", name: "Appeal", description: "Appeal a mute, kick or ban.", position: 2 },
  { key: "APPLICATION", name: "Application", description: "Apply to the guild or to the staff team.", position: 3 },
  { key: "OTHER", name: "Other", description: "Anything that does not fit the rest.", position: 4 },
  { key: "BUG", name: "Bug report", description: "Something on the platform is broken.", position: 5 },
];

/**
 * Categories a guild may dress up but may not remove or switch off.
 *
 * `BUG` is the only one, and it is the only one for a reason worth stating:
 * every user-facing error the platform prints now ends by pointing at `/health`
 * and offering a button that opens a ticket here. A guild that deleted or
 * disabled this category would not lose a menu entry, it would break that
 * button for every member — and it would do so silently, at the exact moment
 * something else is already failing.
 *
 * "Permanent" is deliberately narrow. Name, emoji, description, staff roles,
 * parent channel, questions, limits and position are all still the guild's, so
 * this constrains the two operations that would break the button and nothing
 * else. Enforced in `@sbr/db`, which both the panel and the admin bot write
 * through, rather than in each of them.
 */
export const PERMANENT_CATEGORY_KEYS: readonly string[] = ["BUG"];

export function isPermanentCategory(key: string): boolean {
  return PERMANENT_CATEGORY_KEYS.includes(key);
}

/** Discord's own caps, which the editor and the panel builder both respect. */
export const CATEGORY_LIMITS = {
  /** Select-menu option descriptions are truncated by Discord past this. */
  description: 100,
  /** A modal takes five inputs, so a category may ask at most five questions. */
  questions: 5,
  /** Buttons per action row. */
  panelButtons: 5,
  /** Options in a select menu. */
  panelOptions: 25,
  /** Channels Discord allows under one category channel. */
  channelsPerParent: 50,
} as const;

/**
 * Menu order: `position` ascending, ties broken by name so the list is stable.
 *
 * Stability matters more than it looks — the panel renders buttons in this
 * order and a member learns where their category sits.
 */
export function orderCategories(
  categories: readonly TicketCategoryDTO[],
): readonly TicketCategoryDTO[] {
  return [...categories].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

/** The ones a member may actually pick, in menu order. */
export function openableCategories(
  categories: readonly TicketCategoryDTO[],
): readonly TicketCategoryDTO[] {
  return orderCategories(categories.filter((c) => c.enabled));
}

/**
 * Find a category by key, name or emoji, case-insensitively.
 *
 * Tolerant because the caller is a member typing into a command, not a button
 * press: `/ticket appeal`, `/ticket Appeal` and `/ticket "ban appeal"` should
 * all land somewhere sensible. A blank query picks the first openable category
 * — the guild's own default, by its own ordering. Disabled categories are never
 * matched, so a closed category reads as absent rather than as an error.
 */
export function findCategory(
  categories: readonly TicketCategoryDTO[],
  query: string | null,
): TicketCategoryDTO | null {
  const open = openableCategories(categories);
  const q = (query ?? "").trim().toLowerCase();
  if (q === "") return open[0] ?? null;
  return (
    open.find((c) => c.key.toLowerCase() === q) ??
    open.find((c) => c.name.toLowerCase() === q) ??
    open.find((c) => c.emoji === query) ??
    open.find((c) => c.name.toLowerCase().includes(q)) ??
    null
  );
}

/** A category by id, including disabled ones — an open ticket keeps its own. */
export function categoryById(
  categories: readonly TicketCategoryDTO[],
  id: string | null,
): TicketCategoryDTO | null {
  if (id === null) return null;
  return categories.find((c) => c.id === id) ?? null;
}

/** A category by key, including disabled ones. Panels store keys, not ids. */
export function categoryByKey(
  categories: readonly TicketCategoryDTO[],
  key: string,
): TicketCategoryDTO | null {
  return categories.find((c) => c.key === key) ?? null;
}

/**
 * Everything wrong with a proposed category, in one pass.
 *
 * Returned as a list rather than thrown one at a time so the panel can mark
 * every bad field at once instead of making the operator resubmit five times.
 */
export function validateCategory(input: TicketCategoryInput): readonly string[] {
  const problems: string[] = [];
  if (input.key.trim() === "") problems.push("key is required");
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(input.key)) {
    problems.push("key may only hold letters, numbers, dashes and underscores");
  }
  if (input.name.trim() === "") problems.push("name is required");
  if (input.description.length > CATEGORY_LIMITS.description) {
    problems.push(`description must be ${CATEGORY_LIMITS.description} characters or fewer`);
  }
  if (input.channelNameTemplate.trim() === "") problems.push("channel name template is required");
  if (input.memberLimit < 1) problems.push("member limit must be at least 1");
  if (input.totalLimit < 1) problems.push("total limit must be at least 1");
  if (input.totalLimit > CATEGORY_LIMITS.channelsPerParent) {
    // Not a preference: Discord refuses the 51st channel under a category, so a
    // higher limit would simply fail at creation time with a Discord error the
    // member would see instead of a setting the admin can fix.
    problems.push(`total limit cannot exceed ${CATEGORY_LIMITS.channelsPerParent}`);
  }
  if (input.questions.length > CATEGORY_LIMITS.questions) {
    problems.push(`a category may ask at most ${CATEGORY_LIMITS.questions} questions`);
  }
  const ids = new Set<string>();
  for (const q of input.questions) {
    if (q.id.trim() === "") problems.push("every question needs an id");
    if (ids.has(q.id)) problems.push(`duplicate question id "${q.id}"`);
    ids.add(q.id);
    if (q.label.trim() === "") problems.push("every question needs a label");
  }
  if (input.cooldownSeconds !== null && input.cooldownSeconds < 0) {
    problems.push("cooldown cannot be negative");
  }
  if (input.slowModeSeconds !== null && (input.slowModeSeconds < 0 || input.slowModeSeconds > 21600)) {
    problems.push("slow mode must be between 0 and 21600 seconds");
  }
  return problems;
}
