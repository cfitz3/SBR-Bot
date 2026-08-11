/**
 * Ticket types: what a member may open, and what they are told when they do.
 *
 * The five built-ins below are exactly the categories `/ticket` offered before
 * this existed, so a guild that configures nothing sees no change. A guild's
 * rows are layered over them by key rather than replacing them wholesale — the
 * same reasoning as milestone definitions: a default added later reaches every
 * guild, instead of only the ones set up after the change.
 *
 * No Discord, no Prisma. The merge is pure so it can be tested on its own.
 */
import type { TicketTypeDTO, TicketTypeInput } from "@sbr/shared-types";

/** A built-in type, before any guild has touched it. */
export interface DefaultTicketType {
  readonly key: string;
  readonly label: string;
  readonly emoji: string | null;
  readonly category: TicketTypeDTO["category"];
  readonly prompt: string | null;
  readonly position: number;
}

/**
 * The built-in menu.
 *
 * `key` is lowercase and the category uppercase on purpose: the key is what a
 * member types and what a guild's row joins on, the category is the enum the
 * ticket is recorded under. They happen to line up today, and they are still
 * separate fields — a guild may add three application types that all record as
 * APPLICATION.
 */
export const DEFAULT_TICKET_TYPES: readonly DefaultTicketType[] = [
  {
    key: "support",
    label: "Support",
    emoji: "🛟",
    category: "SUPPORT",
    prompt: "Tell us what you need help with, and anything you've already tried.",
    position: 0,
  },
  {
    key: "report",
    label: "Report a member",
    emoji: "🚩",
    category: "REPORT",
    prompt: "Who are you reporting, and what happened? Screenshots help.",
    position: 1,
  },
  {
    key: "appeal",
    label: "Appeal a punishment",
    emoji: "⚖️",
    category: "APPEAL",
    prompt: "Which punishment are you appealing, and why should it be lifted?",
    position: 2,
  },
  {
    key: "application",
    label: "Application",
    emoji: "📋",
    category: "APPLICATION",
    prompt: "What are you applying for? Include your IGN.",
    position: 3,
  },
  {
    key: "other",
    label: "Other",
    emoji: "💬",
    category: "OTHER",
    prompt: null,
    position: 4,
  },
];

/** A guild's stored row, as the repository hands it over. */
export interface StoredTicketType extends TicketTypeInput {
  readonly id: string;
}

function fromDefault(guildId: string, d: DefaultTicketType): TicketTypeDTO {
  return {
    id: null,
    guildId,
    key: d.key,
    label: d.label,
    emoji: d.emoji,
    category: d.category,
    parentChannelId: null,
    staffRoleIds: [],
    prompt: d.prompt,
    position: d.position,
    enabled: true,
    source: "DEFAULT",
  };
}

function fromStored(guildId: string, row: StoredTicketType): TicketTypeDTO {
  return {
    id: row.id,
    guildId,
    key: row.key,
    label: row.label,
    emoji: row.emoji,
    category: row.category,
    parentChannelId: row.parentChannelId,
    staffRoleIds: row.staffRoleIds,
    prompt: row.prompt,
    position: row.position,
    enabled: row.enabled,
    source: "GUILD",
  };
}

/**
 * Everything in effect for a guild, defaults included, in menu order.
 *
 * Disabled entries are kept and flagged rather than dropped: the panel has to
 * render the switch it can turn back on. Callers that build a member-facing
 * menu filter on `enabled` themselves — see `openableTicketTypes`.
 */
export function resolveTicketTypes(
  guildId: string,
  stored: readonly StoredTicketType[],
  defaults: readonly DefaultTicketType[] = DEFAULT_TICKET_TYPES,
): readonly TicketTypeDTO[] {
  const byKey = new Map(stored.map((r) => [r.key, r]));

  const out: TicketTypeDTO[] = [];
  for (const d of defaults) {
    const row = byKey.get(d.key);
    out.push(row === undefined ? fromDefault(guildId, d) : fromStored(guildId, row));
    byKey.delete(d.key);
  }
  // Whatever is left is a guild's own invention.
  for (const row of byKey.values()) out.push(fromStored(guildId, row));

  // Ties break on label rather than staying in insertion order, so a guild that
  // leaves every position at 0 still gets a stable, alphabetical menu.
  return out.sort((a, b) => a.position - b.position || a.label.localeCompare(b.label));
}

/** The menu a member actually sees. */
export function openableTicketTypes(types: readonly TicketTypeDTO[]): readonly TicketTypeDTO[] {
  return types.filter((t) => t.enabled);
}

/**
 * Match what the member asked for against the menu.
 *
 * Keys are compared case-insensitively, and a label is accepted too, because
 * autocomplete sends back whatever the client had — and a member who types
 * "Support" by hand should not be told it does not exist. A disabled type is
 * not matched: a guild that turned it off means it.
 */
export function findTicketType(
  types: readonly TicketTypeDTO[],
  wanted: string | null,
): TicketTypeDTO | null {
  const open = openableTicketTypes(types);
  if (open.length === 0) return null;
  if (wanted === null || wanted.trim() === "") return open[0] ?? null;

  const needle = wanted.trim().toLowerCase();
  return (
    open.find((t) => t.key.toLowerCase() === needle) ??
    open.find((t) => t.label.toLowerCase() === needle) ??
    null
  );
}
