/**
 * User-facing rendering. Maps typed fallback states to honest messages and
 * formats networth respecting exact-vs-estimate and staleness.
 */
import type { HypixelFailureState, HypixelResult, LinkError, NetworthDTO } from "@sbr/shared-types";

export function formatCoins(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}b`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}m`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
}

export function renderFailure(state: HypixelFailureState): string {
  switch (state) {
    case "NOT_LINKED":
      return "You're not linked yet — use /link <ign>.";
    case "MISSING_PROFILE":
      return "No Skyblock profile found for that player.";
    case "RATE_LIMITED":
      return "Hypixel is rate-limiting us right now — try again in a moment.";
    case "API_DISABLED":
      return "That data is turned off in the player's Hypixel API settings.";
  }
}

export function renderLinkError(error: LinkError): string {
  switch (error.kind) {
    case "IGN_NOT_FOUND":
      return "That IGN doesn't exist.";
    case "SOCIAL_UNSET":
      return "Set your Discord in-game first (Hypixel → social menu), then run /link again.";
    case "SOCIAL_MISMATCH":
      return "Your Hypixel Discord link doesn't match your Discord account.";
    case "ALREADY_OWNED":
      return "That Minecraft account is already linked to another member.";
  }
}

export function renderNetworth(result: HypixelResult<NetworthDTO>): string {
  if (!result.ok) return renderFailure(result.error.state);

  const { data, freshness } = result.value;
  const stale = freshness === "STALE" ? " (cached)" : "";

  if (data.total === null) {
    return `Networth: unknown — data is hidden.${stale}`;
  }
  const qualifier = data.exact ? "" : " (est, some data hidden)";
  return `Networth: ${formatCoins(data.total)}${qualifier}${stale}`;
}
