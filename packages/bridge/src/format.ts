/**
 * Direction-aware relay formatting. Never spoofs an in-game identity: relayed
 * Discord users are tagged so in-game players can tell a bridged message apart.
 */
import type { InboundMessage } from "./types.js";

/** Strip Minecraft section colour codes (§x). */
export function stripMinecraftColors(s: string): string {
  return s.replace(/§./g, "");
}

/** Minimal Discord markdown/mention flattening for the in-game side. */
export function flattenForGame(s: string): string {
  return stripMinecraftColors(s)
    .replace(/[`*_~]/g, "")
    .replace(/@(everyone|here)/g, "@​$1") // defang mass pings
    .replace(/\s+/g, " ")
    .trim();
}

export function formatRelay(msg: InboundMessage): string {
  if (msg.direction === "DISCORD_TO_GAME") {
    // Tag as coming from Discord; keep within a single guild-chat line.
    return `[D] ${msg.authorName}: ${flattenForGame(msg.content)}`;
  }
  // GAME_TO_DISCORD: body only; the transport renders IGN + rank via webhook.
  return stripMinecraftColors(msg.content).trim();
}
