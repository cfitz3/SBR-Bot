/**
 * What a guild that has configured nothing gets.
 *
 * Kept here rather than in the repository so the values can be asserted in a
 * test without a database, and so the panel and the bot cannot disagree about
 * what "unset" means.
 */
import type { TicketSettingsDTO } from "@sbr/shared-types";

export function defaultSettings(guildId: string): TicketSettingsDTO {
  return {
    guildId,
    archiveEnabled: true,
    logChannelId: null,
    blocklistRoleIds: [],
    primaryColor: "INFO",
    successColor: "SUCCESS",
    errorColor: "DANGER",
    footer: null,
    // Null, not a number: a guild that has not decided how long silence means
    // "done" should not have tickets closing behind its back on our guess.
    staleAfterMinutes: null,
    autoCloseAfterMinutes: 720,
    closeButton: true,
    claimButton: true,
    // Empty means "always open". A guild with no stated hours should not be
    // telling members to come back tomorrow.
    workingHours: {},
    updatedAt: null,
  };
}
