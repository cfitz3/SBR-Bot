/**
 * Prisma reads for the bridge relay: wordlist entries and guild config.
 * `guildId` is the internal Guild.id.
 */
import { prisma } from "../client.js";

export type WordMatchType = "EXACT" | "SUBSTRING" | "REGEX" | "WILDCARD";
export type WordAction = "BLOCK" | "FLAG" | "REPLACE" | "SHADOW_MUTE";

export interface WordlistEntryRow {
  pattern: string;
  matchType: WordMatchType;
  action: WordAction;
  severity: number;
}

export const wordlistRepository = {
  async listEnabled(guildId: string): Promise<WordlistEntryRow[]> {
    const rows = await prisma.wordlistEntry.findMany({
      where: { guildId, enabled: true },
      select: { pattern: true, matchType: true, action: true, severity: true },
    });
    return rows.map((r) => ({
      pattern: r.pattern,
      matchType: r.matchType as WordMatchType,
      action: r.action as WordAction,
      severity: r.severity,
    }));
  },
};

export const guildConfigRepository = {
  async get(guildId: string): Promise<{ bridgeSuspended: boolean; bridgeChannelId: string | null } | null> {
    const cfg = await prisma.guildConfig.findUnique({
      where: { guildId },
      select: { bridgeSuspended: true, bridgeChannelId: true },
    });
    return cfg ? { bridgeSuspended: cfg.bridgeSuspended, bridgeChannelId: cfg.bridgeChannelId } : null;
  },
};
