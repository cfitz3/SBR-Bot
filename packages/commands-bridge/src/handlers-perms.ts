/**
 * `/perm` — standing parties (COMMANDS.md §9, PLATFORM_EXPANSION_PLAN.md §3).
 *
 * The command is one word now. Everything it used to take as an argument —
 * `action`, `perm`, `name`, `activity`, `ign`, `role`, `slot`, `notes` — is a
 * control on the console it opens, because every one of those options was a
 * chance to get an error instead of a party, and the platform already knew the
 * answer to most of them (`perm-console.ts` says why at length).
 *
 * The options are gone rather than deprecated: an option Discord still offers is
 * an option people still use, and two ways to do the same thing means two sets
 * of behaviour to keep in step. The console reaches every action the arguments
 * did, which is the bar for removing them.
 */
import { permConsole } from "./perm-console.js";
import type { CommandHandler, CommandSpec } from "./types.js";

/**
 * The console, addressed to the guild.
 *
 * No arguments at all, including no "which perm": picking one is the console's
 * first control, and an autocomplete that has to be typed at is a worse menu
 * than a menu.
 */
const perm: CommandHandler = async (ctx, deps) => permConsole(ctx.guildId, 0, deps);

export function permSpecs(): readonly CommandSpec[] {
  return [
    {
      name: "perm",
      description: "Standing parties — open the roster console",
      options: [],
      capability: "RUN_COMMAND",
      cooldownMs: 10_000,
      // Still reachable from guild chat, because a perm is a thing people
      // assemble in-game — but in chat it can only report, since a chat line
      // has no components to press. `"linked"`, as every attributed action is.
      inGame: "linked",
      handler: perm,
    },
  ];
}
