/**
 * Parsers for Hypixel's guild join-request chat lines.
 *
 * When somebody runs `/g join Skyblock and Relax`, everyone with the invite
 * permission sees something like:
 *
 * ```
 * -----------------------------------------------------
 * [MVP+] Steve has requested to join the Guild!
 * Click here to accept or type /guild accept Steve!
 * -----------------------------------------------------
 * ```
 *
 * and a completed join looks like:
 *
 * ```
 * [MVP+] Steve joined the guild!
 * ```
 *
 * Written in the same tolerant spirit as the `/g online` parser: Hypixel has
 * changed the wording and the decoration around these lines before, and a
 * parser that insists on today's exact phrasing fails *silently* — the bot
 * simply stops screening anyone, which is the worst possible failure for a
 * gate. So each pattern matches on the distinctive verb phrase, tolerates rank
 * tags and colour codes, and anything unrecognised is ignored rather than
 * guessed at.
 *
 * Deliberately narrow in one respect: only lines that name a *specific* action
 * are matched. "Click here to accept" carries no new information and is
 * skipped, so a single request does not screen twice.
 */
import { stripMinecraftColors } from "@sbr/bridge";

export type GuildJoinEvent =
  /** Somebody asked to join and is waiting on an accept. */
  | { readonly kind: "REQUEST"; readonly ign: string }
  /** Somebody is now in the guild — accepted by us, by staff, or by invite. */
  | { readonly kind: "JOINED"; readonly ign: string };

/** A Minecraft username, once rank tags are stripped. */
const NAME = "([A-Za-z0-9_]{1,16})";

/**
 * `[MVP+] Steve has requested to join the Guild!`
 *
 * The article and capitalisation of "Guild" have both varied; the exclamation
 * mark is optional for the same reason.
 */
const REQUEST = new RegExp(`^${NAME} has requested to join the guild!?$`, "i");

/** `[MVP+] Steve joined the guild!` */
const JOINED = new RegExp(`^${NAME} joined the guild!?$`, "i");

/**
 * Strip colour codes and rank tags, and collapse whitespace.
 *
 * Rank tags are removed rather than captured: `[MVP+]`, `[YOUTUBE]` and the
 * guild-rank suffix are all bracketed, none of them is part of the name, and
 * the set of them changes whenever Hypixel adds a rank.
 */
function clean(line: string): string {
  return stripMinecraftColors(line)
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Read one chat line as a join event, or null when it is not one.
 *
 * Called on every `messagestr` line, so it stays cheap: two regexes against a
 * cleaned string, no allocation beyond that.
 */
export function parseJoinEvent(line: string): GuildJoinEvent | null {
  const text = clean(line);
  if (text.length === 0) return null;

  const request = REQUEST.exec(text);
  if (request) return { kind: "REQUEST", ign: request[1]! };

  const joined = JOINED.exec(text);
  if (joined) return { kind: "JOINED", ign: joined[1]! };

  return null;
}

/** The command that admits an applicant. */
export function acceptCommand(ign: string): string {
  return `/guild accept ${ign}`;
}
