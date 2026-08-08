/**
 * discord.js-backed `CommandArgs`.
 *
 * Handlers never touch an interaction: they read options through the same
 * accessor the in-game parser implements, so one handler serves both surfaces.
 */
import type { CommandArgs } from "@sbr/shared-types";
import type { ChatInputCommandInteraction } from "discord.js";

export function interactionArgs(i: ChatInputCommandInteraction): CommandArgs {
  return {
    getString(name) {
      const value = i.options.getString(name);
      return value === null || value.trim() === "" ? null : value.trim();
    },
    getNumber(name) {
      // A spec may declare an option as `integer` or `number`; read whichever
      // Discord actually sent rather than making the caller know which.
      const value = i.options.get(name)?.value;
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    },
    getBoolean: (name) => i.options.getBoolean(name),
    getUser: (name) => i.options.getUser(name)?.id ?? null,
    getChannel: (name) => i.options.getChannel(name)?.id ?? null,
    // `getSubcommand(false)` returns null rather than throwing on commands that
    // have no subcommand group at all.
    subcommand: () => i.options.getSubcommand(false),
  };
}
