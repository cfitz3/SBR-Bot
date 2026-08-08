/**
 * Direction-aware relay formatting. Never spoofs an in-game identity: relayed
 * Discord users are tagged so in-game players can tell a bridged message apart.
 *
 * Both directions carry attacker-controlled text into a system that reads it as
 * more than text — Minecraft reads a leading `/` as a command and drops the
 * connection over a long line; Discord reads `@everyone` as a mass ping. The
 * defanging here is the first of two layers: the transport also passes
 * `allowedMentions: {parse: []}` on the Discord side, so a regex miss cannot
 * become a notification.
 */
import type { InboundMessage } from "./types.js";

/**
 * Minecraft 1.8 rejects chat above 256 characters and several server
 * implementations kick for it, which presents as an unexplained bridge
 * disconnect. Budget for the `/gc ` prefix the transport prepends.
 */
export const GAME_CHAT_LIMIT = 256;
const GAME_COMMAND_PREFIX_LEN = 4; // "/gc "

/** Discord messages cap at 2000; leave room for the transport's name prefix. */
export const DISCORD_MESSAGE_LIMIT = 1900;

/** Strip Minecraft section colour codes (§x). */
export function stripMinecraftColors(s: string): string {
  return s.replace(/§./g, "");
}

/**
 * Truncate on a character budget, marking the cut so a reader can tell a
 * clipped message from one that merely ended abruptly.
 */
export function truncate(s: string, limit: number): string {
  if (s.length <= limit) return s;
  return `${s.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/**
 * Neutralise Discord mention syntax. The zero-width space inside the token is
 * what breaks the parse; the text still reads correctly to a human. Covers the
 * mass pings and the id-based forms (`<@123>`, `<@&123>`), which the previous
 * `@everyone`-only pass let through — an in-game player could type a raw role
 * mention and ping a Discord role.
 */
export function defangMentions(s: string): string {
  return s
    .replace(/@(everyone|here)/gi, "@​$1")
    .replace(/<@(!|&)?(\d+)>/g, "<@​$1$2>");
}

/** Minimal Discord markdown/mention flattening for the in-game side. */
export function flattenForGame(s: string): string {
  return stripMinecraftColors(s)
    .replace(/[`*_~]/g, "")
    .replace(/@(everyone|here)/gi, "@​$1") // defang mass pings
    // Collapsing all whitespace is load-bearing, not cosmetic: it removes the
    // newlines that would otherwise let a Discord message close one chat line
    // and open another the server would read as a fresh command.
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Replace control characters with spaces. They have no legitimate use in
 * either chat system, and they are how a caller smuggles a line break past a
 * filter that only looked for "\n".
 */
function stripControlChars(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out;
}

export function formatRelay(msg: InboundMessage): string {
  if (msg.direction === "DISCORD_TO_GAME") {
    // Tag as coming from Discord; keep within a single guild-chat line. The
    // author name is flattened too — it is user-controlled (a Discord display
    // name) and would otherwise be the one unsanitised span in the line.
    const author = truncate(flattenForGame(stripControlChars(msg.authorName)), 32);
    const prefix = `[D] ${author}: `;
    const budget = GAME_CHAT_LIMIT - GAME_COMMAND_PREFIX_LEN - prefix.length;
    const body = flattenForGame(stripControlChars(msg.content));
    return `${prefix}${truncate(body, Math.max(0, budget))}`;
  }
  // GAME_TO_DISCORD: body only; the transport renders IGN + rank via webhook.
  const body = defangMentions(stripControlChars(stripMinecraftColors(msg.content))).trim();
  return truncate(body, DISCORD_MESSAGE_LIMIT);
}
