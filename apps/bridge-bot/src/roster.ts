/**
 * Parser for Hypixel's `/g online` reply.
 *
 * The response is a multi-line chat block, not an API payload, so this reads it
 * the way a player does — a header, rank sections, then the counts:
 *
 * ```
 * -----------------------------------------------------
 * Guild Name: SBR
 *
 * -- Guild Master --
 * Notch ●
 *
 * -- Officer --
 * Steve ●, [MVP+] Alex ●
 *
 * Total Members: 125
 * Online Members: 12
 * -----------------------------------------------------
 * ```
 *
 * Written tolerantly on purpose: Hypixel has changed the decoration around this
 * block more than once (the presence dot, the divider width, whether a rank
 * section is separated by a blank line), and a parser that insists on the exact
 * current shape breaks silently the day it changes — the command would report
 * an empty guild rather than an error. Anything unrecognised is skipped, and
 * the counts are taken from Hypixel's own lines rather than derived, so a
 * partially-read block still reports an honest headline.
 */
import { stripMinecraftColors } from "@sbr/bridge";
import type { GuildRosterDTO, RosterRankDTO } from "@sbr/shared-types";

/** `-- Officer --`, the header opening a rank section. */
const RANK_HEADER = /^-{2,}\s*(.+?)\s*-{2,}$/;

/** `Online Members: 12` — also the line that ends the useful part of the block. */
const ONLINE_COUNT = /^Online Members:\s*(\d+)/i;
const TOTAL_COUNT = /^Total Members:\s*(\d+)/i;
const GUILD_NAME = /^Guild Name:\s*(.+)$/i;

/** The `-------` rules Hypixel wraps the block in. */
const DIVIDER = /^-{5,}$/;

/** A Minecraft username, once rank tags and presence dots are stripped. */
const USERNAME = /^([A-Za-z0-9_]{1,16})\b/;

/**
 * True for the line that closes the block. The transport stops collecting here
 * rather than waiting out its timeout, so `/online` answers in the time the
 * chat actually took instead of a fixed window.
 */
export function isRosterEnd(line: string): boolean {
  return ONLINE_COUNT.test(stripMinecraftColors(line).trim());
}

/**
 * Pull the usernames out of one member line. Members are comma-separated and
 * may carry a Hypixel rank tag and a presence dot, neither of which is part of
 * the name: `[MVP+] Steve ●, Alex ●`.
 */
function parseMemberLine(line: string): string[] {
  const names: string[] = [];
  for (const chunk of line.split(",")) {
    const cleaned = chunk
      .replace(/\[[^\]]*\]/g, "") // rank tags
      .replace(/[●⏺•·*]/g, "") // presence dots, in whichever glyph is current
      .trim();
    const match = USERNAME.exec(cleaned);
    if (match) names.push(match[1]!);
  }
  return names;
}

/**
 * Read a collected `/g online` block. Returns null when the block contains
 * nothing recognisable — a timeout that captured unrelated chat, say — so the
 * caller can report "couldn't read it" rather than "nobody is online".
 */
export function parseGuildOnline(lines: readonly string[], now: () => Date = () => new Date()): GuildRosterDTO | null {
  let guildName: string | null = null;
  let online: number | null = null;
  let total: number | null = null;
  const ranks: { rank: string; members: string[] }[] = [];
  let current: { rank: string; members: string[] } | null = null;
  let recognised = false;

  for (const raw of lines) {
    const line = stripMinecraftColors(raw).replace(/\s+/g, " ").trim();
    if (line.length === 0 || DIVIDER.test(line)) continue;

    const name = GUILD_NAME.exec(line);
    if (name) {
      guildName = name[1]!.trim();
      recognised = true;
      // A guild name ends any section: the header precedes the ranks.
      current = null;
      continue;
    }

    const totals = TOTAL_COUNT.exec(line);
    if (totals) {
      total = Number(totals[1]);
      recognised = true;
      current = null;
      continue;
    }

    const onlines = ONLINE_COUNT.exec(line);
    if (onlines) {
      online = Number(onlines[1]);
      recognised = true;
      current = null;
      continue;
    }

    const header = RANK_HEADER.exec(line);
    if (header) {
      current = { rank: header[1]!.trim(), members: [] };
      ranks.push(current);
      recognised = true;
      continue;
    }

    // Anything else is only meaningful inside a rank section. Outside one it is
    // ordinary guild chat that happened to land in the capture window.
    if (current) current.members.push(...parseMemberLine(line));
  }

  if (!recognised) return null;

  return {
    guildName,
    // Sections Hypixel printed with nobody under them are noise in an embed.
    ranks: ranks.filter((r) => r.members.length > 0) as readonly RosterRankDTO[],
    online,
    total,
    fetchedAt: now().toISOString(),
  };
}

/** Everyone in the roster, flattened — for a count or a one-line summary. */
export function rosterMembers(roster: GuildRosterDTO): readonly string[] {
  return roster.ranks.flatMap((r) => r.members);
}
