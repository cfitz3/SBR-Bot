/**
 * Sticky messages: one note a guild wants to stay at the bottom of a channel.
 *
 * The rules channel that nobody scrolls up to, the "read this before asking"
 * line in a help channel. The message is reposted as the channel moves rather
 * than pinned, because a pin is one click away and the bottom of the channel is
 * where people are already looking.
 *
 * Pure, like the rest of this package: what a guild has configured, and when a
 * repost is due. Posting and deleting is the bridge bot's, because the message
 * has to be the member-facing bot's own — it is the bot that channel talks to.
 *
 * Tolerant on read, strict on write.
 */

/** One channel's sticky. */
export interface StickyMessage {
  readonly channelId: string;
  /** Plain text, sent as-is. Empty is not a sticky; it is a cleared one. */
  readonly content: string;
  /**
   * Off keeps the text without reposting it — a seasonal notice a guild will
   * want back is better switched off than retyped.
   */
  readonly enabled: boolean;
}

export interface StickyDoc {
  readonly stickies: readonly StickyMessage[];
}

export const STICKY_SETTING_KEY = "discord.sticky";

/** Nothing sticky. Installing the platform changes no channel. */
export const DEFAULT_STICKIES: StickyDoc = Object.freeze({ stickies: [] });

/** More channels than this is a server that has made every channel shout. */
export const MAX_STICKIES = 15;

/**
 * Shorter than Discord's 2,000 on purpose. A sticky is repeated forever; one
 * that fills a screen makes the channel unreadable, which is the opposite of
 * what it was added for.
 */
export const MAX_STICKY_CONTENT = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function parseSticky(raw: unknown): StickyMessage | null {
  if (!isRecord(raw)) return null;
  const channelId = str(raw["channelId"]);
  const content = str(raw["content"]);
  if (channelId === null || content === null) return null;
  return {
    channelId,
    content: content.slice(0, MAX_STICKY_CONTENT),
    // Absent reads as on: every stored sticky predating the flag was one a
    // guild wanted posted.
    enabled: raw["enabled"] !== false,
  };
}

/** Read the stored document, dropping only what cannot be understood. */
export function parseStickies(raw: unknown): StickyDoc {
  if (!isRecord(raw)) return DEFAULT_STICKIES;
  const list = Array.isArray(raw["stickies"]) ? raw["stickies"] : [];
  const seen = new Set<string>();
  const stickies: StickyMessage[] = [];
  for (const entry of list) {
    const sticky = parseSticky(entry);
    // One channel, one sticky: two would fight over the bottom of it.
    if (sticky === null || seen.has(sticky.channelId)) continue;
    seen.add(sticky.channelId);
    stickies.push(sticky);
  }
  return { stickies: stickies.slice(0, MAX_STICKIES) };
}

/** The strict half, for the panel: the first thing wrong with this blob, or null. */
export function validateStickies(raw: unknown): string | null {
  if (!isRecord(raw)) return "stickies must be an object";
  const list = raw["stickies"];
  if (!Array.isArray(list)) return "stickies must be a list";
  if (list.length > MAX_STICKIES) return `at most ${MAX_STICKIES} sticky messages`;
  const seen = new Set<string>();
  for (const [index, entry] of list.entries()) {
    const where = `sticky ${index + 1}`;
    if (!isRecord(entry)) return `${where} must be an object`;
    const channelId = str(entry["channelId"]);
    if (channelId === null) return `${where} needs a channel`;
    if (seen.has(channelId)) return `${where} is a second sticky for the same channel`;
    seen.add(channelId);
    const content = str(entry["content"]);
    if (content === null) return `${where} needs something to say`;
    if (content.length > MAX_STICKY_CONTENT) {
      return `${where}: message is over ${MAX_STICKY_CONTENT} characters`;
    }
    if (entry["enabled"] !== undefined && typeof entry["enabled"] !== "boolean") {
      return `${where}: enabled must be a boolean`;
    }
  }
  return null;
}

/** This channel's sticky, if it has one that is switched on. */
export function findSticky(doc: StickyDoc, channelId: string): StickyMessage | null {
  return doc.stickies.find((s) => s.channelId === channelId && s.enabled) ?? null;
}

/**
 * Set one channel's sticky, replacing whatever it had.
 *
 * Returns a new document; nothing here writes. The cap is enforced against
 * *new* channels only, so editing an existing sticky in a guild sitting on the
 * limit still works.
 */
export function upsertSticky(doc: StickyDoc, sticky: StickyMessage): StickyDoc | null {
  const rest = doc.stickies.filter((s) => s.channelId !== sticky.channelId);
  if (rest.length === doc.stickies.length && doc.stickies.length >= MAX_STICKIES) return null;
  return { stickies: [...rest, sticky] };
}

/** Drop one channel's sticky. Returns null when it had none, so callers can say so. */
export function removeSticky(doc: StickyDoc, channelId: string): StickyDoc | null {
  const rest = doc.stickies.filter((s) => s.channelId !== channelId);
  return rest.length === doc.stickies.length ? null : { stickies: rest };
}
