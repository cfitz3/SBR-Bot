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
 * **`Guild > Steve joined.` is not that line.** It is the login notice every
 * member produces every time they connect, and reading it as a guild join was a
 * shipped bug: the platform screened, logged and announced a "new member" for
 * an existing one, several times a day, per member. The two are told apart by
 * the `Guild >` prefix — Hypixel's presence notices carry it, and the join
 * broadcast does not.
 *
 * Written in the same tolerant spirit as the `/g online` parser: Hypixel has
 * changed the wording and the decoration around these lines before, and a
 * parser that insists on today's exact phrasing fails *silently* — the bot
 * simply stops screening anyone, which is the worst possible failure for a
 * gate. So each pattern matches on the distinctive verb phrase, tolerates rank
 * tags and colour codes, and anything unrecognised is ignored rather than
 * guessed at.
 *
 * **The patterns are unanchored at both ends, and that is the fix for the bug
 * this file shipped with.** Hypixel sends the whole framed block above as *one*
 * chat packet with embedded newlines, so a parser anchored with `^…$` against a
 * whitespace-collapsed packet matched nothing at all: no log line, no lookup,
 * no accept, for every request the guild ever received. The transport now
 * splits packets into lines before calling here, and these patterns would
 * survive the unsplit form too — two independent reasons the block has to
 * parse, because the failure is invisible when it returns.
 *
 * Deliberately narrow in two respects. Only lines naming a *specific* action
 * are matched — "Click here to accept" carries no new information and is
 * skipped, so a single request does not screen twice. And anything that is
 * somebody *talking* is refused outright: an unanchored search would otherwise
 * read a member typing "Steve has requested to join the guild!" in guild chat
 * as a request from Steve.
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
 * A character that may sit immediately before a username.
 *
 * Not `\b`: `_` is both a word character and a legal username character, so a
 * word boundary would happily start the capture mid-name and read `Steve_123`
 * as `123`. This says "either the start of the line, or something that cannot
 * be part of a name".
 */
const BEFORE = "(?:^|[^A-Za-z0-9_])";

/**
 * `[MVP+] Steve has requested to join the Guild!`
 *
 * The article and capitalisation of "Guild" have both varied, and the trailing
 * punctuation is not required — on the framed form the sentence is followed by
 * the "click here" line rather than by the end of the string.
 */
const REQUEST = new RegExp(`${BEFORE}${NAME} has requested to join the guild`, "i");

/**
 * `[MVP+] Steve joined the guild!`
 *
 * The words "the guild" are load-bearing, not decoration: without them this
 * also matches `Guild > Steve joined.`, which is a login. That is why the
 * pattern is not loosened to a bare "joined" however tempting the tolerance
 * elsewhere in this file makes it look.
 */
const JOINED_PLAIN = new RegExp(`${BEFORE}${NAME} joined the guild`, "i");

/**
 * A presence notice: `Guild > Steve joined.` / `Guild > Steve left.`
 *
 * Matched only so it can be *refused*. `CHAT_LINE` does not cover it — there is
 * no colon, because nobody is speaking — so without this the login notice falls
 * through to whichever pattern is loosest.
 */
const PRESENCE = new RegExp(`^guild *> *${NAME} (?:joined|left)[.!]?$`, "i");

/**
 * A line that is somebody speaking: `Guild > Steve: …`, `Officer > Alex: …`.
 *
 * Checked before anything else, because every pattern here is unanchored and
 * chat is arbitrary attacker-controlled text. The colon is what distinguishes
 * speech from Hypixel's own `Guild > Steve joined.` announcement.
 */
const CHAT_LINE = /^(?:guild|officer|party|co-op|from|to)\s*>?\s*[^:]{0,32}:/i;

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
 * Called on every `messagestr` line, so it stays cheap: a handful of regexes
 * against a cleaned string, no allocation beyond that.
 */
export function parseJoinEvent(line: string): GuildJoinEvent | null {
  const text = clean(line);
  if (text.length === 0) return null;
  if (CHAT_LINE.test(text)) return null;
  // Before anything else: a member logging in is not a member joining.
  if (PRESENCE.test(text)) return null;

  const request = REQUEST.exec(text);
  if (request) return { kind: "REQUEST", ign: request[1]! };

  const joined = JOINED_PLAIN.exec(text);
  if (joined) return { kind: "JOINED", ign: joined[1]! };

  return null;
}

/** The command that admits an applicant. */
export function acceptCommand(ign: string): string {
  return `/guild accept ${ign}`;
}

/** The command that refuses one. */
export function denyCommand(ign: string): string {
  return `/guild deny ${ign}`;
}

/**
 * The command that invites somebody who never asked.
 *
 * Separate from `acceptCommand` because the two are not interchangeable:
 * Hypixel refuses `accept` for a player with no pending request, and refuses
 * `invite` for one who has already asked. Staff pick by which situation they
 * are in, and the queue command reports which one applies.
 */
export function inviteCommand(ign: string): string {
  return `/guild invite ${ign}`;
}
