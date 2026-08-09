/**
 * Rendering a screening for humans.
 *
 * Two audiences, one source of truth. Staff get the full picture in Discord;
 * the applicant, if anything is said to them in guild chat at all, gets a line
 * that does not read as an accusation and does not leak the guild's thresholds.
 *
 * Reason codes never reach either surface verbatim. `BELOW_CATACOMBS` is a
 * database value; "catacombs below the guild requirement" is a sentence.
 */
import { riskWeight } from "./policy.js";
import type { Screening, ScreeningReason } from "./types.js";

const SENTENCES: Readonly<Record<ScreeningReason, string>> = {
  SCAMMER_FLAGGED: "Listed on the SkyKings scammer database",
  SCAMMER_UNKNOWN: "Scammer database could not be reached — not cleared, just unchecked",
  PRIOR_EXPULSION: "Previously kicked or banned from this guild",
  PRIOR_DENIAL: "A previous join request was refused",
  REPEAT_ATTEMPTS: "Has asked to join several times recently",
  NEW_ACCOUNT: "Account is newer than the guild's minimum",
  INACTIVE: "Has not logged in for a long time",
  STATS_UNREADABLE: "Stats could not be read at all",
  API_DISABLED: "Some profile API settings are off, so parts of the stats are hidden",
  BELOW_SKYBLOCK_LEVEL: "Skyblock level below the guild requirement",
  BELOW_SKILL_AVERAGE: "Skill average below the guild requirement",
  BELOW_CATACOMBS: "Catacombs below the guild requirement",
  BELOW_WEIGHT: "Senither weight below the guild requirement",
  BELOW_NETWORTH: "Networth below the guild requirement",
  MEETS_REQUIREMENTS: "Meets every requirement checked",
};

export function reasonSentence(reason: ScreeningReason): string {
  return SENTENCES[reason];
}

/** Reasons as sentences, most serious first. */
export function reasonLines(reasons: readonly ScreeningReason[]): readonly string[] {
  return [...reasons].sort((a, b) => riskWeight(b) - riskWeight(a)).map(reasonSentence);
}

/** `4.5b`, `812m`, `43k`, `900`. Coins are read at a glance, not audited. */
export function formatCoins(coins: bigint | null): string {
  if (coins === null) return "unknown";
  const n = Number(coins);
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}b`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function stat(value: number | null, digits = 1): string {
  return value === null ? "unknown" : value.toFixed(digits);
}

/** The stat block, one line, for a Discord field or a log entry. */
export function statLine(screening: Screening): string {
  const s = screening.stats;
  return [
    `SB ${stat(s.skyblockLevel, 0)}`,
    `SA ${stat(s.skillAverage)}`,
    `Cata ${stat(s.catacombsLevel)}`,
    `Weight ${stat(s.senitherWeight, 0)}`,
    `NW ${formatCoins(s.networth)}`,
  ].join(" · ");
}

/**
 * The staff report. Plain text rather than an embed so the same string works in
 * a Discord message, a log line, and a test assertion; the caller wraps it.
 */
export function staffReport(screening: Screening): string {
  const lines: string[] = [];
  lines.push(`${screening.ign} — ${screening.verdict} (risk ${screening.riskScore}/100)`);
  lines.push(statLine(screening));
  if (screening.stats.currentGuild) lines.push(`Currently in: ${screening.stats.currentGuild}`);
  if (screening.discordId) lines.push(`Linked Discord: <@${screening.discordId}>`);
  if (screening.history.priorExpulsion && screening.history.expulsionReason) {
    lines.push(`Previous removal: ${screening.history.expulsionReason}`);
  }
  if (screening.scammer.status === "FLAGGED" && screening.scammer.reason) {
    lines.push(`Scammer listing: ${screening.scammer.reason}`);
  }
  for (const line of reasonLines(screening.reasons)) lines.push(`• ${line}`);
  if (screening.error) lines.push(`Screening had trouble: ${screening.error}`);
  return lines.join("\n");
}

/**
 * What can be said in guild chat, where everyone online can read it and the
 * applicant is one of them.
 *
 * Never names the scammer database, never quotes a threshold, never implies the
 * refusal is about the person. A wrong flag is a real possibility — SkyKings is
 * a third-party list — and being publicly called a scammer in front of a
 * hundred players is not a mistake that can be taken back. So the public line
 * says a human will look, and the detail goes to staff.
 */
export function chatLine(screening: Screening): string {
  switch (screening.verdict) {
    case "ACCEPT":
      return `Welcome, ${screening.ign}!`;
    case "REVIEW":
      return `Thanks ${screening.ign} — your request is with staff for a quick look.`;
    case "DENY":
      return `Sorry ${screening.ign}, we can't accept that request right now. Ask staff if you'd like it looked at.`;
  }
}
